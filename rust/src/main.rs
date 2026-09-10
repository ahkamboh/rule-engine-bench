use rayon::prelude::*;
use std::time::Instant;

const HEADER_BYTES: usize = 32;
const ACCOUNT_BYTES: usize = 16;
const TRADE_BYTES: usize = 16;
const SECONDS_PER_DAY: u32 = 86_400;

struct Rules {
    max_daily_loss_pct: f64,
    max_total_drawdown_pct: f64,
    profit_target_pct: f64,
    min_trading_days: u32,
    max_single_day_profit_share: f64,
}

const RULES: Rules = Rules {
    max_daily_loss_pct: 5.0,
    max_total_drawdown_pct: 10.0,
    profit_target_pct: 10.0,
    min_trading_days: 4,
    max_single_day_profit_share: 0.5,
};

const VERDICT_IN_PROGRESS: u8 = 0;
const VERDICT_PASS: u8 = 1;
const VERDICT_FAIL_DAILY_LOSS: u8 = 2;
const VERDICT_FAIL_DRAWDOWN: u8 = 3;

// One bounds check and one unaligned load each. Indexing the bytes individually
// costs eight checks per f64 and measurably slower, which is worth knowing before
// blaming a language for a number.
#[inline]
fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}

#[inline]
fn f64_at(data: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

// Same walk, same order of float operations as src/rules.ts, so equity comes out
// bit identical and the two engines can be compared by checksum. Returns the
// account hash and the number of trades actually read.
#[inline]
fn evaluate(data: &[u8], offset: usize) -> (u32, u32) {
    let initial = f64_at(data, offset);
    let id = u32_at(data, offset + 8);
    let trade_count = u32_at(data, offset + 12) as usize;

    let daily_loss_limit = initial * RULES.max_daily_loss_pct / 100.0;
    let drawdown_factor = RULES.max_total_drawdown_pct / 100.0;
    let target = initial * (1.0 + RULES.profit_target_pct / 100.0);

    let mut equity = initial;
    let mut peak = initial;
    let mut day_start_equity = initial;
    let mut current_day: i64 = -1;
    let mut trading_days: u32 = 0;
    let mut largest_day_profit = 0.0f64;
    let mut verdict = VERDICT_IN_PROGRESS;

    let trade_start = offset + ACCOUNT_BYTES;
    let mut cursor = trade_start;
    let end = cursor + trade_count * TRADE_BYTES;

    while cursor < end {
        let pnl = f64_at(data, cursor);
        let day = (u32_at(data, cursor + 8) / SECONDS_PER_DAY) as i64;

        if day != current_day {
            if current_day != -1 {
                let day_profit = equity - day_start_equity;
                if day_profit > largest_day_profit {
                    largest_day_profit = day_profit;
                }
                day_start_equity = equity;
            }
            current_day = day;
            trading_days += 1;
        }

        equity += pnl;
        if equity > peak {
            peak = equity;
        }

        if day_start_equity - equity > daily_loss_limit {
            verdict = VERDICT_FAIL_DAILY_LOSS;
            break;
        }
        if peak - equity > peak * drawdown_factor {
            verdict = VERDICT_FAIL_DRAWDOWN;
            break;
        }

        cursor += TRADE_BYTES;
    }

    // Derived rather than counted, matching src/rules.ts. A break leaves cursor on
    // the trade that caused it, which still got read.
    let mut scanned = ((cursor - trade_start) / TRADE_BYTES) as u32;

    if verdict == VERDICT_IN_PROGRESS {
        let last_day_profit = equity - day_start_equity;
        if last_day_profit > largest_day_profit {
            largest_day_profit = last_day_profit;
        }
        let total_profit = equity - initial;
        let consistent = total_profit <= 0.0
            || largest_day_profit <= total_profit * RULES.max_single_day_profit_share;
        if equity >= target && trading_days >= RULES.min_trading_days && consistent {
            verdict = VERDICT_PASS;
        }
    } else {
        scanned += 1;
    }

    (
        account_hash(id, verdict, (equity * 100.0).trunc() as i64 as i32),
        scanned,
    )
}

#[inline]
fn account_hash(id: u32, verdict: u8, cents: i32) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    h = mix(h, (id & 0xff) as u8);
    h = mix(h, ((id >> 8) & 0xff) as u8);
    h = mix(h, ((id >> 16) & 0xff) as u8);
    h = mix(h, ((id >> 24) & 0xff) as u8);
    h = mix(h, verdict);
    let c = cents as u32;
    h = mix(h, (c & 0xff) as u8);
    h = mix(h, ((c >> 8) & 0xff) as u8);
    h = mix(h, ((c >> 16) & 0xff) as u8);
    h = mix(h, ((c >> 24) & 0xff) as u8);
    h
}

