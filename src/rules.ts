import { ACCOUNT_BYTES, SECONDS_PER_DAY, TRADE_BYTES } from './format.ts';

export const VERDICT = {
  inProgress: 0,
  pass: 1,
  failDailyLoss: 2,
  failDrawdown: 3,
} as const;

export type Rules = {
  maxDailyLossPct: number;
  maxTotalDrawdownPct: number;
  profitTargetPct: number;
  minTradingDays: number;
  maxSingleDayProfitShare: number;
};

export const DEFAULT_RULES: Rules = {
  maxDailyLossPct: 5,
  maxTotalDrawdownPct: 10,
  profitTargetPct: 10,
  minTradingDays: 4,
  maxSingleDayProfitShare: 0.5,
};

export type Outcome = {
  id: number;
  verdict: number;
  equityCents: number;
  // Trades actually read. A breach stops the walk, so this is well below the
  // trade count stored in the file and it is the honest denominator for a
  // trades per second figure.
  scanned: number;
};

// Walks one account's trades in time order and returns the first rule breach, or
// pass once the target is met. The float operations happen in the same order as
// the Rust version so both engines produce bit identical equity.
export function evaluate(
  view: DataView,
  offset: number,
  rules: Rules,
  out: Outcome,
): void {
  const initial = view.getFloat64(offset, true);
  const id = view.getUint32(offset + 8, true);
  const tradeCount = view.getUint32(offset + 12, true);

  const dailyLossLimit = (initial * rules.maxDailyLossPct) / 100;
  const drawdownFactor = rules.maxTotalDrawdownPct / 100;
  const target = initial * (1 + rules.profitTargetPct / 100);

  let equity = initial;
  let peak = initial;
  let dayStartEquity = initial;
  let currentDay = -1;
  let tradingDays = 0;
  let largestDayProfit = 0;
  let verdict = VERDICT.inProgress;

  const tradeStart = offset + ACCOUNT_BYTES;
  let cursor = tradeStart;
  const end = cursor + tradeCount * TRADE_BYTES;

  for (; cursor < end; cursor += TRADE_BYTES) {
    const pnl = view.getFloat64(cursor, true);
    const day = (view.getUint32(cursor + 8, true) / SECONDS_PER_DAY) | 0;

    if (day !== currentDay) {
      if (currentDay !== -1) {
        const dayProfit = equity - dayStartEquity;
        if (dayProfit > largestDayProfit) largestDayProfit = dayProfit;
        dayStartEquity = equity;
      }
      currentDay = day;
      tradingDays++;
    }

    equity += pnl;
    if (equity > peak) peak = equity;

    if (dayStartEquity - equity > dailyLossLimit) {
      verdict = VERDICT.failDailyLoss;
      break;
    }
    if (peak - equity > peak * drawdownFactor) {
      verdict = VERDICT.failDrawdown;
      break;
    }
  }

  // Derived rather than counted, so the loop above stays free of a counter. A
  // break leaves cursor on the trade that caused it, which still got read.
  let scanned = (cursor - tradeStart) / TRADE_BYTES;

  if (verdict === VERDICT.inProgress) {
    const lastDayProfit = equity - dayStartEquity;
    if (lastDayProfit > largestDayProfit) largestDayProfit = lastDayProfit;
    const totalProfit = equity - initial;
    const consistent =
      totalProfit <= 0 ||
      largestDayProfit <= totalProfit * rules.maxSingleDayProfitShare;
    if (equity >= target && tradingDays >= rules.minTradingDays && consistent) {
      verdict = VERDICT.pass;
    }
  } else {
    scanned += 1;
  }

  out.id = id;
  out.verdict = verdict;
  out.equityCents = Math.trunc(equity * 100);
  out.scanned = scanned;
}

// Same walk again, reading through typed arrays instead of a DataView. Every
// record in the file is 8 byte aligned, so the buffer can be viewed directly as
// Float64Array and Uint32Array, which skips a method call per field. Typed array
// reads use native byte order, so this path is only correct on a little endian
// machine, which is what the caller checks before choosing it.
export function evaluateTyped(
  f64: Float64Array,
  u32: Uint32Array,
  offset: number,
  rules: Rules,
  out: Outcome,
): void {
  const initial = f64[offset >>> 3];
  const id = u32[(offset >>> 2) + 2];
  const tradeCount = u32[(offset >>> 2) + 3];

  const dailyLossLimit = (initial * rules.maxDailyLossPct) / 100;
  const drawdownFactor = rules.maxTotalDrawdownPct / 100;
  const target = initial * (1 + rules.profitTargetPct / 100);

  let equity = initial;
  let peak = initial;
  let dayStartEquity = initial;
  let currentDay = -1;
  let tradingDays = 0;
  let largestDayProfit = 0;
  let verdict = VERDICT.inProgress;

  let pnlIndex = (offset + ACCOUNT_BYTES) >>> 3;
  let tsIndex = ((offset + ACCOUNT_BYTES) >>> 2) + 2;
  let t = 0;

  for (; t < tradeCount; t++, pnlIndex += 2, tsIndex += 4) {
    const pnl = f64[pnlIndex];
    const day = (u32[tsIndex] / SECONDS_PER_DAY) | 0;

    if (day !== currentDay) {
      if (currentDay !== -1) {
        const dayProfit = equity - dayStartEquity;
        if (dayProfit > largestDayProfit) largestDayProfit = dayProfit;
        dayStartEquity = equity;
      }
      currentDay = day;
      tradingDays++;
    }

    equity += pnl;
    if (equity > peak) peak = equity;

    if (dayStartEquity - equity > dailyLossLimit) {
      verdict = VERDICT.failDailyLoss;
      break;
    }
    if (peak - equity > peak * drawdownFactor) {
      verdict = VERDICT.failDrawdown;
      break;
    }
  }

  if (verdict === VERDICT.inProgress) {
    const lastDayProfit = equity - dayStartEquity;
    if (lastDayProfit > largestDayProfit) largestDayProfit = lastDayProfit;
    const totalProfit = equity - initial;
    const consistent =
      totalProfit <= 0 ||
      largestDayProfit <= totalProfit * rules.maxSingleDayProfitShare;
    if (equity >= target && tradingDays >= rules.minTradingDays && consistent) {
      verdict = VERDICT.pass;
    }
  }

  out.id = id;
  out.verdict = verdict;
  out.equityCents = Math.trunc(equity * 100);
  out.scanned = verdict === VERDICT.inProgress || verdict === VERDICT.pass ? t : t + 1;
}

export const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// FNV-1a over (id, verdict, equityCents), folded to 32 bits so JavaScript and
// Rust agree without BigInt. Engines add these per account and report the sum,
// which stays the same however the work is scheduled across threads. Any
// divergence in the rule logic changes the total.
export function accountHash(out: Outcome): number {
  let h = 0x811c9dc5;
  h = mix(h, out.id & 0xff);
  h = mix(h, (out.id >>> 8) & 0xff);
  h = mix(h, (out.id >>> 16) & 0xff);
  h = mix(h, (out.id >>> 24) & 0xff);
  h = mix(h, out.verdict & 0xff);
  const cents = out.equityCents | 0;
  h = mix(h, cents & 0xff);
  h = mix(h, (cents >>> 8) & 0xff);
  h = mix(h, (cents >>> 16) & 0xff);
  h = mix(h, (cents >>> 24) & 0xff);
  return h;
}

function mix(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, 0x01000193) >>> 0;
}
