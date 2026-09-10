import { SECONDS_PER_DAY } from './format.ts';
import { VERDICT, type Outcome, type Rules } from './rules.ts';

export type Trade = { pnl: number; ts: number; volume: number };
export type Account = { id: number; initialBalance: number; trades: Trade[] };

// The same rules over parsed objects instead of a binary buffer, and returning a
// fresh result object per account. This is what the first version of a service
// looks like when the input is JSON off a queue. The arithmetic is identical to
// src/rules.ts, so it must produce the same checksum.
export function evaluateAccount(account: Account, rules: Rules): Outcome {
  const initial = account.initialBalance;
  const dailyLossLimit = (initial * rules.maxDailyLossPct) / 100;
  const drawdownFactor = rules.maxTotalDrawdownPct / 100;
  const target = initial * (1 + rules.profitTargetPct / 100);

  let equity = initial;
  let peak = initial;
  let dayStartEquity = initial;
  let currentDay = -1;
  let tradingDays = 0;
  let largestDayProfit = 0;
  let verdict: number = VERDICT.inProgress;
  let t = 0;

  for (; t < account.trades.length; t++) {
    const trade = account.trades[t];
    const day = (trade.ts / SECONDS_PER_DAY) | 0;

    if (day !== currentDay) {
      if (currentDay !== -1) {
        const dayProfit = equity - dayStartEquity;
        if (dayProfit > largestDayProfit) largestDayProfit = dayProfit;
        dayStartEquity = equity;
      }
      currentDay = day;
      tradingDays++;
    }

    equity += trade.pnl;
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

  return {
    id: account.id,
    verdict,
    equityCents: Math.trunc(equity * 100),
    scanned: verdict === VERDICT.inProgress || verdict === VERDICT.pass ? t : t + 1,
  };
}
