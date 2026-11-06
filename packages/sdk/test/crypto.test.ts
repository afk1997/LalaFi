import { describe, expect, it, beforeAll } from 'vitest';
import { buildPoseidon, type CircomPoseidon } from 'circomlibjs';
import { P } from '../src/constants.js';
import {
  H1, H2, H3, mod, isField, assertField, bigintToBytes, bytesToBigint, randomField, parseField,
  encryptNote, decryptNote, randomX25519KeyPair, clampX25519, x25519PublicKey, sealNoteWith,
  ENC_NOTE_LEN, randomBytes, randomInt, shuffle,
} from '../src/crypto/index.js';

let circom: CircomPoseidon;
const ref = (xs: bigint[]): bigint => circom.F.toObject(circom(xs));

beforeAll(async () => {
  circom = await buildPoseidon();
});

describe('poseidon', () => {
  const edges = [0n, 1n, P - 1n, (1n << 248n) - 1n];

  it('matches circomlibjs on edge cases', () => {
    for (const a of edges) {
      expect(H1(a)).toBe(ref([a]));
      for (const b of edges) {
        expect(H2(a, b)).toBe(ref([a, b]));
        for (const c of edges) expect(H3(a, b, c)).toBe(ref([a, b, c]));
      }
    }
  });

  it('matches circomlibjs on 300 random inputs per arity', () => {
    for (let i = 0; i < 300; i++) {
      const [a, b, c] = [randomField(), randomField(), randomField()];
      expect(H1(a)).toBe(ref([a]));
      expect(H2(a, b)).toBe(ref([a, b]));
      expect(H3(a, b, c)).toBe(ref([a, b, c]));
    }
  });

  it('rejects non-field inputs instead of reducing', () => {
    expect(() => H1(P)).toThrow();
    expect(() => H2(0n, -1n)).toThrow();
    expect(() => H3(0n, 0n, P + 5n)).toThrow();
  });
});

describe('field helpers', () => {
  it('mod / isField / assertField', () => {
    expect(mod(-1n)).toBe(P - 1n);
    expect(mod(P)).toBe(0n);
    expect(isField(P - 1n)).toBe(true);
    expect(isField(P)).toBe(false);
    expect(() => assertField(P)).toThrow();
  });
  it('bytes round-trip and overflow', () => {
    const x = P - 12345n;
    expect(bytesToBigint(bigintToBytes(x))).toBe(x);
    expect(() => bigintToBytes(1n << 256n)).toThrow();
    expect(bigintToBytes(1n, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
  });
  it('parseField validates', () => {
    expect(parseField('0x10')).toBe(16n);
    expect(() => parseField(P.toString())).toThrow();
    expect(() => parseField('12abc')).toThrow();
  });
  it('randomField is in range and varies', () => {
    const s = new Set<bigint>();
    for (let i = 0; i < 50; i++) {
      const r = randomField();
      expect(isField(r)).toBe(true);
      s.add(r);
    }
    expect(s.size).toBe(50);
  });
});

describe('random', () => {
  it('randomBytes length and large sizes', () => {
    expect(randomBytes(0).length).toBe(0);
    expect(randomBytes(70000).length).toBe(70000);
  });
  it('randomInt in range', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });
  it('shuffle is a permutation', () => {
    const a = [1, 2, 3, 4, 5, 6];
    expect([...shuffle([...a])].sort()).toEqual(a);
  });
});

describe('note encryption (PRD 5.8)', () => {
  const kp = randomX25519KeyPair();
  const note = { amount: 1_000_000_000n, blinding: randomField() };

  it('round-trips and is exactly 137 bytes with version 0x01', () => {
    const ct = encryptNote(kp.publicKey, note);
    expect(ct.length).toBe(ENC_NOTE_LEN);
    expect(ct.length).toBe(137);
    expect(ct[0]).toBe(0x01);
    expect(decryptNote(kp.secretKey, ct)).toEqual(note);
  });

  it('uses a fresh ephemeral key and nonce each time', () => {
    const a = encryptNote(kp.publicKey, note);
    const b = encryptNote(kp.publicKey, note);
    expect(Buffer.from(a.subarray(1, 57)).equals(Buffer.from(b.subarray(1, 57)))).toBe(false);
  });

  it('rejects wrong key', () => {
    const other = randomX25519KeyPair();
    expect(decryptNote(other.secretKey, encryptNote(kp.publicKey, note))).toBeNull();
  });

  it('rejects any single-byte tamper', () => {
    const ct = encryptNote(kp.publicKey, note);
    for (const pos of [0, 1, 20, 33, 50, 57, 80, 136]) {
      const t = Uint8Array.from(ct);
      t[pos]! ^= 0x01;
      expect(decryptNote(kp.secretKey, t)).toBeNull();
    }
  });

  it('rejects wrong lengths', () => {
    const ct = encryptNote(kp.publicKey, note);
    expect(decryptNote(kp.secretKey, ct.subarray(0, 136))).toBeNull();
    expect(decryptNote(kp.secretKey, new Uint8Array([...ct, 0]))).toBeNull();
    expect(decryptNote(kp.secretKey, new Uint8Array(0))).toBeNull();
  });

  it('refuses out-of-range plaintext values', () => {
    expect(() => encryptNote(kp.publicKey, { amount: 1n << 248n, blinding: 0n })).toThrow();
    expect(() => encryptNote(kp.publicKey, { amount: 0n, blinding: P })).toThrow();
  });

  it('deterministic seal matches NaCl box layout', () => {
    const esk = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(24).fill(9);
    const ct = sealNoteWith(kp.publicKey, note, esk, nonce);
    expect(Buffer.from(ct.subarray(1, 33))).toEqual(Buffer.from(x25519PublicKey(esk)));
    expect(Buffer.from(ct.subarray(33, 57))).toEqual(Buffer.from(nonce));
    expect(decryptNote(kp.secretKey, ct)).toEqual(note);
  });

  it('clamp follows RFC 7748', () => {
    const c = clampX25519(new Uint8Array(32).fill(0xff));
    expect(c[0]! & 7).toBe(0);
    expect(c[31]! & 0x80).toBe(0);
    expect(c[31]! & 0x40).toBe(0x40);
  });
});
