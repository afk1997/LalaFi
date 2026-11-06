import {
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from 'viem';

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export class SimulationError extends Error {
  constructor(
    readonly errorName: string | undefined,
    message: string,
    readonly args?: readonly unknown[],
  ) {
    super(message);
  }
}

/** Extracts the decoded custom error name from a viem error, if any. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (rev instanceof ContractFunctionRevertedError) return rev.data?.errorName ?? rev.reason ?? 'reverted';
  return undefined;
}

export interface SendResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

/**
 * Simulates the exact call with eth_call, then submits exactly the simulated request
 * (never re-encodes or alters the arguments), then waits for the receipt.
 */
export async function simulateAndSend(
  pub: PublicClient<Transport, Chain>,
  wallet: WalletClient<Transport, Chain, Account>,
  call: ContractCall,
  opts: { confirmations?: number; onSubmitted?: (hash: Hex) => void } = {},
): Promise<SendResult> {
  const request = await simulate(pub, wallet.account, call);
  const hash = await wallet.writeContract(request as never);
  opts.onSubmitted?.(hash);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: opts.confirmations ?? 1 });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted on-chain`);
  return { hash, receipt };
}

export async function simulate(pub: PublicClient<Transport, Chain>, account: Account, call: ContractCall): Promise<unknown> {
  try {
    const { request } = await pub.simulateContract({
      account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      ...(call.value !== undefined ? { value: call.value } : {}),
    } as never);
    return request;
  } catch (err) {
    const name = revertName(err);
    const msg = err instanceof BaseError ? err.shortMessage : String(err);
    throw new SimulationError(name, msg);
  }
}
