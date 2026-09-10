import { loadDataset, median, parseArgs, percentile } from './load.ts';
import {
  DEFAULT_RULES,
  LITTLE_ENDIAN,
  accountHash,
  evaluate,
  evaluateTyped,
  type Outcome,
} from './rules.ts';

const args = parseArgs(process.argv.slice(2));
const file = String(args.file ?? 'data/accounts.bin');
const passes = Number(args.passes ?? 5);
const batchSize = Number(args.batch ?? 1000);
// DataView wins by about 6% here, so it is the default. The typed array reader is
// kept because it is the usual advice and it is worth being able to show that it
// does not help once V8 has specialised the DataView calls.
const reader = String(args.reader ?? 'dataview');

if (reader === 'typed' && !LITTLE_ENDIAN) {
  throw new Error('the typed array reader needs a little endian machine');
}

const { header, shared, view, index } = loadDataset(file);
const f64 = new Float64Array(shared);
const u32 = new Uint32Array(shared);

const out: Outcome = { id: 0, verdict: 0, equityCents: 0, scanned: 0 };
const durations: number[] = [];
const batchCount = Math.floor(header.accounts / batchSize);
const batches = new Float64Array(Math.max(1, batchCount));
let checksum = 0;
let scanned = 0;
const verdicts = new Uint32Array(4);

for (let pass = 0; pass < passes; pass++) {
  // Sampled on the last pass so the numbers are warm. On the first pass the JIT
  // is still tiering up and every tail figure is warmup, not steady state.
  const measureBatches = pass === passes - 1;
  let sum = 0;
  let scannedPass = 0;
  let batch = 0;
  let batchStart = process.hrtime.bigint();
  const start = batchStart;

  for (let i = 0; i < index.length; i++) {
    if (reader === 'typed') {
      evaluateTyped(f64, u32, index[i], DEFAULT_RULES, out);
    } else {
      evaluate(view, index[i], DEFAULT_RULES, out);
    }
    sum = (sum + accountHash(out)) >>> 0;
    scannedPass += out.scanned;
    if (pass === passes - 1) verdicts[out.verdict]++;

    if (measureBatches && (i + 1) % batchSize === 0 && batch < batches.length) {
      const now = process.hrtime.bigint();
      batches[batch++] = Number(now - batchStart) / 1000;
      batchStart = now;
    }
  }

  durations.push(Number(process.hrtime.bigint() - start) / 1e6);
  checksum = sum;
  scanned = scannedPass;
}

const sortedBatches = batches.slice(0, Math.max(1, batchCount));
sortedBatches.sort();
const ms = median(durations);

console.log(
  JSON.stringify({
    engine: 'node',
    mode: 'single',
    reader,
    threads: 1,
    accounts: header.accounts,
    trades: header.trades,
    scannedTrades: scanned,
    passesMs: durations.map((d) => Number(d.toFixed(2))),
    medianMs: Number(ms.toFixed(2)),
    accountsPerSec: Math.round((header.accounts / ms) * 1000),
    tradesPerSec: Math.round((scanned / ms) * 1000),
    batchSize,
    batchP50Us: Number(percentile(sortedBatches, 50).toFixed(1)),
    batchP99Us: Number(percentile(sortedBatches, 99).toFixed(1)),
    rssBytes: process.memoryUsage().rss,
    verdicts: {
      inProgress: verdicts[0],
      pass: verdicts[1],
      failDailyLoss: verdicts[2],
      failDrawdown: verdicts[3],
    },
    checksum: checksum.toString(16),
  }),
);
