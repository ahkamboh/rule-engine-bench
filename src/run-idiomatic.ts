import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { PerformanceObserver } from 'node:perf_hooks';
import { median, parseArgs, percentile } from './load.ts';
import { DEFAULT_RULES, accountHash } from './rules.ts';
import { evaluateAccount, type Account } from './rules-objects.ts';

const args = parseArgs(process.argv.slice(2));
const file = String(args.file ?? 'data/accounts.jsonl');
const passes = Number(args.passes ?? 3);

let gcCount = 0;
let gcTotalMs = 0;
let gcMaxMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount++;
    gcTotalMs += entry.duration;
    if (entry.duration > gcMaxMs) gcMaxMs = entry.duration;
  }
});
observer.observe({ entryTypes: ['gc'] });

const totals: number[] = [];
const parseTotals: number[] = [];
const evalTotals: number[] = [];
let latencies = new Float64Array(0);
let accounts = 0;
let trades = 0;
let scannedTrades = 0;
let checksum = 0;
let peakRss = 0;

for (let pass = 0; pass < passes; pass++) {
  const perAccount: number[] = [];
  let parseNs = 0n;
  let evalNs = 0n;
  let sum = 0;
  let count = 0;
  let tradeCount = 0;
  let scanned = 0;

  const start = process.hrtime.bigint();
  const reader = createInterface({
    input: createReadStream(file, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.length === 0) continue;
    const accountStart = process.hrtime.bigint();
    const account = JSON.parse(line) as Account;
    const parsed = process.hrtime.bigint();
    const outcome = evaluateAccount(account, DEFAULT_RULES);
    const done = process.hrtime.bigint();

    sum = (sum + accountHash(outcome)) >>> 0;
    scanned += outcome.scanned;
    parseNs += parsed - accountStart;
    evalNs += done - parsed;
    perAccount.push(Number(done - accountStart) / 1000);
    tradeCount += account.trades.length;
    count++;

    if (count % 5000 === 0) {
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    }
  }

  totals.push(Number(process.hrtime.bigint() - start) / 1e6);
  parseTotals.push(Number(parseNs) / 1e6);
  evalTotals.push(Number(evalNs) / 1e6);
  accounts = count;
  trades = tradeCount;
  scannedTrades = scanned;
  checksum = sum;
  // Last pass, for the same warmup reason as src/run-single.ts.
  if (pass === passes - 1) latencies = Float64Array.from(perAccount).sort();
}

observer.disconnect();

const ms = median(totals);
const evalMs = median(evalTotals);

console.log(
  JSON.stringify({
    engine: 'node',
    mode: 'idiomatic',
    threads: 1,
    accounts,
    trades,
    scannedTrades,
    passesMs: totals.map((d) => Number(d.toFixed(2))),
    medianMs: Number(ms.toFixed(2)),
    parseMs: Number(median(parseTotals).toFixed(2)),
    evalMs: Number(evalMs.toFixed(2)),
    accountsPerSec: Math.round((accounts / ms) * 1000),
    tradesPerSec: Math.round((scannedTrades / ms) * 1000),
    evalOnlyAccountsPerSec: Math.round((accounts / evalMs) * 1000),
    accountP50Us: Number(percentile(latencies, 50).toFixed(1)),
    accountP99Us: Number(percentile(latencies, 99).toFixed(1)),
    accountP999Us: Number(percentile(latencies, 99.9).toFixed(1)),
    gcCount,
    gcTotalMs: Number(gcTotalMs.toFixed(1)),
    gcMaxPauseMs: Number(gcMaxMs.toFixed(2)),
    rssBytes: peakRss,
    checksum: checksum.toString(16),
  }),
);
