import type { Address, Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { depositBatchTypedData } from '@xpool/service-common';

export type DepositBatchTypedData = ReturnType<typeof depositBatchTypedData>;

/**
 * Attestation signing key (PRD 5.9 / 13.4). Kept separate from the operator key that holds the
 * stake and pays gas. Implement this interface to plug in a KMS/HSM; the rest of the node only
 * ever signs through AttestationSigner, which enforces slashing protection first.
 */
export interface Signer {
  readonly address: Address;
  /** Must return a 65-byte low-s secp256k1 signature over the EIP-712 digest. */
  signTypedData(td: DepositBatchTypedData): Promise<Hex>;
}

/** In-process key loaded from an environment variable. */
export class LocalSigner implements Signer {
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  signTypedData(td: DepositBatchTypedData): Promise<Hex> {
    return this.account.signTypedData(td);
  }
}
