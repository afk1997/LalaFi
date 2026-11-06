/**
 * Spending and encryption key derivation (PRD 5.3):
 *   sk     = OS2IP(HKDF-SHA256(seed, "xpool/v1", "spend/" || acct, 64)) mod p, sk != 0
 *   pk     = H1(sk)
 *   encSk  = clamp(HKDF-SHA256(seed, "xpool/v1", "enc/" || acct, 32))
 *   encPk  = X25519(encSk, 9)
 * `acct` is encoded as a 4-byte big-endian uint32.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { clampX25519, x25519PublicKey } from '../crypto/box.js';
import { bytesToBigint, mod, type Field } from '../crypto/field.js';
import { H1 } from '../crypto/poseidon.js';

const SALT = new TextEncoder().encode('xpool/v1');

export interface SpendingKeys {
  account: number;
  sk: Field;
  pk: Field;
  encSk: Uint8Array;
  encPk: Uint8Array;
}

function info(label: string, acct: number): Uint8Array {
  if (!Number.isInteger(acct) || acct < 0 || acct > 0xffffffff) throw new RangeError('account must be a uint32');
  const l = new TextEncoder().encode(label);
  const out = new Uint8Array(l.length + 4);
  out.set(l, 0);
  new DataView(out.buffer).setUint32(l.length, acct, false);
  return out;
}

function checkSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new RangeError('seed must be 64 bytes');
}

export function deriveSpendKey(seed: Uint8Array, acct = 0): Field {
  checkSeed(seed);
  const sk = mod(bytesToBigint(hkdf(sha256, seed, SALT, info('spend/', acct), 64)));
  if (sk === 0n) throw new Error('derived sk = 0 (negligible probability); use another account');
  return sk;
}

export function deriveEncSecret(seed: Uint8Array, acct = 0): Uint8Array {
  checkSeed(seed);
  return clampX25519(hkdf(sha256, seed, SALT, info('enc/', acct), 32));
}

export function deriveKeys(seed: Uint8Array, acct = 0): SpendingKeys {
  const sk = deriveSpendKey(seed, acct);
  const encSk = deriveEncSecret(seed, acct);
  return { account: acct, sk, pk: H1(sk), encSk, encPk: x25519PublicKey(encSk) };
}
