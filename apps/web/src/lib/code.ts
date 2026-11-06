/**
 * Withdrawal codes.
 *
 * A code is 32 random bytes (OS CSPRNG) encoded as bech32m: `xnote1…` (mainnet), `txnote1…` (testnet),
 * `lxnote1…` (local). HKDF expands the bytes into a seed for the same key derivation the CLI wallet
 * uses (deriveKeys: spending key sk and note-encryption key), so a code is a tiny one-purpose wallet:
 *  - deposits made with it are owned by its spending key and encrypted to its encryption key;
 *  - change from a partial withdrawal goes back to the same code, so one code can be withdrawn in parts;
 *  - nothing about the code is stored by the app or sent anywhere. Lose it and the funds are gone.
 * bech32m's checksum catches typos before any chain query is made.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';
import { deriveKeys, randomBytes, type SpendingKeys } from '@xpool/sdk/browser';
import { ENV_NAME } from './env';

const VERSION = 1;
const SEED_BYTES = 32;
const HRP = { mainnet: 'xnote', testnet: 'txnote', local: 'lxnote' } as const;
const hrp = HRP[ENV_NAME];

export interface DepositCode {
  text: string;
  keys: SpendingKeys;
}

const enc = new TextEncoder();

/** The wallet key derivation takes a 64-byte (BIP-39-sized) seed; expand the 32-byte code with HKDF. */
function walletSeed(code: Uint8Array): Uint8Array {
  return hkdf(sha256, code, enc.encode('xpool/code'), enc.encode(`v${VERSION}`), 64);
}

function fromSeed(seed: Uint8Array): DepositCode {
  const words = bech32m.toWords(Uint8Array.of(VERSION, ...seed));
  return { text: bech32m.encode(hrp, words, 200), keys: deriveKeys(walletSeed(seed), 0) };
}

export function newCode(): DepositCode {
  return fromSeed(randomBytes(SEED_BYTES));
}

export type ParseResult = { ok: true; code: DepositCode } | { ok: false; reason: string };

export function parseCode(input: string): ParseResult {
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return { ok: false, reason: 'Paste the code you saved when you deposited.' };
  const other = Object.entries(HRP).find(([env, h]) => env !== ENV_NAME && text.startsWith(`${h}1`));
  if (other) return { ok: false, reason: `This code is for ${other[0]}, not ${ENV_NAME}.` };
  if (!text.startsWith(`${hrp}1`)) return { ok: false, reason: `Codes start with ${hrp}1.` };
  let bytes: Uint8Array;
  try {
    bytes = bech32m.fromWords(bech32m.decode(text as `${string}1${string}`, 200).words);
  } catch {
    return { ok: false, reason: 'This code has a typo. Check it character by character.' };
  }
  if (bytes.length !== SEED_BYTES + 1 || bytes[0] !== VERSION) return { ok: false, reason: 'Unsupported code version.' };
  return { ok: true, code: fromSeed(bytes.slice(1)) };
}

/** Groups of 6 for reading aloud / checking by eye. Separators are ignored when parsing. */
export function groupCode(text: string): string[] {
  const [prefix, body] = [text.slice(0, text.indexOf('1') + 1), text.slice(text.indexOf('1') + 1)];
  const groups = body.match(/.{1,6}/g) ?? [];
  return [prefix + (groups[0] ?? ''), ...groups.slice(1)];
}
