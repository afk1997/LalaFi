/**
 * Terminal I/O. Prompts and warnings go to stderr so stdout stays machine-readable.
 * Secrets are read with echo off and never printed or logged.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { formatUnits, parseUnits } from 'viem';
import { USDC_DECIMALS, type Finding } from '@xpool/sdk';

export class CliError extends Error {
  override name = 'CliError';
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export function out(msg = ''): void {
  process.stdout.write(`${msg}\n`);
}

export function info(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`warning: ${msg}\n`);
}

async function readLine(question: string, hidden: boolean): Promise<string> {
  process.stderr.write(question);
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: hidden ? sink : process.stderr, terminal: hidden && process.stdin.isTTY === true });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('line', (l) => resolve(l));
      rl.once('close', () => reject(new CliError('input closed')));
    });
  } finally {
    rl.removeAllListeners('close');
    rl.close();
    if (hidden) process.stderr.write('\n');
  }
}

export function prompt(question: string): Promise<string> {
  return readLine(question, false);
}

export function promptSecret(question: string): Promise<string> {
  return readLine(question, true);
}

/** Wallet password: XPOOL_PASSWORD (automation) or an echo-off prompt. */
export async function getPassword(confirm = false): Promise<string> {
  const env = process.env.XPOOL_PASSWORD;
  if (env) return env;
  const p = await promptSecret('Wallet password: ');
  if (p.length < 8) throw new CliError('password must be at least 8 characters');
  if (confirm && (await promptSecret('Repeat password: ')) !== p) throw new CliError('passwords do not match');
  return p;
}

export async function confirmYes(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  const a = (await prompt(`${question} [y/N] `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

export function parseUsdc(s: string): bigint {
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(s)) throw new CliError(`invalid USDC amount "${s}" (up to 6 decimals)`);
  const v = parseUnits(s, USDC_DECIMALS);
  if (v <= 0n) throw new CliError('amount must be > 0');
  return v;
}

export function fmtUsdc(v: bigint): string {
  return `${formatUnits(v, USDC_DECIMALS)} USDC`;
}

/** Print privacy findings; returns true if any blocks. */
export function printFindings(findings: readonly Finding[]): boolean {
  let blocked = false;
  for (const f of findings) {
    const tag = f.level === 'block' ? 'BLOCKED' : f.level === 'warn' ? 'WARNING' : 'note';
    info(`[${f.rule} ${tag}] ${f.message}${f.level === 'block' && f.overrideFlag ? ` (override: ${f.overrideFlag})` : ''}`);
    if (f.level === 'block') blocked = true;
  }
  return blocked;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
