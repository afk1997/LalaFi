import { MAX_BATCH, P, type L2Deposit } from '@xpool/service-common';

/** Fast-lane eligibility (PRD 7.5 submitAttestation checks, 13.4 attester). */
export interface BatchPolicy {
  minDeposit: bigint;
  maxFastDeposit: bigint;
  maxBatch?: number;
  /** Max Σ amount per batch (capacity / valve headroom). */
  maxBatchValue: bigint;
}

export function isEligible(d: L2Deposit, p: BatchPolicy): boolean {
  return d.ownerDigest < P && d.amount >= p.minDeposit && d.amount <= p.maxFastDeposit;
}

/**
 * Deterministic batching: eligible, not-yet-inserted deposits in ascending index order, chunked
 * greedily into batches of ≤ maxBatch items and ≤ maxBatchValue total. Validators with the same
 * view produce identical batches (identical digests), which is what lets signatures aggregate.
 */
export function buildBatches(verified: readonly L2Deposit[], inserted: ReadonlySet<bigint>, p: BatchPolicy): L2Deposit[][] {
  const maxBatch = Math.min(p.maxBatch ?? MAX_BATCH, MAX_BATCH);
  const pool = verified
    .filter((d) => !inserted.has(d.index) && isEligible(d, p) && d.amount <= p.maxBatchValue)
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  const out: L2Deposit[][] = [];
  let cur: L2Deposit[] = [];
  let sum = 0n;
  for (const d of pool) {
    if (cur.length && cur[cur.length - 1]!.index === d.index) continue; // defensive: duplicate
    if (cur.length === maxBatch || sum + d.amount > p.maxBatchValue) {
      out.push(cur);
      cur = [];
      sum = 0n;
    }
    cur.push(d);
    sum += d.amount;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const batchValue = (deposits: readonly L2Deposit[]) => deposits.reduce((s, d) => s + d.amount, 0n);
