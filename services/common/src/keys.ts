import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Reads a private key from an environment variable ONLY (never from files or argv), validates it,
 * and removes it from process.env so child processes / diagnostics can't see it.
 */
export function loadPrivateKey(envVar: string, env: NodeJS.ProcessEnv = process.env): Hex {
  const raw = env[envVar]?.trim();
  if (!raw) throw new Error(`missing required key env var ${envVar}`);
  const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  if (!KEY_RE.test(key)) throw new Error(`env var ${envVar} is not a 32-byte hex private key`);
  if (BigInt(key) === 0n) throw new Error(`env var ${envVar} is zero`);
  delete env[envVar];
  return key;
}

/** Account with viem's nonce manager, so concurrent sends from one service don't collide. */
export function loadAccount(envVar: string, env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  return privateKeyToAccount(loadPrivateKey(envVar, env), { nonceManager });
}
