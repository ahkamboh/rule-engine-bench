import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { parseArgs } from './load.ts';

const run = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const passes = String(args.passes ?? 5);
// vCPU-hour price used to turn CPU time into money. Roughly an AWS c7g on demand
// core. Change it for your own hardware, the CPU seconds figure is the portable one.
const rate = Number(args.rate ?? 0.036);
const rust = './rust/target/release/rule-engine-bench';

type Result = Record<string, unknown> & {
  engine: string;
  mode: string;
  threads: number;
  medianMs: number;
  accounts: number;
  scannedTrades: number;
  checksum: string;
};

const jobs: Array<{ label: string; cmd: string; argv: string[] }> = [
  { label: 'node idiomatic (JSON in, objects per trade)', cmd: 'node', argv: ['src/run-idiomatic.ts', `--passes=3`] },
  { label: 'node tuned (binary buffer, no allocation)', cmd: 'node', argv: ['src/run-single.ts', `--passes=${passes}`] },
  { label: 'node tuned + worker_threads', cmd: 'node', argv: ['src/run-workers.ts', `--passes=${passes}`] },
  { label: 'rust single thread', cmd: rust, argv: [`--mode=single`, `--passes=${passes}`] },
  { label: 'rust + rayon', cmd: rust, argv: [`--mode=rayon`, `--passes=${passes}`] },
];

const results: Array<Result & { label: string; peakRssBytes: number | null }> = [];

for (const job of jobs) {
  process.stderr.write(`running ${job.label}\n`);
  // /usr/bin/time reports peak RSS for the whole process, which is the number that
  // decides how many of these fit on one box. The runners' own reading misses
  // allocator overhead and, for the pool, the worker heaps.
  const { stdout, stderr } = await run('/usr/bin/time', ['-l', job.cmd, ...job.argv], {
    maxBuffer: 1 << 26,
  });
  const parsed = JSON.parse(stdout.trim()) as Result;
  results.push({ ...parsed, label: job.label, peakRssBytes: peakRss(stderr) });
}

// Two independent agreement checks. The checksum covers every verdict and final
// equity. The scanned trade count covers where each engine decided to stop, so a
// rule that fires one trade late still shows up even if the verdict matches.
const checksums = new Set(results.map((r) => r.checksum));
const scans = new Set(results.map((r) => r.scannedTrades));
const agree = checksums.size === 1 && scans.size === 1;

const machine = {
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: availableParallelism(),
  memoryBytes: totalmem(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};

await mkdir('results', { recursive: true });
await writeFile(
  'results/results.json',
  `${JSON.stringify({ machine, rateUsdPerVcpuHour: rate, agree, checksums: [...checksums], results }, null, 2)}\n`,
);
await writeFile('results/results.md', table(), 'utf8');

process.stdout.write(table());
if (!agree) {
  process.stderr.write(`\nengines disagree: ${[...checksums].join(' ')}\n`);
  process.exit(1);
}

function peakRss(stderr: string): number | null {
  const match = /(\d+)\s+maximum resident set size/.exec(stderr);
  return match ? Number(match[1]) : null;
}

function table(): string {
  const throughput = grid(
    ['engine', 'threads', 'wall', 'accounts/sec', 'trades/sec', 'CPU s per 1M', '$ per 1B', 'peak RSS'],
    results.map((r) => {
      const cpuSecPerMillion = ((r.medianMs / 1000) * r.threads * 1e6) / r.accounts;
      return [
        r.label,
        String(r.threads),
        `${r.medianMs.toFixed(1)} ms`,
        fmt(Number(r.accountsPerSec)),
        fmt(Number(r.tradesPerSec)),
        cpuSecPerMillion.toFixed(3),
        `$${(((cpuSecPerMillion * 1000) / 3600) * rate).toFixed(4)}`,
        r.peakRssBytes ? `${(r.peakRssBytes / 1024 / 1024).toFixed(0)} MB` : 'n/a',
      ];
    }),
  );

  // The idiomatic runner times one account at a time because that is its unit of
  // work. The tuned paths are too fast for a per account timer to be honest, so
  // they are sampled per 1000 accounts. The units are not comparable across those
  // two groups, only within them.
  const latency = grid(
    ['engine', 'unit', 'p50', 'p99'],
    results
      .filter((r) => r.batchP50Us != null || r.accountP50Us != null)
      .map((r) =>
        r.accountP50Us != null
          ? [r.label, '1 account', `${r.accountP50Us} us`, `${r.accountP99Us} us`]
          : [r.label, '1000 accounts', `${r.batchP50Us} us`, `${r.batchP99Us} us`],
      ),
  );

  const first = results[0];
  return [
    `${machine.cpu}, ${machine.cores} cores, node ${machine.node}`,
    `${fmt(first.accounts)} accounts, ${fmt(Number(first.trades))} trades stored, ${fmt(first.scannedTrades)} read before a verdict, median of ${passes} passes`,
    `cost assumes $${rate} per vCPU-hour`,
    '',
    ...throughput,
    '',
    ...latency,
    '',
    agree
      ? `all engines agree, checksum ${[...checksums][0]}, ${fmt(first.scannedTrades)} trades read`
      : `MISMATCH: checksums ${[...checksums].join(' ')}, scans ${[...scans].join(' ')}`,
    '',
  ].join('\n');
}

function grid(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(header), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.map(line)];
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
