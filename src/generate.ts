import { open } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ACCOUNT_BYTES,
  EPOCH,
  HEADER_BYTES,
  SECONDS_PER_DAY,
  TRADE_BYTES,
  VERSION,
  writeHeader,
} from './format.ts';

const args = parseArgs(process.argv.slice(2));
const accounts = Number(args.accounts ?? 100_000);
const avgTrades = Number(args.avgTrades ?? 60);
const seed = Number(args.seed ?? 42);
const out = String(args.out ?? 'data/accounts.bin');

// pcg32, so the same seed gives the same file on any machine.
let state = BigInt(seed) * 6364136223846793005n + 1442695040888963407n;
function nextU32(): number {
  state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  const xorshifted = Number(((state >> 18n) ^ state) >> 27n & 0xffffffffn);
  const rot = Number((state >> 59n) & 31n);
  return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
}
function nextFloat(): number {
  return nextU32() / 4294967296;
}
function nextNormal(): number {
  const u = Math.max(nextFloat(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * nextFloat());
}

await mkdir(dirname(out), { recursive: true });
const handle = await open(out, 'w');

const header = Buffer.alloc(HEADER_BYTES);
await handle.write(header, 0, HEADER_BYTES, 0);

const CHUNK = 1 << 20;
let buffer = Buffer.alloc(CHUNK);
let filled = 0;
let position = HEADER_BYTES;
let totalTrades = 0;

async function flush(): Promise<void> {
  if (filled === 0) return;
  await handle.write(buffer, 0, filled, position);
  position += filled;
  filled = 0;
}

async function reserve(bytes: number): Promise<void> {
  if (filled + bytes > buffer.length) await flush();
}

for (let i = 0; i < accounts; i++) {
  // Trade counts spread around avgTrades so some accounts are much heavier than
  // others, which is what makes a fixed size batch a bad unit of work.
  const spread = 0.4 + nextFloat() * 1.6;
  const tradeCount = Math.max(5, Math.round(avgTrades * spread));
  const initialBalance = [10_000, 25_000, 50_000, 100_000, 200_000][nextU32() % 5];

  await reserve(ACCOUNT_BYTES + tradeCount * TRADE_BYTES);
  buffer.writeDoubleLE(initialBalance, filled);
  buffer.writeUInt32LE(i, filled + 8);
  buffer.writeUInt32LE(tradeCount, filled + 12);
  filled += ACCOUNT_BYTES;

  // Slight negative edge with fat tails, a few trades per day, spread over about
  // three months. Roughly a third of accounts breach, a small share pass.
  const edge = -0.02 + nextNormal() * 0.06;
  const volatility = 0.004 + nextFloat() * 0.02;
  let ts = Math.floor(nextFloat() * 30) * SECONDS_PER_DAY;

  for (let t = 0; t < tradeCount; t++) {
    ts += 900 + (nextU32() % 24000);
    const pnl = initialBalance * (edge * volatility + nextNormal() * volatility);
    buffer.writeDoubleLE(pnl, filled);
    buffer.writeUInt32LE(ts, filled + 8);
    buffer.writeFloatLE(0.1 + (nextU32() % 400) / 100, filled + 12);
    filled += TRADE_BYTES;
  }

  totalTrades += tradeCount;
}

await flush();

writeHeader(new DataView(header.buffer, header.byteOffset, HEADER_BYTES), {
  version: VERSION,
  accounts,
  trades: totalTrades,
  seed,
  epoch: EPOCH,
});
await handle.write(header, 0, HEADER_BYTES, 0);
await handle.close();

console.log(
  JSON.stringify({
    file: out,
    accounts,
    trades: totalTrades,
    bytes: position,
    seed,
  }),
);

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) parsed[camel(match[1])] = match[2];
  }
  return parsed;
}

function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
