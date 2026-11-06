import { describe, expect, it } from 'vitest';
import { concatHex, keccak256, numberToHex, padHex, size, sliceHex, zeroAddress, type Hex } from 'viem';
import { P } from '../src/constants.js';
import { H1, H3, H2 } from '../src/crypto/poseidon.js';
import { decryptNote } from '../src/crypto/box.js';
import { randomField } from '../src/crypto/field.js';
import { MerkleTree, verifyPath } from '../src/tree/merkle.js';
import { commitment, nullifier } from '../src/notes/note.js';
import { encodeAddress, decodeAddress } from '../src/keys/address.js';
import { deriveKeys } from '../src/keys/derive.js';
import { mnemonicToSeed, generateMnemonic } from '../src/keys/mnemonic.js';
import {
  encodeExtData, extDataHash, makeExtData, validateExtData, ExtDataError, type ExtData,
  ceilDiv, protocolFee, roundUpToBucket, isBucketMultiple, publicAmount, totalOut, maxWithdrawable,
  selectInputs, SelectionError, dummyInput, dummyOutput,
  buildWithdraw, buildTransfer, buildMerge, buildFeeOnly, pickMergePair, spendIdOf, type SpendContext,
  jitteredDeadline, randomSubmissionDelayMs,
} from '../src/tx/index.js';
import { TEST_KEYS, ownedNoteInTree } from './helpers.js';

const HUB = '0x1111111111111111111111111111111111111111' as const;
const RELAYER = '0x2222222222222222222222222222222222222222' as const;
const RECIP = '0x3333333333333333333333333333333333333333' as const;

const baseExt = (o: Partial<ExtData> = {}): ExtData =>
  makeExtData({
    hubChainId: 31337n, hub: HUB, dstChainId: 0n, recipient: zeroAddress, withdrawAmount: 0n,
    relayer: RELAYER, relayerFee: 10_000n, protocolFee: 0n, deadline: 1_900_000_000n, encOut0: '0x', encOut1: '0x', ...o,
  });

const word = (x: bigint | number | string): Hex =>
  typeof x === 'string' ? padHex(x as Hex, { size: 32 }) : numberToHex(BigInt(x), { size: 32 });

/** Independent manual abi.encode of the dynamic ExtData tuple. */
function manualEncode(e: ExtData): Hex {
  const data = (b: Hex): Hex => {
    const len = size(b);
    const padded = len === 0 ? '0x' : padHex(b, { size: Math.ceil(len / 32) * 32, dir: 'right' });
    return concatHex([word(len), padded as Hex]);
  };
  const d0 = data(e.encOut0);
  const d1 = data(e.encOut1);
  const off0 = 12 * 32;
  const off1 = off0 + size(d0);
  return concatHex([
    word(0x20),
    word(e.version), word(e.hubChainId), word(e.hub), word(e.dstChainId), word(e.recipient), word(e.withdrawAmount),
    word(e.relayer), word(e.relayerFee), word(e.protocolFee), word(e.deadline), word(off0), word(off1), d0, d1,
  ]);
}

