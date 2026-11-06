import { describe, expect, it } from 'vitest';
import { bech32, bech32m } from '@scure/base';
import { P } from '../src/constants.js';
import { H1 } from '../src/crypto/poseidon.js';
import { x25519PublicKey } from '../src/crypto/box.js';
import {
  generateMnemonic, isValidMnemonic, mnemonicToSeed, deriveKeys, deriveSpendKey,
  encodeAddress, decodeAddress, AddressError, freshWithdrawalAccount, freshWithdrawalAddress, freshPath,
} from '../src/keys/index.js';
import { bigintToBytes } from '../src/crypto/field.js';

/** TEST mnemonic (BIP-39 test vector). NEVER use with real funds. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('mnemonic', () => {
  it('generates valid 24-word mnemonics', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(isValidMnemonic(m)).toBe(true);
    expect(generateMnemonic()).not.toBe(m);
  });
  it('rejects 12-word and bad checksum mnemonics', () => {
    expect(isValidMnemonic('abandon '.repeat(11) + 'about')).toBe(false);
    expect(isValidMnemonic(TEST_MNEMONIC.replace(/art$/, 'abandon'))).toBe(false);
    expect(() => mnemonicToSeed('nope')).toThrow();
  });
  it('normalizes whitespace and case', () => {
    expect(mnemonicToSeed(`  ${TEST_MNEMONIC.toUpperCase().replace(/ /g, '   ')} `)).toEqual(mnemonicToSeed(TEST_MNEMONIC));
  });
});

describe('derivation (PRD 5.3)', () => {
  const seed = mnemonicToSeed(TEST_MNEMONIC);

  it('is deterministic and valid', () => {
    const a = deriveKeys(seed, 0);
    const b = deriveKeys(mnemonicToSeed(TEST_MNEMONIC), 0);
    expect(a.sk).toBe(b.sk);
    expect(a.sk).toBeGreaterThan(0n);
    expect(a.sk).toBeLessThan(P);
    expect(a.pk).toBe(H1(a.sk));
    expect(Buffer.from(a.encPk)).toEqual(Buffer.from(x25519PublicKey(a.encSk)));
    expect(a.encSk[0]! & 7).toBe(0);
  });

  it('accounts and passphrases separate keys', () => {
    const a0 = deriveKeys(seed, 0);
    const a1 = deriveKeys(seed, 1);
    const pp = deriveKeys(mnemonicToSeed(TEST_MNEMONIC, 'x'), 0);
    expect(a1.sk).not.toBe(a0.sk);
    expect(pp.sk).not.toBe(a0.sk);
    expect(Buffer.from(a1.encSk).equals(Buffer.from(a0.encSk))).toBe(false);
  });

  it('rejects bad seeds and accounts', () => {
    expect(() => deriveSpendKey(new Uint8Array(32))).toThrow();
    expect(() => deriveSpendKey(seed, -1)).toThrow();
    expect(() => deriveSpendKey(seed, 2 ** 32)).toThrow();
  });
});

describe('shielded address', () => {
  const k = deriveKeys(mnemonicToSeed(TEST_MNEMONIC), 0);

  it('round-trips for every hrp', () => {
    for (const hrp of ['xpool', 'txpool', 'lxpool']) {
      const addr = encodeAddress(hrp, k.pk, k.encPk);
      expect(addr.startsWith(`${hrp}1`)).toBe(true);
      const d = decodeAddress(addr, hrp);
      expect(d.pk).toBe(k.pk);
      expect(Buffer.from(d.encPk)).toEqual(Buffer.from(k.encPk));
    }
  });

  it('rejects wrong hrp', () => {
    const addr = encodeAddress('txpool', k.pk, k.encPk);
    expect(() => decodeAddress(addr, 'xpool')).toThrow(AddressError);
    expect(() => encodeAddress('btc', k.pk, k.encPk)).toThrow(AddressError);
  });

  it('rejects bad checksums (any single-char change)', () => {
    const addr = encodeAddress('xpool', k.pk, k.encPk);
    const chars = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    for (const pos of [6, 20, 50, addr.length - 1]) {
      const c = addr[pos]!;
      const repl = chars[(chars.indexOf(c) + 1) % 32]!;
      const bad = addr.slice(0, pos) + repl + addr.slice(pos + 1);
      expect(() => decodeAddress(bad)).toThrow(AddressError);
    }
  });

  it('rejects bech32 (non-m) encodings, bad version and pk >= p', () => {
    const payload = new Uint8Array(65);
    payload[0] = 1;
    payload.set(bigintToBytes(k.pk), 1);
    payload.set(k.encPk, 33);
    expect(() => decodeAddress(bech32.encode('xpool', bech32.toWords(payload), false))).toThrow(AddressError);

    const v2 = Uint8Array.from(payload);
    v2[0] = 2;
    expect(() => decodeAddress(bech32m.encode('xpool', bech32m.toWords(v2), false))).toThrow(/version/);

    const big = Uint8Array.from(payload);
    big.set(bigintToBytes(P), 1);
    expect(() => decodeAddress(bech32m.encode('xpool', bech32m.toWords(big), false))).toThrow(/field/);

    const short = payload.subarray(0, 64);
    expect(() => decodeAddress(bech32m.encode('xpool', bech32m.toWords(short), false))).toThrow(/length/);
  });
});

describe('fresh withdrawal EOAs', () => {
  const seed = mnemonicToSeed(TEST_MNEMONIC);
  it('derives distinct deterministic addresses on m/44\'/60\'/7331\'/0/n', () => {
    expect(freshPath(3)).toBe("m/44'/60'/7331'/0/3");
    const a0 = freshWithdrawalAddress(seed, 0);
    expect(freshWithdrawalAccount(seed, 0).address).toBe(a0);
    expect(freshWithdrawalAddress(seed, 1)).not.toBe(a0);
    expect(a0).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(() => freshPath(-1)).toThrow();
  });
});
