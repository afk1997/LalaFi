/**
 * Find everything a code owns: full event sync of all three chains (PRD W9: never ask an RPC about
 * a specific note), trial-decrypt every deposit / output, validate-before-accept (SDK). In memory only.
 */
import {
  ChainView,
  emptySyncState,
  syncAll,
  type Field,
  type NoteSink,
  type OwnedNote,
  type PendingDeposit,
  type SpendingKeys,
} from '@xpool/sdk/browser';
import { clients } from './chain';
import { env } from './env';

class MemoryNotes implements NoteSink {
  notes: OwnedNote[] = [];
  pending: PendingDeposit[] = [];

  list(opts: { includeSpent?: boolean } = {}): OwnedNote[] {
    return this.notes.filter((n) => opts.includeSpent || !n.spent);
  }
  upsert(note: OwnedNote): boolean {
    const i = this.notes.findIndex((n) => n.leafIndex === note.leafIndex);
    if (i >= 0) {
      this.notes[i] = { ...note, spent: this.notes[i]!.spent || note.spent };
      return false;
    }
    this.notes.push(note);
    return true;
  }
  addPending(p: PendingDeposit): void {
    if (!this.pending.some((x) => x.chainId === p.chainId && x.index === p.index)) this.pending.push(p);
  }
  takePending(chainId: number, index: number): PendingDeposit | undefined {
    const i = this.pending.findIndex((x) => x.chainId === chainId && x.index === index);
    return i < 0 ? undefined : this.pending.splice(i, 1)[0];
  }
  applyNullifiers(isSpent: (n: Field) => boolean): number {
    let k = 0;
    for (const n of this.notes) if (!n.spent && isSpent(n.nullifier)) (n.spent = true), k++;
    return k;
  }
}

export interface ScanResult {
  view: ChainView;
  notes: OwnedNote[];
  /** Deposits seen on an L2 but not yet inserted into the pool. */
  arriving: PendingDeposit[];
  balance: bigint;
  arrivingTotal: bigint;
}

export async function scan(keys: SpendingKeys, onProgress?: (fraction: number) => void): Promise<ScanResult> {
  const view = new ChainView(emptySyncState());
  const sink = new MemoryNotes();
  const done = new Map<number, number>();
  await syncAll({
    env,
    clients,
    keys,
    view,
    notes: sink,
    onProgress: (p) => {
      const span = Number(p.toBlock - p.fromBlock) || 1;
      done.set(p.chainId, Math.min(1, Number(p.at - p.fromBlock) / span));
      onProgress?.([...done.values()].reduce((a, b) => a + b, 0) / (env.spokes.length + 1));
    },
  });
  const notes = sink.list();
  return {
    view,
    notes,
    arriving: sink.pending,
    balance: notes.reduce((s, n) => s + n.amount, 0n),
    arrivingTotal: sink.pending.reduce((s, p) => s + p.amount, 0n),
  };
}
