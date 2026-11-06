import { encodeFunctionData, getAddress, parseEther, size, type Address, type Hex } from 'viem';
import { arbInboxAbi, nodeInterfaceAbi } from './abis.js';
import type { ChainClients } from './clients.js';
import { ARB_ALIAS_OFFSET, NODE_INTERFACE, ZERO_ADDRESS } from './constants.js';
import { receiveFromHubCalldata } from './encoding.js';
import type { BridgeParams } from './types.js';

const U160 = 1n << 160n;

/** AddressAliasHelper.applyL1ToL2Alias. */
export function applyL1ToL2Alias(l1: Address): Address {
  return getAddress(`0x${((BigInt(l1) + ARB_ALIAS_OFFSET) % U160).toString(16).padStart(40, '0')}`);
}

/** AddressAliasHelper.undoL1ToL2Alias. */
export function undoL1ToL2Alias(l2: Address): Address {
  return getAddress(`0x${((BigInt(l2) - ARB_ALIAS_OFFSET + U160) % U160).toString(16).padStart(40, '0')}`);
}

/** x * (10_000 + marginBps) / 10_000, rounded up. */
export function withMargin(x: bigint, marginBps: number): bigint {
  const m = 10_000n + BigInt(marginBps);
  return (x * m + 9_999n) / 10_000n;
}

/** ETH the Arbitrum hub adapter requires: maxSubmissionCost + gasLimit * maxFeePerGas. */
export function retryableValue(bp: BridgeParams): bigint {
  return bp.maxSubmissionCost + bp.gasLimit * bp.maxFeePerGas;
}

export const ZERO_BRIDGE_PARAMS: BridgeParams = {
  maxSubmissionCost: 0n,
  gasLimit: 0n,
  maxFeePerGas: 0n,
  refundAddress: ZERO_ADDRESS,
};

export interface RetryableEstimateInput {
  l1: ChainClients;
  l2: ChainClients;
  inbox: Address;
  /** L1 sender of the retryable (the ArbitrumHubAdapter). */
  l1Sender: Address;
  /** L2 target (the spoke). */
  spoke: Address;
  /** Envelope abi.encode(kind, body) the adapter wraps into receiveFromHub(message). */
  message: Hex;
  refundAddress: Address;
  /** ≥ 3000 (30%) per PRD 13.3. */
  marginBps: number;
  /** Floor for the L2 gas limit (config params.minGasL2). */
  minGasL2: bigint;
  /** Local mocks have no NodeInterface: use minGasL2 instead of estimating. */
  useNodeInterface: boolean;
}

/**
 * Estimates Arbitrum retryable BridgeParams without the Arbitrum SDK:
 *  - maxSubmissionCost: Inbox.calculateRetryableSubmissionFee(dataLength, L1 baseFee)
 *  - gasLimit: NodeInterface.estimateRetryableTicket via eth_estimateGas on L2 (sender is
 *    remapped/aliased by the node), floored at minGasL2
 *  - maxFeePerGas: L2 gas price
 * each with ≥ marginBps on top.
 */
export async function estimateRetryable(input: RetryableEstimateInput): Promise<{ bp: BridgeParams; value: bigint }> {
  if (input.marginBps < 3000) throw new Error('Arbitrum margin must be at least 30%');
  const data = receiveFromHubCalldata(input.message);
  const l1Block = await input.l1.public.getBlock({ blockTag: 'latest' });
  const baseFee = l1Block.baseFeePerGas ?? (await input.l1.public.getGasPrice());
  const submission = await input.l1.public.readContract({
    address: input.inbox,
    abi: arbInboxAbi,
    functionName: 'calculateRetryableSubmissionFee',
    args: [BigInt(size(data)), baseFee],
  });

  let gas = input.minGasL2;
  if (input.useNodeInterface) {
    const estimated = await input.l2.public.estimateGas({
      to: NODE_INTERFACE,
      data: encodeFunctionData({
        abi: nodeInterfaceAbi,
        functionName: 'estimateRetryableTicket',
        args: [input.l1Sender, parseEther('1'), input.spoke, 0n, input.refundAddress, input.refundAddress, data],
      }),
    });
    if (estimated > gas) gas = estimated;
  }
  const l2GasPrice = await input.l2.public.getGasPrice();

  const bp: BridgeParams = {
    maxSubmissionCost: withMargin(submission, input.marginBps),
    gasLimit: withMargin(gas, input.marginBps),
    maxFeePerGas: withMargin(l2GasPrice, input.marginBps),
    refundAddress: input.refundAddress,
  };
  return { bp, value: retryableValue(bp) };
}
