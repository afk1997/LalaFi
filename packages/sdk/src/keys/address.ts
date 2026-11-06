/**
 * Shielded address (PRD 5.3): bech32m(hrp, 0x01 || pk32 || encPk32).
 */
import { bech32m } from '@scure/base';
import { bigintToBytes, bytesToBigint, isField, type Field } from '../crypto/field.js';

export const ADDRESS_VERSION = 0x01;
export const ADDRESS_PAYLOAD_LEN = 65;
export const KNOWN_HRPS = ['xpool', 'txpool', 'lxpool'] as const;
export type Hrp = (typeof KNOWN_HRPS)[number];
/** HRP per environment (PRD 5.3). */
export const HRP_BY_ENV = { mainnet: 'xpool', testnet: 'txpool', local: 'lxpool' } as const;

export interface ShieldedAddress {
  hrp: string;
  pk: Field;
  encPk: Uint8Array;
}

export class AddressError extends Error {
  override name = 'AddressError';
}

export function encodeAddress(hrp: string, pk: Field, encPk: Uint8Array): string {
  if (!(KNOWN_HRPS as readonly string[]).includes(hrp)) throw new AddressError(`unknown hrp ${hrp}`);
  if (!isField(pk) || pk === 0n) throw new AddressError('pk must be a non-zero field element');
  if (encPk.length !== 32) throw new AddressError('encPk must be 32 bytes');
  const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
  payload[0] = ADDRESS_VERSION;
  payload.set(bigintToBytes(pk, 32), 1);
  payload.set(encPk, 33);
  return bech32m.encode(hrp, bech32m.toWords(payload), false);
}

/**
 * Decode and fully validate a shielded address. Rejects bad checksum (incl. bech32 vs bech32m),
 * wrong hrp, wrong version/length, pk >= p or 0, all-zero encPk.
 */
export function decodeAddress(addr: string, expectedHrp?: string): ShieldedAddress {
  if (typeof addr !== 'string' || addr.length > 200) throw new AddressError('malformed address');
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(addr as `${string}1${string}`, false);
  } catch (e) {
    throw new AddressError(`invalid bech32m address: ${(e as Error).message}`);
  }
  if (expectedHrp !== undefined && decoded.prefix !== expectedHrp) {
    throw new AddressError(`wrong network: address hrp "${decoded.prefix}", expected "${expectedHrp}"`);
  }
  if (!(KNOWN_HRPS as readonly string[]).includes(decoded.prefix)) throw new AddressError('unknown hrp');
  let payload: Uint8Array;
  try {
    payload = bech32m.fromWords(decoded.words);
  } catch {
    throw new AddressError('invalid address padding');
  }
  if (payload.length !== ADDRESS_PAYLOAD_LEN) throw new AddressError('bad address length');
  if (payload[0] !== ADDRESS_VERSION) throw new AddressError('unsupported address version');
  const pk = bytesToBigint(payload.subarray(1, 33));
  if (!isField(pk) || pk === 0n) throw new AddressError('pk is not a valid field element');
  const encPk = payload.slice(33, 65);
  if (encPk.every((b) => b === 0)) throw new AddressError('encPk is zero');
  return { hrp: decoded.prefix, pk, encPk };
}
