import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptNote, randomX25519KeyPair } from '../src/crypto/box.js';
import { randomField } from '../src/crypto/field.js';
import { commitment, createNote, nullifier, ownerDigest } from '../src/notes/note.js';
import { NoteStore } from '../src/notes/store.js';
import { ChainView, emptySyncState, SyncProcessor, SyncError, toHubEvent, toSpokeEvent, interpolateTime } from '../src/sync/index.js';
import { MerkleTree, zeroLeaf } from '../src/tree/index.js';
import { stringifyTagged, parseTagged } from '../src/notes/vault.js';
import type { SyncState } from '../src/sync/state.js';
import { TEST_KEYS } from './helpers.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const HUB = 31337;
const BASE = 31338;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xpool-sync-'));
  const store = NoteStore.create(dir, 'pw', 0, FAST);
  const view = new ChainView(emptySyncState());
  const proc = new SyncProcessor(TEST_KEYS, HUB, view, store);
  return { store, view, proc };
}

const meta = (n: number, time = 1000) => ({ txHash: `0x${n.toString(16).padStart(64, '0')}`, blockNumber: BigInt(n), time });

describe('SyncProcessor', () => {
  it('rebuilds the tree from L1 deposits (Z0 padding) and accepts own notes only after validation', () => {
    const { store, view, proc } = setup();
    const mine = createNote(5_000_000n, TEST_KEYS.pk);
    const C = commitment(mine);
    const enc = encryptNote(TEST_KEYS.encPk, { amount: mine.amount, blinding: mine.blinding });
    const ref = new MerkleTree();
    ref.insertBatch([C]);
    proc.processHubTx(
      [
        { type: 'L1Deposit', leafIndex: 0, commitment: C, amount: mine.amount, depositor: '0x01', encNote: enc },
        { type: 'LeavesInserted', firstLeafIndex: 0, count: 2n, newRoot: ref.root() },
      ],
      meta(1, 500),
    );
    expect(view.tree.size).toBe(2);
    expect(view.tree.leaf(1)).toBe(zeroLeaf());
    expect(view.tree.root()).toBe(ref.root());
    const notes = store.list();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.nullifier).toBe(nullifier(TEST_KEYS.sk, C, 0));
    expect(notes[0]!.fundedAt).toBe(500);
    expect(view.state.deposits).toHaveLength(1);

    // A ciphertext to us that lies about the amount must be ignored.
    const other = createNote(1n, TEST_KEYS.pk);
    const lie = encryptNote(TEST_KEYS.encPk, { amount: 999n, blinding: other.blinding });
    proc.processHubTx(
      [{ type: 'L1Deposit', leafIndex: 2, commitment: commitment(other), amount: 1n, depositor: '0x01', encNote: lie }],
      meta(2),
    );
    expect(store.list()).toHaveLength(1);
  });

  it('detects RPC inconsistencies (root mismatch, conflicting leaves, bad values)', () => {
    const { proc } = setup();
    expect(() =>
      proc.processHubTx(
        [
          { type: 'L1Deposit', leafIndex: 0, commitment: 7n, amount: 1n, depositor: '0x', encNote: new Uint8Array() },
          { type: 'LeavesInserted', firstLeafIndex: 0, count: 2n, newRoot: 123n },
        ],
        meta(1),
      ),
    ).toThrow(SyncError);
    const b = setup();
    b.proc.processHubTx([{ type: 'NewCommitment', commitment: 1n, leafIndex: 0, enc: new Uint8Array() }], meta(1));
    expect(() => b.proc.processHubTx([{ type: 'NewCommitment', commitment: 2n, leafIndex: 0, enc: new Uint8Array() }], meta(2))).toThrow(SyncError);
    expect(() => b.proc.processHubTx([{ type: 'NewCommitment', commitment: 1n, leafIndex: 2 ** 24, enc: new Uint8Array() }], meta(3))).toThrow(SyncError);
  });

  it('marks spent notes from NewNullifier and change notes inherit funding', () => {
    const { store, view, proc } = setup();
    const n = createNote(10_000_000n, TEST_KEYS.pk);
    const C = commitment(n);
    proc.processHubTx(
      [{ type: 'L1Deposit', leafIndex: 0, commitment: C, amount: n.amount, depositor: '0x', encNote: encryptNote(TEST_KEYS.encPk, { amount: n.amount, blinding: n.blinding }) },
       { type: 'NewCommitment', commitment: 9n, leafIndex: 1, enc: new Uint8Array() }],
      meta(1, 100),
    );
    const change = createNote(4_000_000n, TEST_KEYS.pk);
    const dummyKp = randomX25519KeyPair();
    proc.processHubTx(
      [
        { type: 'NewCommitment', commitment: commitment(change), leafIndex: 2, enc: encryptNote(TEST_KEYS.encPk, { amount: change.amount, blinding: change.blinding }) },
        { type: 'NewCommitment', commitment: 77n, leafIndex: 3, enc: encryptNote(dummyKp.publicKey, { amount: 0n, blinding: 1n }) },
        { type: 'NewNullifier', nullifier: nullifier(TEST_KEYS.sk, C, 0) },
        { type: 'NewNullifier', nullifier: randomField() },
      ],
      meta(2, 9999),
    );
    expect(view.tree.size).toBe(4);
    const all = store.list({ includeSpent: true });
    expect(all.find((x) => x.leafIndex === 0)!.spent).toBe(true);
    const c = store.list()[0]!;
    expect(c.leafIndex).toBe(2);
    expect(c.source).toBe('spend-output');
    expect(c.fundedAt).toBe(100);
    expect(c.fundingAmounts).toEqual([10_000_000n]);
    expect(store.balance()).toBe(4_000_000n);
    expect(view.isSpent(nullifier(TEST_KEYS.sk, C, 0))).toBe(true);
  });

  it('joins L2 deposits by chain+index in either order', () => {
    for (const order of ['spokeFirst', 'hubFirst'] as const) {
      const { store, proc, view } = setup();
      const n = createNote(2_000_000n, TEST_KEYS.pk);
      const Pd = ownerDigest(n.pk, n.blinding);
      const C = commitment(n);
      const spoke = () =>
        proc.processSpokeEvent(BASE, { type: 'Deposit', index: 4n, ownerDigest: Pd, amount: n.amount, fee: 0n, l2Block: 9n, encNote: encryptNote(TEST_KEYS.encPk, { amount: n.amount, blinding: n.blinding }) }, meta(10, 777));
      const hub = () =>
        proc.processHubTx([{ type: 'L2DepositInserted', srcChainId: BigInt(BASE), index: 4n, commitment: C, leafIndex: 0, fastLane: true }], meta(11, 900));
      if (order === 'spokeFirst') {
        spoke();
        expect(store.pending()).toHaveLength(1);
        expect(store.list()).toHaveLength(0);
        hub();
      } else {
        hub();
        spoke();
      }
      expect(store.pending()).toHaveLength(0);
      const owned = store.list();
      expect(owned).toHaveLength(1);
      expect(owned[0]!.originChainId).toBe(BASE);
      expect(owned[0]!.fundedAt).toBe(777);
      expect(view.state.deposits[0]!.amount).toBe(2_000_000n);
    }
  });

  it('ignores an L2 deposit whose hub commitment does not match', () => {
    const { store, proc } = setup();
    const n = createNote(2_000_000n, TEST_KEYS.pk);
    proc.processSpokeEvent(BASE, { type: 'Deposit', index: 0n, ownerDigest: ownerDigest(n.pk, n.blinding), amount: n.amount, fee: 0n, l2Block: 1n, encNote: encryptNote(TEST_KEYS.encPk, { amount: n.amount, blinding: n.blinding }) }, meta(1));
    proc.processHubTx([{ type: 'L2DepositInserted', srcChainId: BigInt(BASE), index: 0n, commitment: 555n, leafIndex: 0, fastLane: false }], meta(2));
    expect(store.list()).toHaveLength(0);
  });

  it('tracks release status across hub and spoke', () => {
    const { proc, view } = setup();
    proc.processSpokeEvent(BASE, { type: 'ReleaseQueued', index: 0n }, meta(1));
    proc.processHubTx([{ type: 'ReleaseLogged', dstChainId: BigInt(BASE), index: 0n, recipient: '0xr', amount: 5n, spendId: '0xs' }], meta(2));
    expect(view.state.releases[`${BASE}:0`]!.status).toBe('queued');
    proc.processSpokeEvent(BASE, { type: 'ReleaseExecuted', index: 0n }, meta(3));
    expect(view.state.releases[`${BASE}:0`]!.status).toBe('executed');
    proc.processSpokeEvent(BASE, { type: 'ReleaseFailed', index: 0n }, meta(4));
    expect(view.state.releases[`${BASE}:0`]!.status).toBe('executed');
  });

  it('state round-trips through the tagged codec and rebuilds the same tree', () => {
    const { proc, view } = setup();
    for (let i = 0; i < 6; i++) proc.processHubTx([{ type: 'NewCommitment', commitment: BigInt(i + 1), leafIndex: i, enc: new Uint8Array() }], meta(i));
    const back = new ChainView(parseTagged<SyncState>(stringifyTagged(view.state)));
    expect(back.tree.root()).toBe(view.tree.root());
  });
});

describe('log decoding', () => {
  it('maps viem logs to events', () => {
    expect(toHubEvent({ eventName: 'NewCommitment', args: { commitment: 5n, leafIndex: 3, encryptedOutput: '0x0102' } })).toEqual({
      type: 'NewCommitment', commitment: 5n, leafIndex: 3, enc: new Uint8Array([1, 2]),
    });
    expect(toSpokeEvent({ eventName: 'ReleaseFailed', args: { index: 2n } })).toEqual({ type: 'ReleaseFailed', index: 2n });
    expect(toHubEvent({ eventName: 'Other', args: {} })).toBeUndefined();
  });
  it('interpolates timestamps inside a page', () => {
    expect(interpolateTime({ fromBlock: 0n, toBlock: 10n, fromTime: 100, toTime: 200 }, 5n)).toBe(150);
    expect(interpolateTime({ fromBlock: 3n, toBlock: 3n, fromTime: 100, toTime: 200 }, 3n)).toBe(200);
  });
});
