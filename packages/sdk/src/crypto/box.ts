/**
 * Note encryption, exactly PRD 5.8:
 *   plaintext  = a (32B BE) || b (32B BE)
 *   ciphertext = 0x01 || epk (32) || nonce (24) || XSalsa20-Poly1305(box(encPk, esk), nonce, plaintext) (80)
 * Total 137 bytes. NaCl box = X25519 + HSalsa20 + XSalsa20-Poly1305 (tweetnacl).
 */
import nacl from 'tweetnacl';
import { AMOUNT_BOUND, P } from '../constants.js';
import { bigintToBytes, bytesToBigint } from './field.js';
import { randomBytes } from './random.js';

export const ENC_VERSION = 0x01;
export const ENC_NOTE_LEN = 137;
const PLAIN_LEN = 64;

export interface NotePlaintext {
  amount: bigint;
  blinding: bigint;
}

export interface X25519KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** RFC 7748 X25519 scalar clamping (returns a copy). */
export function clampX25519(k: Uint8Array): Uint8Array {
  if (k.length !== 32) throw new RangeError('X25519 secret must be 32 bytes');
  const c = Uint8Array.from(k);
  c[0]! &= 248;
  c[31]! &= 127;
  c[31]! |= 64;
  return c;
}

/** encPk = X25519(encSk, 9). */
export function x25519PublicKey(secret: Uint8Array): Uint8Array {
  return nacl.scalarMult.base(clampX25519(secret));
}

/** Fresh random X25519 keypair (CSPRNG). Used for ephemeral and throwaway keys. */
export function randomX25519KeyPair(): X25519KeyPair {
  const secretKey = clampX25519(randomBytes(32));
  return { secretKey, publicKey: x25519PublicKey(secretKey) };
}

function encodePlaintext(n: NotePlaintext): Uint8Array {
  if (n.amount < 0n || n.amount >= AMOUNT_BOUND) throw new RangeError('note amount out of range');
  if (n.blinding < 0n || n.blinding >= P) throw new RangeError('note blinding out of field');
  const out = new Uint8Array(PLAIN_LEN);
  out.set(bigintToBytes(n.amount, 32), 0);
  out.set(bigintToBytes(n.blinding, 32), 32);
  return out;
}

/**
 * Seal with explicit ephemeral key and nonce. Only for deterministic test vectors;
 * wallets MUST use {@link encryptNote}.
 */
export function sealNoteWith(
  recipientEncPk: Uint8Array,
  note: NotePlaintext,
  ephemeralSecret: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (recipientEncPk.length !== 32) throw new RangeError('encPk must be 32 bytes');
  if (nonce.length !== nacl.box.nonceLength) throw new RangeError('nonce must be 24 bytes');
  const esk = clampX25519(ephemeralSecret);
  const epk = x25519PublicKey(esk);
  const boxed = nacl.box(encodePlaintext(note), nonce, recipientEncPk, esk);
  const out = new Uint8Array(ENC_NOTE_LEN);
  out[0] = ENC_VERSION;
  out.set(epk, 1);
  out.set(nonce, 33);
  out.set(boxed, 57);
  return out;
}

/** Encrypt (a, b) to a recipient's encPk with a fresh ephemeral key and random nonce. */
export function encryptNote(recipientEncPk: Uint8Array, note: NotePlaintext): Uint8Array {
  return sealNoteWith(recipientEncPk, note, randomBytes(32), randomBytes(nacl.box.nonceLength));
}

/**
 * Trial-decrypt. Returns null on any failure (wrong key, tampered, malformed, out-of-range values).
 * The caller MUST still validate the commitment (validate-before-accept, PRD 5.8).
 */
export function decryptNote(encSk: Uint8Array, blob: Uint8Array): NotePlaintext | null {
  if (blob.length !== ENC_NOTE_LEN || blob[0] !== ENC_VERSION) return null;
  const epk = blob.subarray(1, 33);
  const nonce = blob.subarray(33, 57);
  const boxed = blob.subarray(57);
  const plain = nacl.box.open(boxed, nonce, epk, clampX25519(encSk));
  if (!plain || plain.length !== PLAIN_LEN) return null;
  const amount = bytesToBigint(plain.subarray(0, 32));
  const blinding = bytesToBigint(plain.subarray(32, 64));
  if (amount >= AMOUNT_BOUND || blinding >= P) return null;
  return { amount, blinding };
}
