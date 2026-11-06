/**
 * Find everything a code owns: full event sync of all three chains (PRD W9: never ask an RPC about
 * a specific note), trial-decrypt every deposit / output, validate-before-accept (SDK). In memory only.
 */
import {
  abi,
  ChainView,
  tryAcceptForDeposit,
  emptySyncState,
  syncAll,
  type Field,
  type NoteSink,
  type OwnedNote,
  type PendingDeposit,
  type SpendingKeys,
} from '@xpool/sdk/browser';
import { parseAbi } from 'viem';
import { clientsOf } from './chain';
import type { Pool } from './env';

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

export interface Arriving {
  chainId: number;
  index: number;
  amount: bigint;
  /** false while the L2 block holding the deposit isn't finalized yet. */
  finalized: boolean;
}

export interface ScanResult {
  view: ChainView;
  notes: OwnedNote[];
  /** Deposits made on an L2 with this code that aren't in the pool yet (finalized or not). */
  arriving: Arriving[];
  /** Per L2 chain: does validator stake back the fast lane right now? Otherwise deposits wait for the bridge. */
  fastLane: Record<number, boolean>;
  balance: bigint;
  arrivingTotal: bigint;
}

export async function scan(pool: Pool, keys: SpendingKeys, onProgress?: (fraction: number) => void): Promise<ScanResult> {
  const env = pool.env;
  const clients = clientsOf(pool);
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
  const arriving: Arriving[] = sink.pending.map((p) => ({ chainId: p.chainId, index: p.index, amount: p.amount, finalized: true }));
  arriving.push(...(await unfinalizedDeposits(pool, keys, arriving)));
  return {
    view,
    notes,
    arriving,
    fastLane: await fastLaneByChain(pool),
    balance: notes.reduce((s, n) => s + n.amount, 0n),
    arrivingTotal: arriving.reduce((s, p) => s + p.amount, 0n),
  };
}

const stakeAbi = parseAbi([
  'function currentEpoch() view returns (uint64)',
  'function totalAllocation(uint64 chainId, uint64 epoch) view returns (uint256)',
]);

const depositEvent = abi.spokeAbi.find((x) => x.type === 'event' && x.name === 'Deposit')!;

/**
 * The sync above only reads finalized blocks (safe against reorgs). L2 finality can lag hours on testnets,
 * so also read the unfinalized tail of each spoke, purely to tell the person their deposit was seen.
 * Same privacy rule: every Deposit event is fetched and trial-decrypted locally.
 */
async function unfinalizedDeposits(pool: Pool, keys: SpendingKeys, known: Arriving[]): Promise<Arriving[]> {
  const out: Arriving[] = [];
  for (const s of pool.env.spokes) {
    try {
      const c = clientsOf(pool).pool(s.chainId);
      const [fin, head] = await Promise.all([
        c.run((x) => x.getBlock({ blockTag: 'finalized' })).then((b) => b.number),
        c.run((x) => x.getBlockNumber()),
      ]);
      const CHUNK = 2_000n;
      for (let from = fin + 1n; from <= head; from += CHUNK) {
        const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
        const logs = await c.run((x) => x.getLogs({ address: s.spoke, event: depositEvent as never, fromBlock: from, toBlock: to }));
        for (const l of logs as unknown as { args: { index: bigint; ownerDigest: bigint; amount: bigint; encNote: `0x${string}` } }[]) {
          const a = l.args;
          const idx = Number(a.index);
          if (known.some((k) => k.chainId === s.chainId && k.index === idx)) continue;
          const blob = Uint8Array.from((a.encNote.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
          if (tryAcceptForDeposit(keys, blob, a.ownerDigest, a.amount)) out.push({ chainId: s.chainId, index: idx, amount: a.amount, finalized: false });
        }
      }
    } catch {
      // best effort: this only adds an "on its way" hint
    }
  }
  return out;
}

async function fastLaneByChain(pool: Pool): Promise<Record<number, boolean>> {
  const out: Record<number, boolean> = {};
  const hub = clientsOf(pool).hub;
  const sm = pool.env.hub.contracts.StakeManager;
  try {
    const epoch = await hub.run((x) => x.readContract({ address: sm, abi: stakeAbi, functionName: 'currentEpoch' }));
    for (const s of pool.env.spokes) {
      const total = await hub.run((x) =>
        x.readContract({ address: sm, abi: stakeAbi, functionName: 'totalAllocation', args: [BigInt(s.chainId), epoch] }),
      );
      out[s.chainId] = total > 0n;
    }
  } catch {
    for (const s of pool.env.spokes) out[s.chainId] = false;
  }
  return out;
}
