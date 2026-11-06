/**
 * Public chain state rebuilt by sync. Everything here is public on-chain data, but callers should
 * still persist it in an encrypted store (it reveals that this machine uses xpool).
 */
import type { Field } from '../crypto/field.js';
import { MerkleTree } from '../tree/merkle.js';

export interface DepositRecord {
  leafIndex: number;
  chainId: number;
  amount: bigint;
  /** Estimated unix seconds. */
  time: number;
}

export interface L2Insertion {
  commitment: Field;
  leafIndex: number;
  fastLane: boolean;
  time: number;
}

export type ReleaseStatus = 'logged' | 'executed' | 'queued' | 'failed';

export interface ReleaseRecord {
  dstChainId: number;
  index: number;
  recipient: string;
  amount: bigint;
  spendId: string;
  status: ReleaseStatus;
}

export interface SpendRecord {
  spendId: string;
  dstChainId: number;
  v: bigint;
  root: Field;
  txHash: string;
  time: number;
}

export interface SyncState {
  version: 1;
  /** Last fully processed block per chain id (decimal string). */
  cursors: Record<string, string>;
  /** Contiguous leaves already in the tree (even length). */
  leaves: Field[];
  /** Leaves seen beyond the contiguous prefix, by index. */
  pendingLeaves: Record<string, Field>;
  /** Expected root once the tree reaches a size (from LeavesInserted). */
  rootChecks: Record<string, Field>;
  nullifiers: Field[];
  deposits: DepositRecord[];
  /** `${chainId}:${index}` -> insertion on the hub. */
  l2Inserted: Record<string, L2Insertion>;
  /** Every spoke deposit seen, `${chainId}:${index}` -> amount and L2 time. */
  spokeDeposits: Record<string, { amount: bigint; time: number }>;
  /** `${dstChainId}:${index}` -> release. */
  releases: Record<string, ReleaseRecord>;
  /** Spend events by spendId. */
  spends: Record<string, SpendRecord>;
  /** Spoke release states seen before the hub log, `${chainId}:${index}`. */
  spokeReleaseStatus: Record<string, ReleaseStatus>;
  /** Last estimated head timestamp per chain. */
  lastTime: Record<string, number>;
}

export function emptySyncState(): SyncState {
  return {
    version: 1,
    cursors: {},
    leaves: [],
    pendingLeaves: {},
    rootChecks: {},
    nullifiers: [],
    deposits: [],
    l2Inserted: {},
    spokeDeposits: {},
    releases: {},
    spends: {},
    spokeReleaseStatus: {},
    lastTime: {},
  };
}

/** Runtime view: tree + nullifier set built from a persisted state. */
export class ChainView {
  readonly tree: MerkleTree;
  readonly nullifiers: Set<Field>;

  constructor(readonly state: SyncState) {
    this.tree = MerkleTree.fromLeaves(state.leaves);
    this.nullifiers = new Set(state.nullifiers);
  }

  isSpent(n: Field): boolean {
    return this.nullifiers.has(n);
  }

  addNullifier(n: Field): void {
    if (!this.nullifiers.has(n)) {
      this.nullifiers.add(n);
      this.state.nullifiers.push(n);
    }
  }
}
