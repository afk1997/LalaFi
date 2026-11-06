/**
 * Fresh withdrawal EOAs at m/44'/60'/7331'/0/n (PRD 5.3). n increments per withdrawal, never reused.
 */
import { HDKey } from '@scure/bip32';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';
import { FRESH_PATH_PREFIX } from '../constants.js';

export function freshPath(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 31) throw new RangeError('fresh index must be in [0, 2^31)');
  return `${FRESH_PATH_PREFIX}/${n}`;
}

/** Derive the n-th fresh withdrawal account. Keep the returned account in memory only. */
export function freshWithdrawalAccount(seed: Uint8Array, n: number): PrivateKeyAccount {
  const node = HDKey.fromMasterSeed(seed).derive(freshPath(n));
  if (!node.privateKey) throw new Error('fresh key derivation failed');
  const acct = privateKeyToAccount(bytesToHex(node.privateKey));
  node.wipePrivateData();
  return acct;
}

/** Address only (no key material leaves this function). */
export function freshWithdrawalAddress(seed: Uint8Array, n: number): `0x${string}` {
  return freshWithdrawalAccount(seed, n).address;
}
