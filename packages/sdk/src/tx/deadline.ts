/**
 * W10: random deadline inside a window, and a random submission delay (CSPRNG).
 */
import { randomInt } from '../crypto/random.js';

export interface DeadlineOptions {
  /** Minimum seconds from now (default 20 min). */
  minSeconds?: number;
  /** Uniform jitter added on top (default 40 min). */
  jitterSeconds?: number;
  nowSec?: number;
}

export function jitteredDeadline(opts: DeadlineOptions = {}): bigint {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const min = opts.minSeconds ?? 20 * 60;
  const jitter = opts.jitterSeconds ?? 40 * 60;
  if (min < 60 || jitter < 0) throw new RangeError('deadline window too small');
  return BigInt(now + min + (jitter > 0 ? randomInt(jitter + 1) : 0));
}

/** Random delay in [minMs, maxMs] before handing a proof to the relayer. */
export function randomSubmissionDelayMs(maxMs: number, minMs = 0): number {
  if (maxMs < minMs || minMs < 0) throw new RangeError('bad delay bounds');
  return minMs + randomInt(maxMs - minMs + 1);
}
