import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { ACCOUNT_BYTES, TRADE_BYTES } from './format.ts';
import { loadDataset, parseArgs } from './load.ts';

// Converts accounts.bin into one JSON object per line. Same accounts, same
// trades, same order, so the idiomatic runner has to produce the same checksum.
const args = parseArgs(process.argv.slice(2));
const file = String(args.file ?? 'data/accounts.bin');
const out = String(args.out ?? 'data/accounts.jsonl');

const { header, view, index } = loadDataset(file);
const stream = createWriteStream(out);

for (let i = 0; i < index.length; i++) {
  const offset = index[i];
  const tradeCount = view.getUint32(offset + 12, true);
  const trades = new Array(tradeCount);
  let cursor = offset + ACCOUNT_BYTES;
  for (let t = 0; t < tradeCount; t++, cursor += TRADE_BYTES) {
    trades[t] = {
      pnl: view.getFloat64(cursor, true),
      ts: view.getUint32(cursor + 8, true),
      volume: view.getFloat32(cursor + 12, true),
    };
  }
  const line = `${JSON.stringify({
    id: view.getUint32(offset + 8, true),
    initialBalance: view.getFloat64(offset, true),
    trades,
  })}\n`;
  if (!stream.write(line)) await once(stream, 'drain');
}

stream.end();
await once(stream, 'finish');
console.log(JSON.stringify({ file: out, accounts: header.accounts, trades: header.trades }));
