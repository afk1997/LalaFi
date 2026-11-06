import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from 'viem';
import { MSG_REBALANCE, MSG_RELEASE, P } from './constants.js';
import { spokeAbi } from './abis.js';
import type { Checkpoint, ExtData, L2Deposit, RebalanceOrder, Release } from './types.js';

/** ABI parameter shapes matching Types.sol (abi.encode of the struct). */
export const L2_DEPOSIT_COMPONENTS = [
  { name: 'index', type: 'uint64' },
  { name: 'ownerDigest', type: 'uint256' },
  { name: 'amount', type: 'uint256' },
  { name: 'fee', type: 'uint256' },
  { name: 'l2Block', type: 'uint64' },
] as const;

export const L2_DEPOSIT_PARAM = { type: 'tuple', components: L2_DEPOSIT_COMPONENTS } as const;

export const CHECKPOINT_PARAM = {
  type: 'tuple',
  components: [
    { name: 'seq', type: 'uint64' },
    { name: 'from', type: 'uint64' },
    { name: 'to', type: 'uint64' },
    { name: 'countAtSend', type: 'uint64' },
    { name: 'l2Block', type: 'uint64' },
    { name: 'deposits', type: 'tuple[]', components: L2_DEPOSIT_COMPONENTS },
  ],
} as const;

export const RELEASE_PARAM = {
  type: 'tuple',
  components: [
    { name: 'dstChainId', type: 'uint64' },
    { name: 'index', type: 'uint64' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'spendId', type: 'bytes32' },
  ],
} as const;

export const REBALANCE_ORDER_PARAM = {
  type: 'tuple',
  components: [
    { name: 'amount', type: 'uint256' },
    { name: 'dstDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinality', type: 'uint32' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export const EXT_DATA_PARAM = {
  type: 'tuple',
  components: [
    { name: 'version', type: 'uint32' },
    { name: 'hubChainId', type: 'uint64' },
    { name: 'hub', type: 'address' },
    { name: 'dstChainId', type: 'uint64' },
    { name: 'recipient', type: 'address' },
    { name: 'withdrawAmount', type: 'uint256' },
    { name: 'relayer', type: 'address' },
    { name: 'relayerFee', type: 'uint256' },
    { name: 'protocolFee', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'encOut0', type: 'bytes' },
    { name: 'encOut1', type: 'bytes' },
  ],
} as const;

// ---------------------------------------------------------------------------- hashes

/** keccak256(abi.encode(L2Deposit)) — the item hash used by fast lane, checkpoints and fraud proofs. */
export function itemHash(d: L2Deposit): Hex {
  return keccak256(encodeAbiParameters([L2_DEPOSIT_PARAM], [d]));
}

/** releaseHash[dst][index] = keccak256(abi.encode(Release)). */
export function releaseHash(r: Release): Hex {
  return keccak256(encodeAbiParameters([RELEASE_PARAM], [r]));
}

/** spendId = keccak256(abi.encode(inputNullifiers[0], inputNullifiers[1])). */
export function spendId(n0: bigint, n1: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [n0, n1]));
}

/** extDataHash = uint256(keccak256(abi.encode(ext))) % P. */
export function extDataHash(ext: ExtData): bigint {
  return BigInt(keccak256(encodeAbiParameters([EXT_DATA_PARAM], [ext]))) % P;
}

// ---------------------------------------------------------------------------- checkpoints

/** Enforces the receipt invariant: to - from == deposits.length and deposits[k].index == from + k. */
export function assertCheckpointShape(cp: Checkpoint): void {
  if (cp.to < cp.from) throw new Error('checkpoint: to < from');
  if (cp.to - cp.from !== BigInt(cp.deposits.length)) throw new Error('checkpoint: length mismatch');
  cp.deposits.forEach((d, k) => {
    if (d.index !== cp.from + BigInt(k)) throw new Error(`checkpoint: deposit ${k} has index ${d.index}`);
  });
}

/** payload = abi.encode(Checkpoint) (single dynamic tuple, leading 0x20 offset word). */
export function encodeCheckpoint(cp: Checkpoint): Hex {
  assertCheckpointShape(cp);
  return encodeAbiParameters([CHECKPOINT_PARAM], [cp]);
}

export function decodeCheckpoint(payload: Hex): Checkpoint {
  const [cp] = decodeAbiParameters([CHECKPOINT_PARAM], payload);
  return cp;
}

// ---------------------------------------------------------------------------- hub -> spoke messages

/** Envelope: abi.encode(uint8 kind, bytes body). */
export function encodeEnvelope(kind: number, body: Hex): Hex {
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [kind, body]);
}

export function decodeEnvelope(message: Hex): { kind: number; body: Hex } {
  const [kind, body] = decodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], message);
  return { kind, body };
}

export function encodeReleaseMessage(r: Release): Hex {
  return encodeEnvelope(MSG_RELEASE, encodeAbiParameters([RELEASE_PARAM], [r]));
}

export function encodeRebalanceMessage(o: RebalanceOrder): Hex {
  return encodeEnvelope(MSG_REBALANCE, encodeAbiParameters([REBALANCE_ORDER_PARAM], [o]));
}

/** Calldata the bridge delivers to the spoke: ISpoke.receiveFromHub(message). */
export function receiveFromHubCalldata(message: Hex): Hex {
  return encodeFunctionData({ abi: spokeAbi, functionName: 'receiveFromHub', args: [message] });
}

// ---------------------------------------------------------------------------- fee math

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv: non-positive divisor');
  return a === 0n ? 0n : (a + b - 1n) / b;
}

/** protocolFee == ceilDiv(w * phiBps, 10_000). */
export function protocolFeeFor(withdrawAmount: bigint, phiBps: bigint): bigint {
  return ceilDiv(withdrawAmount * phiBps, 10_000n);
}

/** publicAmount = v == 0 ? 0 : P - v. */
export function publicAmountFor(v: bigint): bigint {
  return v === 0n ? 0n : P - v;
}

/** Rounds `x` up to the next multiple of `bucket`. */
export function roundUpToBucket(x: bigint, bucket: bigint): bigint {
  return ceilDiv(x, bucket) * bucket;
}
