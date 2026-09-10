import { readFileSync } from 'node:fs';
import { buildIndex, readHeader, type Header } from './format.ts';

export type Dataset = {
  header: Header;
  shared: SharedArrayBuffer;
  view: DataView;
  index: Uint32Array;
};

// Read into a SharedArrayBuffer so the worker pool can address the same bytes
// instead of each thread holding its own copy.
export function loadDataset(path: string): Dataset {
  const file = readFileSync(path);
  const shared = new SharedArrayBuffer(file.byteLength);
  new Uint8Array(shared).set(file);
  const view = new DataView(shared);
  const header = readHeader(view);
  return { header, shared, view, index: buildIndex(view, header.accounts) };
}

export function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) parsed[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = match[2];
  }
  return parsed;
}

export function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
