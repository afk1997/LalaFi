import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P } from '../src/constants.js';
import { H1, H2, H3 } from '../src/crypto/poseidon.js';
import { encryptNote, randomX25519KeyPair } from '../src/crypto/box.js';
import { randomField } from '../src/crypto/field.js';
import {
  commitment, createNote, nullifier, ownerDigest, signature, tryAcceptForCommitment, tryAcceptForDeposit,
  NoteStore, EncryptedStore, encryptJson, decryptJson, VaultError, stringifyTagged, parseTagged, type OwnedNote,
} from '../src/notes/index.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('note math (PRD 5.4/5.5)', () => {
  const sk = randomField();
  const pk = H1(sk);
  const note = createNote(1234n, pk);

  it('P, C, sigma, N follow the spec', () => {
    const Pd = H2(pk, note.blinding);
    expect(ownerDigest(pk, note.blinding)).toBe(Pd);
    const C = H3(1234n, 1n, Pd);
    expect(commitment(note)).toBe(C);
    const sig = H3(sk, C, 7n);
    expect(signature(sk, C, 7)).toBe(sig);
    expect(nullifier(sk, C, 7)).toBe(H3(C, 7n, sig));
  });

  it('nullifier is position-bound', () => {
    const C = commitment(note);
    expect(nullifier(sk, C, 0)).not.toBe(nullifier(sk, C, 2));
  });

  it('rejects bad domains', () => {
    expect(() => createNote(1n << 248n, pk)).toThrow();
    expect(() => createNote(-1n, pk)).toThrow();
    expect(() => createNote(1n, P)).toThrow();
    expect(() => nullifier(sk, 1n, 2 ** 24)).toThrow();
  });
});

describe('validate-before-accept', () => {
  const sk = randomField();
  const pk = H1(sk);
  const kp = randomX25519KeyPair();
  const ctx = { pk, encSk: kp.secretKey };
  const note = createNote(500n, pk);
  const C = commitment(note);

  it('accepts a matching ciphertext', () => {
    const blob = encryptNote(kp.publicKey, { amount: 500n, blinding: note.blinding });
    expect(tryAcceptForCommitment(ctx, blob, C)).toEqual(note);
  });

  it('ignores a decryptable ciphertext whose contents do not match the commitment', () => {
    const lie = encryptNote(kp.publicKey, { amount: 5_000_000n, blinding: note.blinding });
    expect(tryAcceptForCommitment(ctx, lie, C)).toBeNull();
    expect(tryAcceptForCommitment(ctx, encryptNote(kp.publicKey, { amount: 500n, blinding: note.blinding }), C + 1n)).toBeNull();
  });

  it('checks digest and amount for L2 deposits', () => {
    const blob = encryptNote(kp.publicKey, { amount: 500n, blinding: note.blinding });
    const Pd = ownerDigest(pk, note.blinding);
    expect(tryAcceptForDeposit(ctx, blob, Pd, 500n)).toEqual(note);
    expect(tryAcceptForDeposit(ctx, blob, Pd, 501n)).toBeNull();
    expect(tryAcceptForDeposit(ctx, blob, Pd + 1n, 500n)).toBeNull();
    expect(tryAcceptForDeposit(ctx, blob, P, 500n)).toBeNull();
  });
});

describe('vault', () => {
  it('tagged JSON round-trips bigint, bytes and $-strings', () => {
    const v = { a: 1n << 200n, b: new Uint8Array([1, 2, 3]), s: '$n:5', n: [P - 1n] };
    expect(parseTagged(stringifyTagged(v))).toEqual(v);
  });

  it('encrypts, rejects wrong password and tampering', () => {
    const ct = encryptJson({ secret: 'words', n: 5n }, 'pw', FAST);
    expect(ct).not.toContain('words');
    expect(decryptJson(ct, 'pw')).toEqual({ secret: 'words', n: 5n });
    expect(() => decryptJson(ct, 'wrong')).toThrow(VaultError);
    const env = JSON.parse(ct);
    env.ct = (env.ct[0] === '0' ? '1' : '0') + env.ct.slice(1);
    expect(() => decryptJson(JSON.stringify(env), 'pw')).toThrow(VaultError);
    expect(() => encryptJson({}, '', FAST)).toThrow(VaultError);
  });
});

describe('NoteStore', () => {
  const sample = (leafIndex: number, amount: bigint): OwnedNote => ({
    amount, pk: 5n, blinding: 6n, commitment: BigInt(leafIndex + 100), leafIndex, nullifier: BigInt(leafIndex + 1000),
    source: 'l1-deposit', originChainId: 31337, fundedAt: 1, fundingLeaf: leafIndex, fundingAmounts: [amount], spent: false,
  });

  it('persists encrypted, 0600, and reopens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpool-store-'));
    const s = NoteStore.create(dir, 'hunter2', 0, FAST);
    s.upsert(sample(4, 10n));
    s.upsert(sample(2, 20n));
    s.save();
    const raw = readFileSync(NoteStore.path(dir), 'utf8');
    expect(raw).not.toContain('l1-deposit');
    expect(statSync(NoteStore.path(dir)).mode & 0o777).toBe(0o600);
    s.close();

    const r = NoteStore.open(dir, 'hunter2');
    expect(r.list().map((n) => n.leafIndex)).toEqual([2, 4]);
    expect(r.balance()).toBe(30n);
    expect(r.applyNullifiers((n) => n === 1004n)).toBe(1);
    expect(r.balance()).toBe(20n);
    expect(r.list({ includeSpent: true })).toHaveLength(2);
    expect(() => NoteStore.open(dir, 'nope')).toThrow(VaultError);
    expect(() => NoteStore.create(dir, 'x', 0, FAST)).toThrow(VaultError);
  });

  it('upsert keeps spent flag and pending deposits are keyed by chain+index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpool-store-'));
    const s = NoteStore.create(dir, 'pw', 0, FAST);
    s.upsert(sample(0, 1n));
    s.markSpent([1000n], '0xabc');
    expect(s.upsert(sample(0, 1n))).toBe(false);
    expect(s.list()).toHaveLength(0);
    s.addPending({ chainId: 1, index: 3, amount: 1n, blinding: 2n, pk: 3n, commitment: 4n, fundedAt: 0 });
    s.addPending({ chainId: 1, index: 3, amount: 1n, blinding: 2n, pk: 3n, commitment: 4n, fundedAt: 0 });
    expect(s.pending()).toHaveLength(1);
    expect(s.takePending(2, 3)).toBeUndefined();
    expect(s.takePending(1, 3)?.commitment).toBe(4n);
  });

  it('rejects a store file swapped for a different vault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpool-store-'));
    writeFileSync(NoteStore.path(dir), encryptJson({ version: 2 }, 'pw', FAST));
    expect(() => NoteStore.open(dir, 'pw')).toThrow(VaultError);
    expect(EncryptedStore.exists(NoteStore.path(dir))).toBe(true);
  });
});
