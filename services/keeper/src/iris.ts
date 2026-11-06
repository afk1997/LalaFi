import type { Hex } from 'viem';

/**
 * Circle Iris (CCTP V2) attestation API client:
 *   GET {base}/v2/messages/{srcDomain}?transactionHash=0x…
 *   → { messages: [{ message, attestation, status, eventNonce, … }] }
 * Pending messages have status != "complete" and attestation "PENDING". 404 = not indexed yet.
 * Sandbox: https://iris-api-sandbox.circle.com · Mainnet: https://iris-api.circle.com · Local: mock-bridge.
 */

export interface IrisMessage {
  message: Hex;
  attestation: Hex;
}

const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

export function parseIrisResponse(json: unknown): { complete: IrisMessage[]; pending: number } {
  const msgs = (json as { messages?: unknown })?.messages;
  if (!Array.isArray(msgs)) return { complete: [], pending: 0 };
  const complete: IrisMessage[] = [];
  let pending = 0;
  for (const m of msgs as Array<Record<string, unknown>>) {
    const ok = m?.status === 'complete' && typeof m.message === 'string' && typeof m.attestation === 'string' && HEX.test(m.message) && HEX.test(m.attestation);
    if (ok) complete.push({ message: m.message as Hex, attestation: m.attestation as Hex });
    else pending++;
  }
  return { complete, pending };
}

export function defaultIrisBase(env: 'local' | 'testnet' | 'mainnet'): string {
  if (env === 'mainnet') return 'https://iris-api.circle.com';
  if (env === 'testnet') return 'https://iris-api-sandbox.circle.com';
  return 'http://127.0.0.1:8090';
}

export async function fetchIris(base: string, srcDomain: number, txHash: Hex, timeoutMs = 10_000): Promise<{ complete: IrisMessage[]; pending: number }> {
  const url = `${base.replace(/\/+$/, '')}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (res.status === 404) return { complete: [], pending: 1 };
  if (!res.ok) throw new Error(`iris ${res.status}`);
  return parseIrisResponse(await res.json());
}
