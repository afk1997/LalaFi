/**
 * Anonymity estimates (PRD 12.2, W4). These are local, conservative heuristics over public
 * deposit data: an adversary's feasibility set, not a cryptographic guarantee.
 */
import type { DepositRecord } from '../sync/state.js';
import type { Finding } from './types.js';
import { OVERRIDE_FLAGS } from './types.js';

export const ANON_WARN = 20;
export const ANON_BLOCK = 5;

/** Number of deposits (any chain) inserted after the funding deposit's leaf (W4 metric). */
export function depositsAfter(deposits: readonly DepositRecord[], fundingLeaf: number): number {
  let k = 0;
  for (const d of deposits) if (d.leafIndex > fundingLeaf) k++;
  return k;
}

/**
 * k_feas estimate for a withdrawal of `w`: deposits not excluded by amount feasibility
 * (amount >= w, or unknown) made before `atTime`. Excludes nothing else (timing, clustering).
 */
export function kFeasible(deposits: readonly DepositRecord[], w: bigint, atTime = Number.MAX_SAFE_INTEGER): number {
  let k = 0;
  for (const d of deposits) if (d.time <= atTime && (d.amount === 0n || d.amount >= w)) k++;
  return k;
}

/** Shannon-entropy effective set size k_eff = 2^H for a posterior over candidates. */
export function kEffective(posterior: readonly number[]): number {
  const total = posterior.reduce((s, x) => s + x, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const x of posterior) {
    const p = x / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return 2 ** h;
}

/** W4: warn below 20, block below 5 deposits after the funding deposit. */
export function checkAnonymity(after: number, override = false): Finding | undefined {
  if (after < ANON_BLOCK) {
    return {
      rule: 'W4',
      level: override ? 'warn' : 'block',
      message: `only ${after} deposits since your funding deposit (minimum ${ANON_BLOCK}); this withdrawal is easy to link`,
      overrideFlag: OVERRIDE_FLAGS.W4,
    };
  }
  if (after < ANON_WARN) {
    return { rule: 'W4', level: 'warn', message: `only ${after} deposits since your funding deposit (recommended >= ${ANON_WARN})` };
  }
  return undefined;
}
