import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import {
  MAX_BATCH,
  depositBatchDigest,
  depositBatchTypedData,
  type DepositBatch,
  type Eip712Context,
} from '@xpool/service-common';
import type { Signer } from './signer.js';
import { InvalidBatch, type SlashingProtectionDb } from './slashing-db.js';

export interface SignedAttestation {
  batch: DepositBatch;
  digest: Hex;
  signer: Address;
  signature: Hex;
}

/** Shape rules for every batch this node signs: 1..32 deposits, strictly ascending indices. */
export function assertBatchShape(batch: DepositBatch): void {
  const n = batch.deposits.length;
  if (n < 1 || n > MAX_BATCH) throw new InvalidBatch(`size ${n}`);
  for (let i = 1; i < n; i++) {
    if (batch.deposits[i]!.index <= batch.deposits[i - 1]!.index) throw new InvalidBatch('indices not strictly ascending');
  }
}

/**
 * The ONLY path to an attestation signature. Order matters:
 *   shape check → slashing-protection authorize (durable) → sign → verify recovery → record.
 */
export class AttestationSigner {
  constructor(
    private readonly signer: Signer,
    private readonly db: SlashingProtectionDb,
    private readonly ctx: Eip712Context,
  ) {}

  get address(): Address {
    return this.signer.address;
  }

  async sign(batch: DepositBatch): Promise<SignedAttestation> {
    assertBatchShape(batch);
    const digest = depositBatchDigest(this.ctx, batch);
    const prior = this.db.signatureFor(digest);
    if (prior) return { batch, digest, signer: this.signer.address, signature: prior };

    this.db.authorize(batch.srcChainId, batch.deposits);
    const td = depositBatchTypedData(this.ctx, batch);
    const signature = await this.signer.signTypedData(td);
    const recovered = await recoverTypedDataAddress({ ...td, signature });
    if (recovered.toLowerCase() !== this.signer.address.toLowerCase()) throw new Error('signer returned a signature that does not recover');
    this.db.recordSignature(digest, signature);
    return { batch, digest, signer: this.signer.address, signature };
  }
}