#[inline]
fn mix(hash: u32, byte: u8) -> u32 {
    (hash ^ byte as u32).wrapping_mul(0x0100_0193)
}

fn build_index(data: &[u8], accounts: usize) -> Vec<u32> {
    let mut index = Vec::with_capacity(accounts);
    let mut offset = HEADER_BYTES;
    for _ in 0..accounts {
        index.push(offset as u32);
        offset += ACCOUNT_BYTES + u32_at(data, offset + 12) as usize * TRADE_BYTES;
    }
    index
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (p / 100.0) * (sorted.len() - 1) as f64;
    let low = rank.floor() as usize;
    let high = rank.ceil() as usize;
    if low == high {
        return sorted[low];
    }
    sorted[low] + (sorted[high] - sorted[low]) * (rank - low as f64)
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

fn arg(name: &str, fallback: &str) -> String {
    let prefix = format!("--{}=", name);
    std::env::args()
        .find(|a| a.starts_with(&prefix))
        .map(|a| a[prefix.len()..].to_string())
        .unwrap_or_else(|| fallback.to_string())
}

fn main() {
    let file = arg("file", "data/accounts.bin");
    let mode = arg("mode", "single");
    let passes: usize = arg("passes", "5").parse().unwrap();
    let chunk: usize = arg("chunk", "2000").parse().unwrap();
    let batch: usize = arg("batch", "1000").parse().unwrap();

    let data = std::fs::read(&file).expect("read data file");
    assert_eq!(&data[0..8], b"RULEBNCH", "not a rule-engine-bench data file");
    let accounts = u32_at(&data, 12) as usize;
    let trades = u32_at(&data, 16) as u64;
    let index = build_index(&data, accounts);

    let mut durations: Vec<f64> = Vec::with_capacity(passes);
    let mut batch_times: Vec<f64> = Vec::new();
    let mut checksum: u32 = 0;
    let mut scanned_trades: u64 = 0;

    for pass in 0..passes {
        let start = Instant::now();
        let (sum, scanned): (u32, u64) = if mode == "rayon" {
            index
                .par_chunks(chunk)
                .map(|slice| {
                    slice.iter().fold((0u32, 0u64), |acc, &off| {
                        let (hash, scanned) = evaluate(&data, off as usize);
                        (acc.0.wrapping_add(hash), acc.1 + scanned as u64)
                    })
                })
                .reduce(|| (0u32, 0u64), |a, b| (a.0.wrapping_add(b.0), a.1 + b.1))
        } else if pass == passes - 1 {
            let mut acc = (0u32, 0u64);
            let mut batch_start = Instant::now();
            for (i, &off) in index.iter().enumerate() {
                let (hash, scanned) = evaluate(&data, off as usize);
                acc = (acc.0.wrapping_add(hash), acc.1 + scanned as u64);
                if (i + 1) % batch == 0 {
                    batch_times.push(batch_start.elapsed().as_nanos() as f64 / 1000.0);
                    batch_start = Instant::now();
                }
            }
            acc
        } else {
            index.iter().fold((0u32, 0u64), |acc, &off| {
                let (hash, scanned) = evaluate(&data, off as usize);
                (acc.0.wrapping_add(hash), acc.1 + scanned as u64)
            })
        };
        durations.push(start.elapsed().as_nanos() as f64 / 1e6);
        checksum = sum;
        scanned_trades = scanned;
    }

    batch_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let ms = median(&durations);
    let threads = if mode == "rayon" {
        rayon::current_num_threads()
    } else {
        1
    };

    let passes_ms: Vec<String> = durations.iter().map(|d| format!("{:.2}", d)).collect();
    // Batch latency is only sampled on the single threaded path. Reporting zeros
    // for the rayon run would look like a measurement rather than a gap.
    let (p50, p99) = if batch_times.is_empty() {
        ("null".to_string(), "null".to_string())
    } else {
        (
            format!("{:.1}", percentile(&batch_times, 50.0)),
            format!("{:.1}", percentile(&batch_times, 99.0)),
        )
    };
    println!(
        concat!(
            "{{\"engine\":\"rust\",\"mode\":\"{}\",\"threads\":{},\"accounts\":{},",
            "\"trades\":{},\"scannedTrades\":{},\"passesMs\":[{}],\"medianMs\":{:.2},\"accountsPerSec\":{},",
            "\"tradesPerSec\":{},\"batchSize\":{},\"batchP50Us\":{},\"batchP99Us\":{},",
            "\"chunk\":{},\"checksum\":\"{:x}\"}}"
        ),
        mode,
        threads,
        accounts,
        trades,
        scanned_trades,
        passes_ms.join(","),
        ms,
        ((accounts as f64 / ms) * 1000.0).round() as u64,
        ((scanned_trades as f64 / ms) * 1000.0).round() as u64,
        batch,
        p50,
        p99,
        chunk,
        checksum
    );
}
