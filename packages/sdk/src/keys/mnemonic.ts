/**
 * BIP-39, 24 words (256-bit entropy) (PRD 5.3).
 */
import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic as bip39Validate,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const MNEMONIC_WORDS = 24;

/** Fresh 24-word mnemonic from the CSPRNG (scure uses crypto.getRandomValues). */
export function generateMnemonic(): string {
  return bip39Generate(wordlist, 256);
}

/** Normalize whitespace / case of a user-entered mnemonic. */
export function normalizeMnemonic(m: string): string {
  return m.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/** True iff the mnemonic is a valid 24-word English BIP-39 mnemonic. */
export function isValidMnemonic(m: string): boolean {
  const n = normalizeMnemonic(m);
  return n.split(' ').length === MNEMONIC_WORDS && bip39Validate(n, wordlist);
}

/** seed = BIP39_seed(mnemonic, passphrase), 64 bytes. Throws on an invalid mnemonic. */
export function mnemonicToSeed(m: string, passphrase = ''): Uint8Array {
  if (!isValidMnemonic(m)) throw new Error('invalid mnemonic (expected 24 BIP-39 English words)');
  return mnemonicToSeedSync(normalizeMnemonic(m), passphrase);
}
