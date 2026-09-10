// Binary layout of data/accounts.bin. Little endian throughout.
//
// header, 32 bytes
//   0  magic       8 bytes, "RULEBNCH"
//   8  version     u32
//  12  accounts    u32
//  16  trades      u32  (total across all accounts)
//  20  seed        u32
//  24  epoch       u32  (unix seconds that trade timestamps are relative to)
//  28  padding     u32
//
// per account, 16 bytes, then tradeCount trade records
//   0  initialBalance  f64
//   8  id              u32
//  12  tradeCount      u32
//
// per trade, 16 bytes
//   0  pnl     f64
//   8  ts      u32  (seconds since header.epoch)
//  12  volume  f32
//
// Trades are written in ascending ts order, so no engine sorts. Every record is
// 8 byte aligned, which lets the Rust side read without copying.

export const MAGIC = 'RULEBNCH';
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const ACCOUNT_BYTES = 16;
export const TRADE_BYTES = 16;
export const EPOCH = 1577836800; // 2020-01-01T00:00:00Z
export const SECONDS_PER_DAY = 86400;

export type Header = {
  version: number;
  accounts: number;
  trades: number;
  seed: number;
  epoch: number;
};

export function readHeader(view: DataView): Header {
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(i) !== MAGIC.charCodeAt(i)) {
      throw new Error('not a rule-engine-bench data file');
    }
  }
  const version = view.getUint32(8, true);
  if (version !== VERSION) {
    throw new Error(`unsupported data version ${version}`);
  }
  return {
    version,
    accounts: view.getUint32(12, true),
    trades: view.getUint32(16, true),
    seed: view.getUint32(20, true),
    epoch: view.getUint32(24, true),
  };
}

export function writeHeader(view: DataView, header: Header): void {
  for (let i = 0; i < MAGIC.length; i++) {
    view.setUint8(i, MAGIC.charCodeAt(i));
  }
  view.setUint32(8, header.version, true);
  view.setUint32(12, header.accounts, true);
  view.setUint32(16, header.trades, true);
  view.setUint32(20, header.seed, true);
  view.setUint32(24, header.epoch, true);
  view.setUint32(28, 0, true);
}

// Byte offset of every account record. Variable length records mean one scan is
// needed before work can be split across threads.
export function buildIndex(view: DataView, accounts: number): Uint32Array {
  const index = new Uint32Array(accounts);
  let offset = HEADER_BYTES;
  for (let i = 0; i < accounts; i++) {
    index[i] = offset;
    offset += ACCOUNT_BYTES + view.getUint32(offset + 12, true) * TRADE_BYTES;
  }
  return index;
}
