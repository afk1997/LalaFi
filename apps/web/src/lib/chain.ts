/** Read-only chain access through the RPCs in config (SDK RpcPool: rotates and falls back). */
import { abi, createEnvClients } from '@xpool/sdk/browser';
import { erc20Abi, type Address, type Hash } from 'viem';
import { chains, env } from './env';

export const clients = createEnvClients(env);

export interface ChainBalance {
  chainId: number;
  usdc: bigint;
  eth: bigint;
}

/** USDC and gas balances of `owner` on every chain (the "detected tokens" in the deposit picker). */
export async function balancesOf(owner: Address): Promise<ChainBalance[]> {
  return Promise.all(
    chains.map(async (c) => {
      const pool = clients.pool(c.id);
      const [usdc, eth] = await Promise.all([
        pool.run((p) => p.readContract({ address: c.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })).catch(() => 0n),
        pool.run((p) => p.getBalance({ address: owner })).catch(() => 0n),
      ]);
      return { chainId: c.id, usdc, eth };
    }),
  );
}

export function allowance(chainId: number, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return clients
    .pool(chainId)
    .run((p) => p.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }));
}

/** Settlement fee charged on top of an L2 deposit (0 on Ethereum). */
export async function settleFee(chainId: number): Promise<bigint> {
  const s = env.spokes.find((x) => x.chainId === chainId);
  if (!s) return 0n;
  const pool = clients.pool(chainId);
  const [i, f] = await Promise.all([
    pool.run((p) => p.readContract({ address: s.spoke, abi: abi.spokeAbi, functionName: 'settleFeeInsert' })),
    pool.run((p) => p.readContract({ address: s.spoke, abi: abi.spokeAbi, functionName: 'settleFeeFinal' })),
  ]);
  return i + f;
}

/** Free liquidity the hub can pay out on `chainId` right now (L[c]). */
export function available(chainId: number): Promise<bigint> {
  return clients.hub.run((p) =>
    p.readContract({
      address: env.hub.contracts.LiquidityManager,
      abi: abi.liquidityManagerAbi,
      functionName: 'available',
      args: [BigInt(chainId)],
    }),
  );
}

export async function waitForReceipt(chainId: number, hash: Hash): Promise<void> {
  const r = await clients.pool(chainId).run((p) => p.waitForTransactionReceipt({ hash, timeout: 300_000 }));
  if (r.status !== 'success') throw new Error('The transaction reverted on-chain.');
}
