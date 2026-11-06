/**
 * W5 scheduler: split a withdrawal into N parts at random delays (CSPRNG). Parts are rounded to a
 * unit (default 10 USDC) where possible; the remainder goes to one random part.
 */
import { USDC_DECIMALS } from '../constants.js';
import { randomInt, shuffle } from '../crypto/random.js';

export interface ScheduledPart {
  amount: bigint;
  /** Unix seconds at which to submit. */
  at: number;
}

export interface SplitOptions {
  nowSec?: number;
  /** Min/max seconds between consecutive parts (default 1 h .. 12 h). */
  minGapSeconds?: number;
  maxGapSeconds?: number;
  /** First part also waits a random gap (default true). */
  delayFirst?: boolean;
  /** Rounding unit in base units (default 10 USDC). */
  unit?: bigint;
  /** Minimum size of any part (e.g. minWithdraw). */
  minPart?: bigint;
}

export function splitWithdrawal(total: bigint, n: number, o: SplitOptions = {}): ScheduledPart[] {
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new RangeError('split count must be 1..32');
  if (total <= 0n) throw new RangeError('total must be > 0');
  const unit = o.unit ?? 10n * 10n ** BigInt(USDC_DECIMALS);
  const minPart = o.minPart ?? 1n;
  if (total < BigInt(n) * minPart) throw new RangeError('total too small for that many parts');
  const minGap = o.minGapSeconds ?? 3600;
  const maxGap = o.maxGapSeconds ?? 12 * 3600;
  if (minGap < 0 || maxGap < minGap) throw new RangeError('bad gap bounds');

  // Random weights in [0.6, 1.4) of an equal share, rounded down to the unit.
  const amounts: bigint[] = [];
  const share = total / BigInt(n);
  let used = 0n;
  for (let i = 0; i < n; i++) {
    const factor = BigInt(600 + randomInt(800));
    let a = (share * factor) / 1000n;
    if (a >= unit) a = (a / unit) * unit;
    if (a < minPart) a = minPart;
    amounts.push(a);
    used += a;
  }
  // Fix the sum: scale down if we overshot, then put the remainder on a random part.
  while (used > total) {
    const i = amounts.findIndex((a) => a - unit >= minPart);
    if (i < 0) {
      amounts.fill(share);
      amounts[0] = total - share * BigInt(n - 1);
      used = total;
      break;
    }
    amounts[i] = amounts[i]! - unit;
    used -= unit;
  }
  if (used < total) {
    const j = randomInt(n);
    amounts[j] = amounts[j]! + (total - used);
  }
  shuffle(amounts);

  let t = o.nowSec ?? Math.floor(Date.now() / 1000);
  return amounts.map((amount, i) => {
    if (i > 0 || o.delayFirst !== false) t += minGap + randomInt(maxGap - minGap + 1);
    return { amount, at: t };
  });
}
