/**
 * Public-chain EOA for deposits / LP / validator actions / self-relay.
 * Read from XPOOL_EOA_KEY or an echo-off prompt; never written to disk, never printed.
 */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CliError, promptSecret } from './io.js';

export async function getEoaAccount(): Promise<PrivateKeyAccount> {
  let key = process.env.XPOOL_EOA_KEY;
  if (!key) key = await promptSecret('EOA private key (input hidden): ');
  key = key.trim();
  if (!key.startsWith('0x')) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new CliError('EOA key must be 32 bytes hex');
  return privateKeyToAccount(key as `0x${string}`);
}