describe('ExtData encoding and extDataHash', () => {
  it('raw abi layout: leading 0x20 offset, 12 head words, tails', () => {
    const e = baseExt({ encOut0: `0x${'ab'.repeat(137)}`, encOut1: `0x${'cd'.repeat(137)}` });
    const enc = encodeExtData(e);
    expect(enc).toBe(manualEncode(e));
    expect(sliceHex(enc, 0, 32)).toBe(word(0x20));
    const headWord = (k: number): bigint => BigInt(sliceHex(enc, 32 + k * 32, 64 + k * 32));
    expect(headWord(0)).toBe(1n); // version
    expect(headWord(1)).toBe(31337n); // hubChainId
    expect(headWord(9)).toBe(1_900_000_000n); // deadline
    expect(headWord(10)).toBe(BigInt(12 * 32)); // offset encOut0 (relative to tuple start)
    expect(headWord(11)).toBe(BigInt(12 * 32 + 32 + 160)); // offset encOut1
    expect(headWord(12)).toBe(137n); // len(encOut0)
    expect(BigInt(sliceHex(enc, 32 + 13 * 32 + 160, 64 + 13 * 32 + 160))).toBe(137n); // len(encOut1)
    expect(size(enc)).toBe(32 + 12 * 32 + 2 * (32 + 160));
  });

  it('empty and 256-byte encOuts', () => {
    for (const e of [baseExt(), baseExt({ encOut0: `0x${'ff'.repeat(256)}`, encOut1: `0x${'01'.repeat(256)}` })]) {
      expect(encodeExtData(e)).toBe(manualEncode(e));
      expect(extDataHash(e)).toBe(BigInt(keccak256(manualEncode(e))) % P);
    }
    expect(size(encodeExtData(baseExt()))).toBe(32 + 12 * 32 + 64);
  });

  it('withdrawal ExtData hashes and binds every field', () => {
    const e = baseExt({ dstChainId: 31338n, recipient: RECIP, withdrawAmount: 100_000_000n, protocolFee: 100_000n });
    const h = extDataHash(e);
    expect(h).toBeLessThan(P);
    expect(extDataHash({ ...e, deadline: e.deadline + 1n })).not.toBe(h);
    expect(extDataHash({ ...e, recipient: RELAYER })).not.toBe(h);
  });

  it('validates shape and lengths', () => {
    expect(() => validateExtData(baseExt({ encOut0: `0x${'00'.repeat(257)}` }))).toThrow(ExtDataError);
    expect(() => validateExtData(baseExt({ recipient: RECIP }))).toThrow(/dstChainId = 0/);
    expect(() => validateExtData(baseExt({ dstChainId: 1n }))).toThrow(/recipient/);
    expect(() => validateExtData(baseExt({ relayer: zeroAddress }))).toThrow(/relayer/);
    expect(() => validateExtData(baseExt({ deadline: 1n << 64n }))).toThrow(/deadline/);
    expect(() => validateExtData(baseExt({ encOut0: '0xabc' as Hex }))).toThrow(ExtDataError);
  });
});

describe('fee math', () => {
  it('ceilDiv / protocolFee edges', () => {
    expect(ceilDiv(0n, 7n)).toBe(0n);
    expect(ceilDiv(1n, 7n)).toBe(1n);
    expect(ceilDiv(7n, 7n)).toBe(1n);
    expect(ceilDiv(8n, 7n)).toBe(2n);
    expect(protocolFee(0n, 10n)).toBe(0n);
    expect(protocolFee(1n, 10n)).toBe(1n); // ceil(10 / 1e4) = 1
    expect(protocolFee(1000n, 10n)).toBe(1n);
    expect(protocolFee(1001n, 10n)).toBe(2n);
    expect(protocolFee(1_000_000_000n, 10n)).toBe(1_000_000n);
    expect(protocolFee(5n, 0n)).toBe(0n);
  });
  it('bucket rounding', () => {
    expect(roundUpToBucket(0n, 10_000n)).toBe(0n);
    expect(roundUpToBucket(1n, 10_000n)).toBe(10_000n);
    expect(roundUpToBucket(10_000n, 10_000n)).toBe(10_000n);
    expect(roundUpToBucket(10_001n, 10_000n)).toBe(20_000n);
    expect(isBucketMultiple(30_000n, 10_000n)).toBe(true);
    expect(isBucketMultiple(30_001n, 10_000n)).toBe(false);
    expect(() => roundUpToBucket(1n, 0n)).toThrow();
  });
  it('publicAmount and v bounds', () => {
    expect(publicAmount(0n)).toBe(0n);
    expect(publicAmount(1n)).toBe(P - 1n);
    expect(publicAmount((1n << 248n) - 1n)).toBe(P - (1n << 248n) + 1n);
    expect(() => publicAmount(1n << 248n)).toThrow();
    expect(totalOut(100n, 10n, 1n)).toBe(111n);
    expect(() => totalOut(1n << 248n, 0n, 0n)).toThrow();
  });
  it('maxWithdrawable is tight', () => {
    for (const avail of [1_000_000n, 1_234_567_891n, 10n, 10_001n]) {
      const w = maxWithdrawable(avail, 10_000n, 10n);
      if (w > 0n) expect(w + protocolFee(w, 10n) + 10_000n).toBeLessThanOrEqual(avail);
      expect(w + 1n + protocolFee(w + 1n, 10n) + 10_000n).toBeGreaterThan(avail);
    }
  });
});

