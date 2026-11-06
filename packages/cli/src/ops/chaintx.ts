/**
 * EOA transactions (deposits, LP, validator, self-relay).
 */
import type { Abi, Account, Address, ContractFunctionArgs, ContractFunctionName, Hex } from 'viem';
import { abi, walletClientFor } from '@xpool/sdk';
import type { Ctx } from '../context.js';
import { CliError, info } from '../io.js';

export async function sendTx<const A extends Abi, F extends ContractFunctionName<A, 'nonpayable' | 'payable'>>(
  ctx: Ctx,
  account: Account,
  chainId: number,
  address: Address,
  contractAbi: A,
  functionName: F,
  args: ContractFunctionArgs<A, 'nonpayable' | 'payable', F>,
  value = 0n,
): Promise<Hex> {
  const net = await ctx.network();
  const pool = (await ctx.clients()).pool(chainId);
  const wc = walletClientFor(ctx.env(), chainId, account, net.tor ? net.fetch : undefined);
  const pc = pool.pick();
  // Simulate first so reverts surface with a decoded reason before spending gas.
  const { request } = await pc.simulateContract({
    account, address, abi: contractAbi, functionName, args, value,
  } as unknown as Parameters<typeof pc.simulateContract>[0]);
  const hash = await wc.writeContract(request as Parameters<typeof wc.writeContract>[0]);
  info(`sent ${String(functionName)}: ${hash}`);
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new CliError(`${String(functionName)} reverted (${hash})`);
  return hash;
}

/** Approve `spender` for at least `amount` of `token` if the current allowance is lower. */
export async function ensureAllowance(ctx: Ctx, account: Account, chainId: number, token: Address, spender: Address, amount: bigint): Promise<void> {
  const pool = (await ctx.clients()).pool(chainId);
  const current = await pool.run((c) => c.readContract({ address: token, abi: abi.erc20Abi, functionName: 'allowance', args: [account.address, spender] }));
  if (current >= amount) return;
  await sendTx(ctx, account, chainId, token, abi.erc20Abi, 'approve', [spender, amount]);
}
