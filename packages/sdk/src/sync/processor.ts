/**
 * Applies decoded chain events to the local tree, nullifier set and note store.
 * Pure (no RPC), so it is fully unit-testable. Every decoded value is range-checked.
 */
import { MAX_ENC_LEN, MAX_LEAVES } from '../constants.js';
import { isField, type Field } from '../crypto/field.js';
import type { SpendingKeys } from '../keys/derive.js';
import { commitmentFromDigest, nullifier } from '../notes/note.js';
import type { OwnedNote, PendingDeposit } from '../notes/store.js';
import { tryAcceptForCommitment, tryAcceptForDeposit } from '../notes/validate.js';
import { zeroHashes } from '../tree/zeros.js';
import type { ChainView, ReleaseStatus } from './state.js';

export type HubEvent =
  | { type: 'NewCommitment'; commitment: bigint; leafIndex: number; enc: Uint8Array }
  | { type: 'NewNullifier'; nullifier: bigint }
  | { type: 'LeavesInserted'; firstLeafIndex: number; count: bigint; newRoot: bigint }
  | { type: 'ReleaseLogged'; dstChainId: bigint; index: bigint; recipient: string; amount: bigint; spendId: string }
  | { type: 'Spend'; spendId: string; root: bigint; dstChainId: bigint; v: bigint }
  | { type: 'L1Deposit'; leafIndex: number; commitment: bigint; amount: bigint; depositor: string; encNote: Uint8Array }
  | { type: 'L2DepositInserted'; srcChainId: bigint; index: bigint; commitment: bigint; leafIndex: number; fastLane: boolean };

export type SpokeEvent =
  | { type: 'Deposit'; index: bigint; ownerDigest: bigint; amount: bigint; fee: bigint; l2Block: bigint; encNote: Uint8Array }
  | { type: 'ReleaseExecuted' | 'ReleaseQueued' | 'ReleaseFailed'; index: bigint };

export interface EventMeta {
  txHash: string;
  blockNumber: bigint;
  time: number;
}

/** The subset of NoteStore the processor needs. */
export interface NoteSink {
  list(opts?: { includeSpent?: boolean }): OwnedNote[];
  upsert(note: OwnedNote): boolean;
  addPending(p: PendingDeposit): void;
  takePending(chainId: number, index: number): PendingDeposit | undefined;
  applyNullifiers(isSpent: (n: Field) => boolean): number;
}

export class SyncError extends Error {
  override name = 'SyncError';
}

export interface SyncStats {
  newNotes: number;
  spentNotes: number;
  leaves: number;
}

const key = (a: bigint | number, b: bigint | number): string => `${a}:${b}`;

function checkLeafIndex(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_LEAVES) throw new SyncError(`leaf index out of range: ${i}`);
}

function checkField(x: bigint, what: string): void {
  if (!isField(x)) throw new SyncError(`${what} is not a field element`);
}

export class SyncProcessor {
  readonly stats: SyncStats = { newNotes: 0, spentNotes: 0, leaves: 0 };

  constructor(
    private readonly keys: Pick<SpendingKeys, 'sk' | 'pk' | 'encSk'>,
    private readonly hubChainId: number,
    private readonly view: ChainView,
    private readonly notes: NoteSink,
  ) {}

  private get state() {
    return this.view.state;
  }

  // ------------------------------------------------------------------ tree

  private setLeaf(i: number, c: Field): void {
    checkLeafIndex(i);
    checkField(c, 'commitment');
    const t = this.view.tree;
    if (i < t.size) {
      if (t.leaf(i) !== c) throw new SyncError(`conflicting leaf at ${i}`);
      return;
    }
    const prev = this.state.pendingLeaves[String(i)];
    if (prev !== undefined && prev !== c) throw new SyncError(`conflicting leaf at ${i}`);
    this.state.pendingLeaves[String(i)] = c;
    this.advance();
  }

  private advance(): void {
    const t = this.view.tree;
    const pl = this.state.pendingLeaves;
    for (;;) {
      const l = pl[String(t.size)];
      const r = pl[String(t.size + 1)];
      if (l === undefined || r === undefined) break;
      t.insertPair(l, r);
      delete pl[String(t.size - 2)];
      delete pl[String(t.size - 1)];
      this.state.leaves.push(l, r);
      this.stats.leaves += 2;
      const want = this.state.rootChecks[String(t.size)];
      if (want !== undefined) {
        if (want !== t.root()) throw new SyncError(`root mismatch at size ${t.size}: RPC data inconsistent`);
        delete this.state.rootChecks[String(t.size)];
      }
    }
  }

  // ------------------------------------------------------------------ hub

