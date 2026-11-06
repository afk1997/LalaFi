import type { Address, Hex } from 'viem';

/** Mirrors of contracts/src/libraries/Types.sol. Integers are bigint everywhere. */

export interface Proof {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
}

export interface PublicInputs {
  root: bigint;
  publicAmount: bigint;
  extDataHash: bigint;
  inputNullifiers: readonly [bigint, bigint];
  outputCommitments: readonly [bigint, bigint];
}

export interface ExtData {
  version: number;
  hubChainId: bigint;
  hub: Address;
  dstChainId: bigint;
  recipient: Address;
  withdrawAmount: bigint;
  relayer: Address;
  relayerFee: bigint;
  protocolFee: bigint;
  deadline: bigint;
  encOut0: Hex;
  encOut1: Hex;
}

export interface Release {
  dstChainId: bigint;
  index: bigint;
  recipient: Address;
  amount: bigint;
  spendId: Hex;
}

export interface L2Deposit {
  index: bigint;
  ownerDigest: bigint;
  amount: bigint;
  fee: bigint;
  l2Block: bigint;
}

export interface BridgeParams {
  maxSubmissionCost: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  refundAddress: Address;
}

export interface RebalanceOrder {
  amount: bigint;
  dstDomain: number;
  mintRecipient: Hex;
  maxFee: bigint;
  minFinality: number;
  nonce: bigint;
}

export interface Checkpoint {
  seq: bigint;
  from: bigint;
  to: bigint;
  countAtSend: bigint;
  l2Block: bigint;
  deposits: readonly L2Deposit[];
}

/** ISpoke.ReleaseState */
export enum ReleaseState {
  None = 0,
  Executed = 1,
  Queued = 2,
  Failed = 3,
}

/** IDepositManager.BatchStatus */
export enum BatchStatus {
  None = 0,
  Pending = 1,
  Confirmed = 2,
  Fraud = 3,
}

export type Stack = 'opstack' | 'arbitrum';