describe('deadline jitter', () => {
  it('falls inside the window and varies', () => {
    const now = 1_800_000_000;
    const set = new Set<bigint>();
    for (let i = 0; i < 30; i++) {
      const d = jitteredDeadline({ nowSec: now });
      expect(d).toBeGreaterThanOrEqual(BigInt(now + 1200));
      expect(d).toBeLessThanOrEqual(BigInt(now + 3600));
      set.add(d);
    }
    expect(set.size).toBeGreaterThan(1);
    const r = randomSubmissionDelayMs(1000, 10);
    expect(r).toBeGreaterThanOrEqual(10);
    expect(r).toBeLessThanOrEqual(1000);
  });
});

describe('input selection and dummies', () => {
  const tree = new MerkleTree();
  const notes = [10n, 30n, 50n, 70n].map((a) => ownedNoteInTree(tree, a));

  it('prefers the smallest covering single note, then the tightest pair', () => {
    expect(selectInputs(notes, 25n).map((n) => n.amount)).toEqual([30n]);
    expect(selectInputs(notes, 70n).map((n) => n.amount)).toEqual([70n]);
    expect(selectInputs(notes, 75n).map((n) => n.amount).sort()).toEqual([10n, 70n].sort());
    expect(selectInputs(notes, 120n).map((n) => n.amount).sort()).toEqual([50n, 70n].sort());
  });
  it('signals merge-needed vs insufficient', () => {
    try {
      selectInputs(notes, 150n);
      expect.unreachable();
    } catch (e) {
      expect((e as SelectionError).needsMerge).toBe(true);
    }
    expect(() => selectInputs(notes, 1000n)).toThrow(/insufficient/);
    expect(() => selectInputs([{ ...notes[0]!, spent: true }], 1n)).toThrow(/insufficient/);
  });
  it('dummy inputs are fresh, zero-valued and consistent', () => {
    const a = dummyInput();
    const b = dummyInput();
    expect(a.amount).toBe(0n);
    expect(a.sk).not.toBe(b.sk);
    expect(a.nullifier).not.toBe(b.nullifier);
    expect(a.commitment).toBe(H3(0n, 1n, H2(H1(a.sk), a.blinding)));
    expect(a.nullifier).toBe(nullifier(a.sk, a.commitment, 0));
  });
  it('dummy outputs are 137-byte ciphertexts not decryptable by the wallet', () => {
    const o = dummyOutput();
    expect(o.amount).toBe(0n);
    expect(o.encrypted.length).toBe(137);
    expect(decryptNote(TEST_KEYS.encSk, o.encrypted)).toBeNull();
    expect(o.commitment).toBe(commitment(o));
  });
});

