import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CrossCheckError,
  createLogger,
  depositBatchDigest,
  depositBatchTypedData,
  openDatabase,
  type DepositBatch,
  type L2Deposit,
  type ProtocolContext,
} from '@xpool/service-common';
import { canCoSign } from '../src/attester.js';
import { defaultAllocations, parseAllocations } from '../src/bootstrap.js';
import type { ChainView, SignerInfo } from '../src/chain-view.js';
import { DepositConflict, DepositStore } from '../src/deposit-store.js';
import { epochDue } from '../src/epoch-keeper.js';
import { AttestationVerifier, ingest } from '../src/gossip.js';
import { GossipStore } from '../src/gossip-store.js';
import { designatedRank } from '../src/submitter.js';
import { reconcileRpcViews } from '../src/watcher.js';
import { auditBatch } from '../src/watchtower.js';
import { parsePost, toWire } from '../src/wire.js';

const SPOKE = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const eip = { hubChainId: 31337n, depositManager: getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3') };
const d = (index: number, over: Partial<L2Deposit> = {}): L2Deposit => ({ index: BigInt(index), ownerDigest: 7n, amount: 1_000_000n, fee: 0n, l2Block: 50n + BigInt(index), ...over });
const batch = (deps: L2Deposit[], epoch = 1n): DepositBatch => ({ srcChainId: 31338n, spoke: SPOKE, epoch, deposits: deps });
const k1 = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const k2 = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const sign = async (acct: typeof k1, b: DepositBatch) => ({ batch: b, signer: acct.address, signature: await acct.signTypedData(depositBatchTypedData(eip, b)) });

describe('watcher RPC reconciliation', () => {
  const v = (i: number, block = 60n) => ({ ...d(i), l2Block: block, blockNumber: block });
  it('accepts identical, contiguous, finalized views', () => {
    expect(reconcileRpcViews([[v(0), v(1)], [v(0), v(1)]], 0n, 100n)).toHaveLength(2);
    expect(reconcileRpcViews([[], []], 5n, 100n)).toHaveLength(0);
  });
  it('rejects any disagreement between RPCs', () => {
    expect(() => reconcileRpcViews([[v(0)], [{ ...v(0), amount: 2n }]], 0n, 100n)).toThrow(CrossCheckError);
    expect(() => reconcileRpcViews([[v(0), v(1)], [v(0)]], 0n, 100n)).toThrow(CrossCheckError);
  });
  it('rejects gaps and l2Block above finalized', () => {
    expect(() => reconcileRpcViews([[v(1)]], 0n, 100n)).toThrow(/contiguous/);
    expect(() => reconcileRpcViews([[v(0, 101n)]], 0n, 100n)).toThrow(/finalized/);
  });
});

describe('DepositStore', () => {
  it('appends contiguously, refuses changed content, persists cursor', () => {
    const s = new DepositStore(openDatabase(':memory:'));
    s.append(31338n, [{ ...d(0), blockNumber: 1n }, { ...d(1), blockNumber: 2n }], 10n);
    expect(s.cursor(31338n)).toBe(10n);
    expect(s.nextIndex(31338n)).toBe(2n);
    expect(s.range(31338n, 1n, 10).map((x) => x.index)).toEqual([1n]);
    expect(() => s.append(31338n, [{ ...d(3), blockNumber: 3n }], 11n)).toThrow(/gap/);
    expect(() => s.append(31338n, [{ ...d(1, { amount: 5n }), blockNumber: 2n }], 11n)).toThrow(DepositConflict);
    expect(s.cursor(31338n)).toBe(10n); // failed appends change nothing
  });
});

describe('gossip store + equivocation detection', () => {
  it('detects the same signer signing two contents for one index (across epochs)', async () => {
    const g = new GossipStore(openDatabase(':memory:'));
    const a = await sign(k1, batch([d(0), d(1)]));
    const b = await sign(k1, batch([d(1, { amount: 9n })], 2n));
    expect(g.add(a, depositBatchDigest(eip, a.batch)).equivocations).toEqual([]);
    const r = g.add(b, depositBatchDigest(eip, b.batch));
    expect(r.equivocations).toHaveLength(1);
    expect(r.equivocations[0]!.index).toBe(1n);
    expect(g.pendingEquivocations()).toHaveLength(1);
    // the same content again (different epoch) is NOT equivocation
    const c = await sign(k2, batch([d(1)], 3n));
    expect(g.add(c, depositBatchDigest(eip, c.batch)).equivocations).toEqual([]);
    // evidence survives pruning
    g.prune(31338n, 100n);
    const e = g.pendingEquivocations()[0]!;
    expect(g.get(e.digestA, e.signer)).toBeTruthy();
    expect(g.get(e.digestB, e.signer)).toBeTruthy();
  });

  it('groups signatures by digest and dedups', async () => {
    const g = new GossipStore(openDatabase(':memory:'));
    const b = batch([d(0)]);
    const digest = depositBatchDigest(eip, b);
    const a1 = await sign(k1, b);
    expect(g.add(a1, digest).isNew).toBe(true);
    expect(g.add(a1, digest).isNew).toBe(false);
    g.add(await sign(k2, b), digest);
    const groups = g.groups(31338n, [1n]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sigs).toHaveLength(2);
    expect(g.list(31338n, 0n)).toHaveLength(2);
    expect(g.list(31338n, 1n)).toHaveLength(0);
  });
});

describe('peer verification', () => {
  const ctx = { spokes: new Map([[31338, { cfg: { spoke: SPOKE } }]]) } as unknown as ProtocolContext;
  const view = (registered: Address[]) =>
    ({ signerInfo: async (s: Address): Promise<SignerInfo> => ({ id: 1, registered: registered.includes(s), active: true, jailed: false }) }) as unknown as ChainView;

  it('accepts valid, rejects forged / unknown / wrong-spoke / malformed', async () => {
    const v = new AttestationVerifier(ctx, eip, view([k1.address]));
    const good = await sign(k1, batch([d(0)]));
    expect((await v.verify(good)).ok).toBe(true);
    expect(await v.verify({ ...good, signer: k2.address })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await v.verify(await sign(k2, batch([d(0)])))).toEqual({ ok: false, reason: 'unknown_signer' });
    expect(await v.verify({ ...good, batch: { ...good.batch, spoke: k1.address } })).toEqual({ ok: false, reason: 'wrong_spoke' });
    expect(await v.verify({ ...good, batch: { ...good.batch, srcChainId: 1n } })).toEqual({ ok: false, reason: 'unknown_chain' });
    expect(await v.verify({ ...good, batch: { ...good.batch, deposits: [d(2), d(1)] } })).toEqual({ ok: false, reason: 'bad_shape' });
    // tampered content → signature no longer recovers to signer
    expect(await v.verify({ ...good, batch: { ...good.batch, deposits: [d(0, { amount: 5n })] } })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('ingest stores only verified attestations and reports equivocation', async () => {
    const store = new GossipStore(openDatabase(':memory:'));
    const seen: unknown[] = [];
    const deps = { verifier: new AttestationVerifier(ctx, eip, view([k1.address])), store, logger: createLogger('t', { write: () => {} }), onEquivocation: (e: unknown) => seen.push(e) };
    const r = await ingest([await sign(k1, batch([d(0)])), await sign(k2, batch([d(0)])), await sign(k1, batch([d(0, { fee: 1n })], 2n))], deps);
    expect(r).toEqual({ accepted: 2, duplicate: 0, rejected: { unknown_signer: 1 } });
    expect(seen).toHaveLength(1);
  });

  it('wire format round-trips and is strict', async () => {
    const a = await sign(k1, batch([d(0), d(1)]));
    const w = toWire(a);
    expect(parsePost(JSON.parse(JSON.stringify(w)))![0]).toEqual(a);
    expect(parsePost({ attestations: [w, w] })).toHaveLength(2);
    expect(parsePost({ ...w, extra: 1 })).toBeNull();
    expect(parsePost({ ...w, deposits: [] })).toBeNull();
    expect(parsePost({ ...w, signature: '0x12' })).toBeNull();
    expect(parsePost({ ...w, epoch: '-1' })).toBeNull();
  });
});

describe('co-signing policy', () => {
  const verified = new Map([0, 1, 2].map((i) => [BigInt(i), d(i)]));
  const get = (i: bigint) => verified.get(i);
  const policy = { minDeposit: 1n, maxFastDeposit: 10_000_000n, maxBatchValue: 10_000_000n };
  it('co-signs only exact matches of our finalized view', () => {
    expect(canCoSign(batch([d(0), d(1)]), get, new Set(), policy)).toBe(true);
    expect(canCoSign(batch([d(0), d(1, { l2Block: 1n })]), get, new Set(), policy)).toBe(false);
    expect(canCoSign(batch([d(3)]), get, new Set(), policy)).toBe(false); // not finalized/known
    expect(canCoSign(batch([d(0)]), get, new Set([0n]), policy)).toBe(false); // already inserted
    expect(canCoSign(batch([d(0), d(1)]), get, new Set(), { ...policy, maxBatchValue: 1_500_000n })).toBe(false);
    expect(canCoSign(batch([d(1), d(0)]), get, new Set(), policy)).toBe(false);
  });
});

describe('watchtower audit', () => {
  const verified = new Map([0, 1].map((i) => [BigInt(i), d(i)]));
  const get = (i: bigint) => verified.get(i);
  const ob = (deps: L2Deposit[]) => ({ batchId: 1n, chainId: 31338n, epoch: 1n, deposits: deps });
  it('ok / mismatch / absence / absence-pending', () => {
    expect(auditBatch(ob([d(0), d(1)]), get, 2n, [])).toEqual({ kind: 'ok' });
    expect(auditBatch(ob([d(0), d(1, { amount: 3n })]), get, 2n, [])).toEqual({ kind: 'mismatch', pos: 1 });
    const fake = d(5, { l2Block: 70n });
    expect(auditBatch(ob([d(0), fake]), get, 2n, [])).toEqual({ kind: 'absence-pending', pos: 1 });
    // checkpoint must have countAtSend <= index AND l2Block > claimed l2Block
    expect(auditBatch(ob([fake]), get, 2n, [{ seq: 3n, countAtSend: 2n, l2Block: 70n }])).toEqual({ kind: 'absence-pending', pos: 0 });
    expect(auditBatch(ob([fake]), get, 2n, [{ seq: 3n, countAtSend: 6n, l2Block: 90n }])).toEqual({ kind: 'absence-pending', pos: 0 });
    expect(auditBatch(ob([fake]), get, 2n, [{ seq: 4n, countAtSend: 2n, l2Block: 71n }])).toEqual({ kind: 'absence', pos: 0, seq: 4n });
  });
});

describe('misc', () => {
  it('designated submitter rank is deterministic and a permutation', () => {
    const signers = [k1.address, k2.address, '0x0000000000000000000000000000000000000003' as Address];
    const digest = '0x' + 'ab'.repeat(32);
    const ranks = signers.map((s) => designatedRank(digest as `0x${string}`, signers, s));
    expect([...ranks].sort()).toEqual([0, 1, 2]);
    expect(designatedRank(digest as `0x${string}`, [...signers].reverse(), k1.address)).toBe(ranks[0]);
    expect(designatedRank(digest as `0x${string}`, signers, '0x0000000000000000000000000000000000000009')).toBe(3);
  });
  it('epoch due', () => {
    expect(epochDue(100n, 120n, 219n)).toBe(false);
    expect(epochDue(100n, 120n, 220n)).toBe(true);
  });
  it('allocations parsing', () => {
    expect(parseAllocations('31338:5,31339:6')).toEqual(new Map([[31338n, 5n], [31339n, 6n]]));
    expect(() => parseAllocations('31338=5')).toThrow();
    expect(defaultAllocations(10n, [31338, 31339])).toEqual(new Map([[31338n, 5n], [31339n, 5n]]));
  });
});
