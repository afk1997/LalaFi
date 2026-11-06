import type { Hex } from 'viem';
import type { KvStore } from '@xpool/service-common';

/**
 * Per-request status. Deliberately minimal: no proof, no extData, no client data — only what
 * GET /v1/status needs. Entries are pruned after `retentionMs`.
 */
export type RequestState = 'pending' | 'submitted' | 'confirmed' | 'released' | 'failed';

export interface RequestRecord {
  state: RequestState;
  dstChainId: bigint;
  txHash: Hex | null;
  releaseIndex: bigint | null;
  error: string | null;
  createdAt: number;
}

export class RequestStore {
  constructor(
    private readonly kv: KvStore,
    private readonly retentionMs = 7 * 24 * 3600_000,
  ) {}

  create(id: string, dstChainId: bigint, now = Date.now()): RequestRecord {
    const rec: RequestRecord = { state: 'pending', dstChainId, txHash: null, releaseIndex: null, error: null, createdAt: now };
    this.kv.set(`req:${id}`, rec);
    return rec;
  }

  get(id: string): RequestRecord | undefined {
    return this.kv.get<RequestRecord>(`req:${id}`);
  }

  update(id: string, patch: Partial<RequestRecord>): void {
    const cur = this.get(id);
    if (cur) this.kv.set(`req:${id}`, { ...cur, ...patch });
  }

  prune(now = Date.now()): number {
    return this.kv.prune('req:', now - this.retentionMs);
  }
}
