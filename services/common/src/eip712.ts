import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';
import type { L2Deposit } from './types.js';

/** EIP-712 layout for fast-lane attestations (PRD 5.9, docs/IMPLEMENTATION.md). */

export const EIP712_NAME = 'xpool';
export const EIP712_VERSION = '1';

export const DEPOSIT_BATCH_TYPES = {
  L2Deposit: [
    { name: 'index', type: 'uint64' },
    { name: 'ownerDigest', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
    { name: 'l2Block', type: 'uint64' },
  ],
  DepositBatch: [
    { name: 'srcChainId', type: 'uint64' },
    { name: 'spoke', type: 'address' },
    { name: 'epoch', type: 'uint64' },
    { name: 'deposits', type: 'L2Deposit[]' },
  ],
} as const;

export interface DepositBatch {
  srcChainId: bigint;
  spoke: Address;
  epoch: bigint;
  deposits: readonly L2Deposit[];
}

export interface Eip712Context {
  hubChainId: bigint;
  depositManager: Address;
}

export function depositBatchDomain(ctx: Eip712Context): TypedDataDomain {
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: ctx.hubChainId,
    verifyingContract: ctx.depositManager,
  };
}

/** Typed-data definition accepted by viem signTypedData / recoverTypedDataAddress / hashTypedData. */
export function depositBatchTypedData(ctx: Eip712Context, batch: DepositBatch) {
  return {
    domain: depositBatchDomain(ctx),
    types: DEPOSIT_BATCH_TYPES,
    primaryType: 'DepositBatch' as const,
    message: {
      srcChainId: batch.srcChainId,
      spoke: batch.spoke,
      epoch: batch.epoch,
      deposits: batch.deposits.map((d) => ({ ...d })),
    },
  };
}

export function depositBatchDigest(ctx: Eip712Context, batch: DepositBatch): Hex {
  return hashTypedData(depositBatchTypedData(ctx, batch));
}

// ---------------------------------------------------------------------------- explicit construction
// Written out per docs/IMPLEMENTATION.md so the digest can be checked independently of viem's
// typed-data encoder (and against DepositManager.batchDigest on a live chain).

export const L2_DEPOSIT_TYPE = 'L2Deposit(uint64 index,uint256 ownerDigest,uint256 amount,uint256 fee,uint64 l2Block)';
export const DEPOSIT_BATCH_TYPE =
  'DepositBatch(uint64 srcChainId,address spoke,uint64 epoch,L2Deposit[] deposits)' + L2_DEPOSIT_TYPE;
export const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

export const L2_DEPOSIT_TYPEHASH = keccak256(toHex(L2_DEPOSIT_TYPE));
export const DEPOSIT_BATCH_TYPEHASH = keccak256(toHex(DEPOSIT_BATCH_TYPE));
export const EIP712_DOMAIN_TYPEHASH = keccak256(toHex(EIP712_DOMAIN_TYPE));

export function domainSeparatorManual(ctx: Eip712Context): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(EIP712_NAME)),
        keccak256(toHex(EIP712_VERSION)),
        ctx.hubChainId,
        ctx.depositManager,
      ],
    ),
  );
}

export function hashL2DepositStruct(d: L2Deposit): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
      ],
      [L2_DEPOSIT_TYPEHASH, d.index, d.ownerDigest, d.amount, d.fee, d.l2Block],
    ),
  );
}

export function hashDepositBatchStruct(batch: DepositBatch): Hex {
  const depositsHash = keccak256(batch.deposits.length ? concat(batch.deposits.map(hashL2DepositStruct)) : '0x');
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }],
      [DEPOSIT_BATCH_TYPEHASH, batch.srcChainId, batch.spoke, batch.epoch, depositsHash],
    ),
  );
}

export function depositBatchDigestManual(ctx: Eip712Context, batch: DepositBatch): Hex {
  return keccak256(concat(['0x1901', domainSeparatorManual(ctx), hashDepositBatchStruct(batch)]));
}
