import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadDataset, median, parseArgs } from './load.ts';

const args = parseArgs(process.argv.slice(2));
const file = String(args.file ?? 'data/accounts.bin');
const passes = Number(args.passes ?? 5);
const threads = Number(args.threads ?? availableParallelism());
const chunk = Number(args.chunk ?? 2000);

const { header, shared, index } = loadDataset(file);

const indexBuffer = new SharedArrayBuffer(index.byteLength);
new Uint32Array(indexBuffer).set(index);
const cursorBuffer = new SharedArrayBuffer(4);
const cursor = new Int32Array(cursorBuffer);

const workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url));
const spawnStart = process.hrtime.bigint();
const pool = Array.from({ length: threads }, () =>
  new Worker(workerPath, {
    workerData: {
      data: shared,
      indexBuffer,
      cursorBuffer,
      accounts: header.accounts,
      chunk,
    },
  }),
);
await Promise.all(pool.map((w) => new Promise((r) => w.once('online', r))));
const spawnMs = Number(process.hrtime.bigint() - spawnStart) / 1e6;

const durations: number[] = [];
let checksum = 0;
let scanned = 0;

for (let pass = 0; pass < passes; pass++) {
  Atomics.store(cursor, 0, 0);
  const start = process.hrtime.bigint();
  const replies = await Promise.all(
    pool.map(
      (w) =>
        new Promise<{ sum: number; scanned: number }>((resolve) => {
          w.once('message', resolve);
          w.postMessage('go');
        }),
    ),
  );
  durations.push(Number(process.hrtime.bigint() - start) / 1e6);
  checksum = replies.reduce((total, r) => (total + r.sum) >>> 0, 0);
  scanned = replies.reduce((total, r) => total + r.scanned, 0);
}

const rss = process.memoryUsage().rss;
await Promise.all(pool.map((w) => w.terminate()));

const ms = median(durations);
console.log(
  JSON.stringify({
    engine: 'node',
    mode: 'workers',
    threads,
    accounts: header.accounts,
    trades: header.trades,
    scannedTrades: scanned,
    passesMs: durations.map((d) => Number(d.toFixed(2))),
    medianMs: Number(ms.toFixed(2)),
    accountsPerSec: Math.round((header.accounts / ms) * 1000),
    tradesPerSec: Math.round((scanned / ms) * 1000),
    chunk,
    poolSpawnMs: Number(spawnMs.toFixed(2)),
    rssBytes: rss,
    checksum: checksum.toString(16),
  }),
);
