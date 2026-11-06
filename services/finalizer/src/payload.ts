import type { Hex } from 'viem';
import { encodeCheckpoint, type Checkpoint, type L2Deposit } from '@xpool/service-common';

/** Fields of Spoke.CheckpointSent (== DepositManager.CheckpointReceived). */
export interface CheckpointHeader {
  seq: bigint;
  from: bigint;
  to: bigint;
  countAtSend: bigint;
  l2Block: bigint;
}

export const sameHeader = (a: CheckpointHeader, b: CheckpointHeader) =>
  a.seq === b.seq && a.from === b.from && a.to === b.to && a.countAtSend === b.countAtSend && a.l2Block === b.l2Block;

/**
 * Rebuilds the exact MSG_CHECKPOINT body the spoke sent: abi.encode(Checkpoint) from the
 * CheckpointSent header plus the Deposit events for indices [from, to). Throws if any deposit is
 * missing, duplicated with different content, or out of range — DepositManager checks
 * keccak256(payload) against the stored hash, so a wrong payload must never be submitted.
 */
export function buildCheckpointPayload(h: CheckpointHeader, deposits: readonly L2Deposit[]): { checkpoint: Checkpoint; payload: Hex } {
  const byIndex = new Map<bigint, L2Deposit>();
  for (const d of deposits) {
    if (d.index < h.from || d.index >= h.to) continue;
    const prev = byIndex.get(d.index);
    if (prev && JSON.stringify(prev, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) !== JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) {
      throw new Error(`conflicting Deposit events for index ${d.index}`);
    }
    byIndex.set(d.index, d);
  }
  const items: L2Deposit[] = [];
  for (let i = h.from; i < h.to; i++) {
    const d = byIndex.get(i);
    if (!d) throw new Error(`missing Deposit event for index ${i}`);
    items.push({ index: d.index, ownerDigest: d.ownerDigest, amount: d.amount, fee: d.fee, l2Block: d.l2Block });
  }
  const checkpoint: Checkpoint = { ...h, deposits: items };
  return { checkpoint, payload: encodeCheckpoint(checkpoint) };
}

export type SendReason = 'count' | 'timer' | 'absence' | null;

export interface SendPolicyInput {
  /** depositCount - nextCheckpointFrom */
  pending: bigint;
  /** Unix seconds of the last CheckpointSent (0 if none). */
  lastSentSec: number;
  nowSec: number;
  everyN: bigint;
  everySec: number;
  /** A fast-lane batch attested an index ≥ depositCount: watchers need a checkpoint to prove absence. */
  absenceNeeded: boolean;
}

/** PRD 13.5: every N deposits or T seconds; plus (possibly empty) checkpoints for absence proofs. */
export function checkpointReason(i: SendPolicyInput): SendReason {
  if (i.pending >= i.everyN) return 'count';
  if (i.pending > 0n && i.nowSec - i.lastSentSec >= i.everySec) return 'timer';
  if (i.absenceNeeded) return 'absence';
  return null;
}