  /** Process all hub events of ONE transaction (nullifiers first, then outputs). */
  processHubTx(events: HubEvent[], meta: EventMeta): void {
    const spentHere: OwnedNote[] = [];
    this.txRanges = [];
    for (const e of events) {
      if (e.type !== 'NewNullifier') continue;
      checkField(e.nullifier, 'nullifier');
      this.view.addNullifier(e.nullifier);
      const mine = this.notes.list({ includeSpent: true }).filter((n) => n.nullifier === e.nullifier);
      spentHere.push(...mine);
      this.stats.spentNotes += this.notes.applyNullifiers((n) => n === e.nullifier);
    }
    for (const e of events) {
      switch (e.type) {
        case 'NewNullifier':
          break;
        case 'NewCommitment':
          this.onNewCommitment(e, meta, spentHere);
          break;
        case 'LeavesInserted':
          this.onLeavesInserted(e);
          break;
        case 'L1Deposit':
          this.onL1Deposit(e, meta);
          break;
        case 'L2DepositInserted':
          this.onL2Inserted(e, meta);
          break;
        case 'ReleaseLogged': {
          const k = key(e.dstChainId, e.index);
          this.state.releases[k] = {
            dstChainId: Number(e.dstChainId),
            index: Number(e.index),
            recipient: e.recipient,
            amount: e.amount,
            spendId: e.spendId,
            status: this.state.spokeReleaseStatus[k] ?? 'logged',
          };
          delete this.state.spokeReleaseStatus[k];
          break;
        }
        case 'Spend':
          this.state.spends[e.spendId] = {
            spendId: e.spendId,
            dstChainId: Number(e.dstChainId),
            v: e.v,
            root: e.root,
            txHash: meta.txHash,
            time: meta.time,
          };
          break;
      }
    }
    // HubCore pads odd deposit batches with Z0 and LeavesInserted.count INCLUDES that padding.
    // Every real leaf of the range is announced by an event in this same tx, so a slot that is
    // still empty after the whole tx is the padding leaf (only ever the last one).
    for (const { first, count } of this.txRanges) {
      const last = first + count - 1;
      if (last >= this.view.tree.size && this.state.pendingLeaves[String(last)] === undefined) {
        this.setLeaf(last, zeroHashes()[0]!);
      }
    }
    this.txRanges = [];
  }

  /** LeavesInserted ranges seen in the tx being processed. */
  private txRanges: { first: number; count: number }[] = [];

  private onNewCommitment(e: Extract<HubEvent, { type: 'NewCommitment' }>, meta: EventMeta, spentHere: OwnedNote[]): void {
    this.setLeaf(e.leafIndex, e.commitment);
    if (e.enc.length === 0 || e.enc.length > MAX_ENC_LEN) return;
    const note = tryAcceptForCommitment(this.keys, e.enc, e.commitment);
    if (!note || note.amount === 0n) return;
    // Change notes inherit the most recent funding of the inputs (conservative for W3/W4);
    // received notes are funded by their own insertion.
    const inherited = spentHere.length > 0;
    const owned: OwnedNote = {
      ...note,
      commitment: e.commitment,
      leafIndex: e.leafIndex,
      nullifier: nullifier(this.keys.sk, e.commitment, e.leafIndex),
      source: 'spend-output',
      originChainId: this.hubChainId,
      fundedAt: inherited ? Math.max(...spentHere.map((n) => n.fundedAt)) : meta.time,
      fundingLeaf: inherited ? Math.max(...spentHere.map((n) => n.fundingLeaf)) : e.leafIndex,
      fundingAmounts: inherited ? spentHere.flatMap((n) => n.fundingAmounts) : [],
      spent: this.view.isSpent(nullifier(this.keys.sk, e.commitment, e.leafIndex)),
    };
    if (this.notes.upsert(owned)) this.stats.newNotes++;
  }

  private onLeavesInserted(e: Extract<HubEvent, { type: 'LeavesInserted' }>): void {
    checkLeafIndex(e.firstLeafIndex);
    checkField(e.newRoot, 'root');
    if (e.count <= 0n || e.count > BigInt(MAX_LEAVES)) throw new SyncError('bad LeavesInserted count');
    const n = Number(e.count);
    if (n % 2 === 1) throw new SyncError('LeavesInserted count must be even (it includes Z0 padding)');
    const end = e.firstLeafIndex + n;
    this.txRanges.push({ first: e.firstLeafIndex, count: n });
    if (end <= this.view.tree.size) {
      // Already applied: we can only check if it is the current root.
      if (end === this.view.tree.size && this.view.tree.root() !== e.newRoot) throw new SyncError('root mismatch');
      return;
    }
    this.state.rootChecks[String(end)] = e.newRoot;
    this.advance();
  }

