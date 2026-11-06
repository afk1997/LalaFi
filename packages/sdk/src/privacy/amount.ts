/**
 * W5 amount hygiene: suggest round amounts, warn when a withdrawal is within 1% of a deposit amount.
 */
import { USDC_DECIMALS } from '../constants.js';
import type { Finding } from './types.js';

const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** 10, 50, 100, 500, 1k, 5k, 10k USDC (base units). */
export const ROUND_AMOUNTS: readonly bigint[] = [10n, 50n, 100n, 500n, 1_000n, 5_000n, 10_000n].map((x) => x * UNIT);

export function isRoundAmount(w: bigint): boolean {
  return ROUND_AMOUNTS.some((r) => w % r === 0n) && w > 0n;
}

/** Nearest round amounts at or below and above `w`. */
export function suggestRoundAmounts(w: bigint): bigint[] {
  if (w <= 0n) return [];
  const out = new Set<bigint>();
  for (const r of ROUND_AMOUNTS) {
    const down = (w / r) * r;
    if (down > 0n) out.add(down);
    out.add(down + r);
    if (out.size >= 6) break;
  }
  const sorted = [...out].sort((a, b) => (a < b ? -1 : 1));
  const below = sorted.filter((x) => x <= w).slice(-2);
  const above = sorted.filter((x) => x > w).slice(0, 1);
  return [...below, ...above];
}

/** True iff |w - d| <= d / 100. */
export function withinOnePercent(w: bigint, d: bigint): boolean {
  if (d <= 0n) return false;
  const diff = w > d ? w - d : d - w;
  return diff * 100n <= d;
}

export function checkAmountHygiene(w: bigint, fundingAmounts: readonly bigint[]): Finding[] {
  const out: Finding[] = [];
  const close = fundingAmounts.find((d) => withinOnePercent(w, d));
  if (close !== undefined) {
    out.push({
      rule: 'W5',
      level: 'warn',
      message: 'withdrawal amount is within 1% of one of your deposit amounts; consider a different amount or --split',
    });
  }
  if (!isRoundAmount(w)) {
    const s = suggestRoundAmounts(w).map((x) => (Number(x) / Number(UNIT)).toString());
    out.push({ rule: 'W5', level: 'info', message: `non-round amount; round amounts blend in better (e.g. ${s.join(', ')} USDC)` });
  }
  return out;
}
