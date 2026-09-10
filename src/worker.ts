import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_RULES, accountHash, evaluate, type Outcome } from './rules.ts';

const { data, indexBuffer, cursorBuffer, accounts, chunk } = workerData;
const view = new DataView(data);
const index = new Uint32Array(indexBuffer);
const cursor = new Int32Array(cursorBuffer);
const out: Outcome = { id: 0, verdict: 0, equityCents: 0, scanned: 0 };

// Chunks are claimed with an atomic counter rather than handed out up front.
// Trade counts vary per account, so a fixed split would leave threads idle while
// one of them finishes a heavy range. This matches what rayon does by stealing.
parentPort?.on('message', () => {
  let sum = 0;
  let scanned = 0;
  for (;;) {
    const claimed = Atomics.add(cursor, 0, 1);
    const from = claimed * chunk;
    if (from >= accounts) break;
    const to = Math.min(from + chunk, accounts);
    for (let i = from; i < to; i++) {
      evaluate(view, index[i], DEFAULT_RULES, out);
      sum = (sum + accountHash(out)) >>> 0;
      scanned += out.scanned;
    }
  }
  parentPort?.postMessage({ sum, scanned });
});
