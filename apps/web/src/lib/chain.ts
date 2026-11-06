/** Read-only chain access through each pool's configured RPCs (SDK RpcPool: rotates and falls back). */
import { abi, createEnvClients, type EnvClients } from '@xpool/sdk/browser';
import { erc20Abi, type Address, type Hash } from 'viem';
import { allChains, pools, type Pool } from './env';

const byPool = new Map<string, EnvClients>(pools.map((p) => [p.id, createEnvClients(p.env)]));
export const clientsOf = (pool: Pool): EnvClients => byPool.get(pool.id)!;
const anyPool = (chainId: number) => pools.find((p) => p.chains.some((c) => c.id === chainId))!;

export interface Holding {
  poolId: string;
  chainId: number;
  /** Balance of the pool's token on that chain. */
  amount: bigint;
}

export interface WalletBalances {
  holdings: Holding[];
  /** Gas balance per chain id. */
  eth: Record<number, bigint>;
}

/** Every pool token on every chain it lives on, plus gas: the "detected tokens" of the deposit picker. */
export async function balancesOf(owner: Address): Promise<WalletBalances> {
  const holdings = await Promise.all(
    pools.flatMap((p) =>
      p.chains.map(async (c): Promise<Holding> => {
        const amount = await clientsOf(p)
          .pool(c.id)
          .run((x) => x.readContract({ address: c.token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }))
          .catch(() => 0n);
        return { poolId: p.id, chainId: c.id, amount };
      }),
    ),
  );
  const eth: Record<number, bigint> = {};
  await Promise.all(
    allChains.map(async (c) => {
      eth[c.id] = await clientsOf(anyPool(c.id))
        .pool(c.id)
        .run((x) => x.getBalance({ address: owner }))
        .catch(() => 0n);
    }),
  );
  return { holdings, eth };
}

export function allowance(pool: Pool, chainId: number, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return clientsOf(pool)
    .pool(chainId)
    .run((p) => p.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }));
}

/** Settlement fee charged on top of an L2 deposit (0 on Ethereum). */
export async function settleFee(pool: Pool, chainId: number): Promise<bigint> {
  const s = pool.env.spokes.find((x) => x.chainId === chainId);
  if (!s) return 0n;
  const c = clientsOf(pool).pool(chainId);
  const [i, f] = await Promise.all([
    c.run((p) => p.readContract({ address: s.spoke, abi: abi.spokeAbi, functionName: 'settleFeeInsert' })),
    c.run((p) => p.readContract({ address: s.spoke, abi: abi.spokeAbi, functionName: 'settleFeeFinal' })),
  ]);
  return i + f;
}

/** Free liquidity the pool can pay out on `chainId` right now (L[c]). */
export function available(pool: Pool, chainId: number): Promise<bigint> {
  return clientsOf(pool).hub.run((p) =>
    p.readContract({
      address: pool.env.hub.contracts.LiquidityManager,
      abi: abi.liquidityManagerAbi,
      functionName: 'available',
      args: [BigInt(chainId)],
    }),
  );
}

export async function waitForReceipt(pool: Pool, chainId: number, hash: Hash): Promise<void> {
  const r = await clientsOf(pool).pool(chainId).run((p) => p.waitForTransactionReceipt({ hash, timeout: 300_000 }));
  if (r.status !== 'success') throw new Error('The transaction reverted on-chain.');
}