  private onL1Deposit(e: Extract<HubEvent, { type: 'L1Deposit' }>, meta: EventMeta): void {
    this.setLeaf(e.leafIndex, e.commitment);
    this.state.deposits.push({ leafIndex: e.leafIndex, chainId: this.hubChainId, amount: e.amount, time: meta.time });
    if (e.encNote.length === 0 || e.encNote.length > MAX_ENC_LEN) return;
    const note = tryAcceptForCommitment(this.keys, e.encNote, e.commitment);
    if (!note || note.amount !== e.amount || note.amount === 0n) return;
    const owned: OwnedNote = {
      ...note,
      commitment: e.commitment,
      leafIndex: e.leafIndex,
      nullifier: nullifier(this.keys.sk, e.commitment, e.leafIndex),
      source: 'l1-deposit',
      originChainId: this.hubChainId,
      fundedAt: meta.time,
      fundingLeaf: e.leafIndex,
      fundingAmounts: [e.amount],
      spent: false,
    };
    owned.spent = this.view.isSpent(owned.nullifier);
    if (this.notes.upsert(owned)) this.stats.newNotes++;
  }

  private onL2Inserted(e: Extract<HubEvent, { type: 'L2DepositInserted' }>, meta: EventMeta): void {
    this.setLeaf(e.leafIndex, e.commitment);
    const chainId = Number(e.srcChainId);
    const index = Number(e.index);
    const k = key(chainId, index);
    if (this.state.l2Inserted[k]) return; // duplicate (e.g. replayed page)
    this.state.l2Inserted[k] = { commitment: e.commitment, leafIndex: e.leafIndex, fastLane: e.fastLane, time: meta.time };
    const p = this.notes.takePending(chainId, index);
    const sd = this.state.spokeDeposits[k];
    this.state.deposits.push({ leafIndex: e.leafIndex, chainId, amount: sd?.amount ?? 0n, time: sd?.time ?? meta.time });
    if (p) this.adoptL2(p, e.commitment, e.leafIndex);
  }

  private adoptL2(p: PendingDeposit, onChainC: Field, leafIndex: number): void {
    if (p.commitment !== onChainC) return; // validate-before-accept: hub commitment must match
    const owned: OwnedNote = {
      amount: p.amount,
      pk: p.pk,
      blinding: p.blinding,
      commitment: onChainC,
      leafIndex,
      nullifier: nullifier(this.keys.sk, onChainC, leafIndex),
      source: 'l2-deposit',
      originChainId: p.chainId,
      fundedAt: p.fundedAt,
      fundingLeaf: leafIndex,
      fundingAmounts: [p.amount],
      spent: false,
    };
    owned.spent = this.view.isSpent(owned.nullifier);
    if (this.notes.upsert(owned)) this.stats.newNotes++;
  }

  // ------------------------------------------------------------------ spokes

  processSpokeEvent(chainId: number, e: SpokeEvent, meta: EventMeta): void {
    if (e.type === 'Deposit') {
      checkField(e.ownerDigest, 'ownerDigest');
      const k = key(chainId, e.index);
      if (!this.state.spokeDeposits[k]) {
        this.state.spokeDeposits[k] = { amount: e.amount, time: meta.time };
        const ins0 = this.state.l2Inserted[k];
        const d = ins0 && this.state.deposits.find((x) => x.leafIndex === ins0.leafIndex);
        if (d) {
          d.amount = e.amount;
          d.time = meta.time;
        }
      }
      if (e.encNote.length === 0 || e.encNote.length > MAX_ENC_LEN) return;
      const note = tryAcceptForDeposit(this.keys, e.encNote, e.ownerDigest, e.amount);
      if (!note || note.amount === 0n) return;
      const p: PendingDeposit = {
        chainId,
        index: Number(e.index),
        amount: note.amount,
        blinding: note.blinding,
        pk: note.pk,
        commitment: commitmentFromDigest(note.amount, e.ownerDigest),
        fundedAt: meta.time,
      };
      const ins = this.state.l2Inserted[k];
      if (ins) {
        // Hub insertion was seen first: adopt now.
        this.adoptL2(p, ins.commitment, ins.leafIndex);
      } else {
        this.notes.addPending(p);
      }
      return;
    }
    const status: ReleaseStatus =
      e.type === 'ReleaseExecuted' ? 'executed' : e.type === 'ReleaseQueued' ? 'queued' : 'failed';
    const k = key(chainId, e.index);
    const r = this.state.releases[k];
    if (r) {
      if (r.status !== 'executed') r.status = status;
    } else if (this.state.spokeReleaseStatus[k] !== 'executed') {
      this.state.spokeReleaseStatus[k] = status;
    }
  }
}
