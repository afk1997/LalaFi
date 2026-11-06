import { decodeAbiParameters, keccak256, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { KvStore } from '@xpool/service-common';

/**
 * LOCAL ONLY mock Circle attester + Iris-compatible store.
 * Mock message: abi.encode(uint64 nonce, uint32 srcDomain, uint32 dstDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee)
 * Attestation:  65-byte ECDSA signature by the attester over keccak256(message), no EIP-191 prefix.
 */

export interface MockCctpMessage {
  nonce: bigint;
  srcDomain: number;
  dstDomain: number;
  mintRecipient: Hex;
  amount: bigint;
  maxFee: bigint;
}

export function decodeMockMessage(message: Hex): MockCctpMessage {
  const [nonce, srcDomain, dstDomain, mintRecipient, amount, maxFee] = decodeAbiParameters(
    [{ type: 'uint64' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
    message,
  );
  return { nonce, srcDomain, dstDomain, mintRecipient, amount, maxFee };
}

export async function attest(attester: PrivateKeyAccount, message: Hex): Promise<Hex> {
  return attester.sign({ hash: keccak256(message) });
}

export interface StoredMessage {
  message: Hex;
  attestation: Hex;
  eventNonce: string;
  readyAt: number;
}

export const irisKey = (srcDomain: number, txHash: Hex) => `iris:${srcDomain}:${txHash.toLowerCase()}`;

export class IrisStore {
  constructor(private readonly kv: KvStore) {}

  add(srcDomain: number, txHash: Hex, m: StoredMessage): void {
    const k = irisKey(srcDomain, txHash);
    const list = this.kv.get<StoredMessage[]>(k) ?? [];
    if (!list.some((x) => x.message === m.message)) this.kv.set(k, [...list, m]);
  }

  get(srcDomain: number, txHash: Hex): StoredMessage[] | undefined {
    return this.kv.get<StoredMessage[]>(irisKey(srcDomain, txHash));
  }
}

/** Shapes stored messages like Circle's `GET /v2/messages/{srcDomain}?transactionHash=` response. */
export function irisResponse(stored: StoredMessage[] | undefined, now: number): { status: number; body: unknown } {
  if (!stored?.length) return { status: 404, body: { code: 404, message: 'Message hash not found' } };
  return {
    status: 200,
    body: {
      messages: stored.map((m) =>
        m.readyAt <= now
          ? { message: m.message, eventNonce: m.eventNonce, attestation: m.attestation, cctpVersion: 2, status: 'complete' }
          : { message: m.message, eventNonce: m.eventNonce, attestation: 'PENDING', cctpVersion: 2, status: 'pending_confirmations' },
      ),
    },
  };
}