describe('spend builders (PRD 6.4)', () => {
  const tree = new MerkleTree();
  const n1000 = ownedNoteInTree(tree, 1_000_000_000n);
  const n400 = ownedNoteInTree(tree, 400_000_000n);
  const n600 = ownedNoteInTree(tree, 600_000_000n);
  const ctx: SpendContext = {
    keys: TEST_KEYS, tree, hubChainId: 31337n, hub: HUB, phiBps: 10n, relayerFeeBucket: 10_000n, minWithdraw: 1_000_000n,
  };
  const fees = { relayer: RELAYER, relayerFee: 50_000n };
  const bob = deriveKeys(mnemonicToSeed(generateMnemonic()), 0);
  const bobAddr = decodeAddress(encodeAddress('lxpool', bob.pk, bob.encPk));

  const checkCommon = (s: ReturnType<typeof buildWithdraw>): void => {
    // publicAmount, hash, sums
    expect(s.publicInputs.publicAmount).toBe(publicAmount(s.v));
    expect(s.publicInputs.extDataHash).toBe(extDataHash(s.extData));
    const sumIn = s.inputs.reduce((a, i) => a + i.amount, 0n);
    const sumOut = s.outputs.reduce((a, o) => a + o.amount, 0n);
    expect((sumIn + s.publicInputs.publicAmount) % P).toBe(sumOut % P);
    expect(s.inputs).toHaveLength(2);
    expect(s.outputs).toHaveLength(2);
    expect(s.publicInputs.inputNullifiers[0]).not.toBe(s.publicInputs.inputNullifiers[1]);
    for (const i of s.inputs) if (!i.dummy) expect(verifyPath(i.commitment, { leafIndex: i.leafIndex, pathElements: i.pathElements, pathIndices: [], root: tree.root() })).toBe(true);
    expect(s.outputs.map((o) => o.commitment)).toEqual(s.publicInputs.outputCommitments);
    expect(s.spendId).toBe(spendIdOf(...s.publicInputs.inputNullifiers));
    // witness names (PRD 6.2)
    expect(Object.keys(s.witness).sort()).toEqual(
      ['root', 'publicAmount', 'extDataHash', 'inputNullifier', 'outputCommitment', 'inAmount', 'inSk', 'inBlinding',
        'inLeafIndex', 'inPathElements', 'outAmount', 'outPk', 'outBlinding'].sort(),
    );
    expect(s.witness.inPathElements[0]).toHaveLength(24);
    expect(s.extData.encOut0.length).toBe(2 + 137 * 2);
  };

  it('full withdrawal: note + dummy -> 0 + 0', () => {
    const w = maxWithdrawable(n1000.amount, fees.relayerFee, 10n);
    const s = buildWithdraw(ctx, { notes: [n1000], dstChainId: 31338n, recipient: RECIP, fees, inputs: [n1000], amount: w });
    checkCommon(s);
    expect(s.kind).toBe('withdraw');
    expect(s.outputs.every((o) => o.role === 'dummy')).toBe(true);
    expect(s.inputs.filter((i) => i.dummy)).toHaveLength(1);
    expect(s.extData.protocolFee).toBe(protocolFee(w, 10n));
  });

  it('partial withdrawal: change to self (decryptable), dummy second output', () => {
    const s = buildWithdraw(ctx, { notes: [n1000, n400, n600], dstChainId: 31337n, recipient: RECIP, amount: 100_000_000n, fees });
    checkCommon(s);
    expect(s.kind).toBe('partial');
    const change = s.outputs.find((o) => o.role === 'change')!;
    expect(change.amount).toBe(400_000_000n - 100_000_000n - 50_000n - 100_000n);
    expect(decryptNote(TEST_KEYS.encSk, change.encrypted)).toEqual({ amount: change.amount, blinding: change.blinding });
    expect(s.v).toBe(100_000_000n + 50_000n + 100_000n);
  });

  it('transfer: recipient note for Bob + change, no protocol fee', () => {
    const s = buildTransfer(ctx, { notes: [n1000], to: bobAddr, amount: 300_000_000n, fees });
    checkCommon(s);
    expect(s.extData.dstChainId).toBe(0n);
    expect(s.extData.protocolFee).toBe(0n);
    expect(s.v).toBe(50_000n);
    const r = s.outputs.find((o) => o.role === 'recipient')!;
    expect(decryptNote(bob.encSk, r.encrypted)?.amount).toBe(300_000_000n);
    expect(r.pk).toBe(bob.pk);
    expect(s.outputs.find((o) => o.role === 'change')!.amount).toBe(700_000_000n - 50_000n);
  });

  it('merge: two notes -> one note + 0; sponsored fee gives publicAmount 0', () => {
    const pair = pickMergePair([n1000, n400, n600])!;
    expect(pair.map((n) => n.amount)).toEqual([400_000_000n, 600_000_000n]);
    const s = buildMerge(ctx, pair, { relayer: zeroAddress, relayerFee: 0n });
    checkCommon(s);
    expect(s.publicInputs.publicAmount).toBe(0n);
    expect(s.inputs.every((i) => !i.dummy)).toBe(true);
    expect(s.outputs.find((o) => o.role === 'change')!.amount).toBe(1_000_000_000n);
  });

  it('fee-only: note(x) + dummy -> note(x - f) + 0', () => {
    const s = buildFeeOnly(ctx, n400, fees);
    checkCommon(s);
    expect(s.publicInputs.publicAmount).toBe(P - 50_000n);
  });

  it('rejects unbucketed fees, below-min withdrawals, spent or foreign notes', () => {
    expect(() => buildFeeOnly(ctx, n400, { relayer: RELAYER, relayerFee: 12_345n })).toThrow(/bucket/);
    expect(() => buildWithdraw(ctx, { notes: [n1000], dstChainId: 31338n, recipient: RECIP, amount: 10n, fees })).toThrow(/minWithdraw/);
    expect(() => buildFeeOnly(ctx, { ...n400, spent: true }, fees)).toThrow(/spent/);
    expect(() => buildFeeOnly(ctx, { ...n400, blinding: randomField() }, fees)).toThrow(/corrupt/);
    expect(() => buildFeeOnly(ctx, { ...n400, leafIndex: n400.leafIndex + 1 }, fees)).toThrow();
  });
});
