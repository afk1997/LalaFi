/**
 * BN254 scalar field helpers (PRD 5.1). Byte encoding is 32-byte big-endian.
 */
import { AMOUNT_BOUND, P } from '../constants.js';
import { randomBytes } from './random.js';

export type Field = bigint;

/** x mod p, always non-negative. */
export function mod(x: bigint): Field {
  const r = x % P;
  return r < 0n ? r + P : r;
}

/** True iff 0 <= x < p. */
export function isField(x: bigint): boolean {
  return x >= 0n && x < P;
}

/** Throws unless 0 <= x < p. */
export function assertField(x: bigint, what = 'value'): Field {
  if (typeof x !== 'bigint' || !isField(x)) throw new RangeError(`${what} is not a field element (< p)`);
  return x;
}

/** Throws unless 0 <= x < 2^248 (PRD 5.11 amount range). */
export function assertAmount(x: bigint, what = 'amount'): bigint {
  if (typeof x !== 'bigint' || x < 0n || x >= AMOUNT_BOUND) throw new RangeError(`${what} out of range [0, 2^248)`);
  return x;
}

/** OS2IP: big-endian bytes to unsigned integer. */
export function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** I2OSP: unsigned integer to big-endian bytes of fixed length. */
export function bigintToBytes(x: bigint, len = 32): Uint8Array {
  if (x < 0n) throw new RangeError('negative');
  const out = new Uint8Array(len);
  let v = x;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`integer does not fit in ${len} bytes`);
  return out;
}

/** Uniform field element: 64 CSPRNG bytes mod p (bias < 2^-250). */
export function randomField(): Field {
  return mod(bytesToBigint(randomBytes(64)));
}

/** Uniform non-zero field element. */
export function randomNonZeroField(): Field {
  for (;;) {
    const x = randomField();
    if (x !== 0n) return x;
  }
}

/** Parse a decimal or 0x-hex string into a field element, validating < p. */
export function parseField(s: string, what = 'value'): Field {
  if (typeof s !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) throw new TypeError(`${what}: not an integer string`);
  return assertField(BigInt(s), what);
}

/** Field element as 0x-prefixed 32-byte hex. */
export function toHex32(x: bigint): `0x${string}` {
  return `0x${x.toString(16).padStart(64, '0')}`;
}
