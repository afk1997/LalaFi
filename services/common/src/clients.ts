import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import { stringifyBig } from './json.js';

/**
 * One chain = a fallback client over all configured RPCs (for normal reads/writes) plus one
 * client per RPC (for cross-checking critical reads, PRD 13.4).
 */
export interface ChainClients {
  chainId: number;
  chain: Chain;
  public: PublicClient<Transport, Chain>;
  perRpc: PublicClient<Transport, Chain>[];
  wallet?: WalletClient<Transport, Chain, Account>;
}

/** Chains with official definitions (OP Stack ones carry portal / dispute-game contracts for viem/op-stack). */
const KNOWN: Chain[] = [mainnet, sepolia, base, baseSepolia, arbitrum, arbitrumSepolia];

export function chainFor(chainId: number, name: string, rpc: string[]): Chain {
  const known = KNOWN.find((c) => c.id === chainId);
  if (known) return { ...known, rpcUrls: { default: { http: rpc } } };
  return defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpc } },
  });
}

export interface ClientOptions {
  account?: Account;
  pollingIntervalMs?: number;
  timeoutMs?: number;
}

export function createChainClients(chainId: number, name: string, rpc: string[], opts: ClientOptions = {}): ChainClients {
  if (rpc.length === 0) throw new Error(`no RPC configured for chain ${chainId}`);
  const chain = chainFor(chainId, name, rpc);
  const httpT = (url: string) => http(url, { timeout: opts.timeoutMs ?? 20_000, retryCount: 2 });
  const transport = rpc.length === 1 ? httpT(rpc[0]!) : fallback(rpc.map(httpT), { rank: false });
  const pollingInterval = opts.pollingIntervalMs ?? 2_000;
  const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient<Transport, Chain>;
  const perRpc = rpc.map(
    (url) => createPublicClient({ chain, transport: httpT(url), pollingInterval }) as PublicClient<Transport, Chain>,
  );
  const wallet = opts.account
    ? (createWalletClient({ chain, transport, account: opts.account, pollingInterval }) as WalletClient<Transport, Chain, Account>)
    : undefined;
  return { chainId, chain, public: pub, perRpc, ...(wallet ? { wallet } : {}) };
}

export class CrossCheckError extends Error {
  constructor(
    readonly what: string,
    readonly values: string[],
  ) {
    super(`RPC cross-check failed for ${what}`);
  }
}

/**
 * Runs `fn` against every RPC independently and requires identical results (deep, bigint-safe).
 * Any RPC error fails the check: a critical read is never trusted from a subset.
 */
export async function crossCheck<T>(clients: ChainClients, what: string, fn: (c: PublicClient<Transport, Chain>) => Promise<T>): Promise<T> {
  const results = await Promise.all(clients.perRpc.map((c) => fn(c)));
  const enc = results.map((r) => stringifyBig(r));
  if (enc.some((e) => e !== enc[0])) throw new CrossCheckError(what, enc.map((e) => e.slice(0, 200)));
  return results[0]!;
}

/**
 * Lowest `finalized` block number across all RPCs (they may legitimately differ by a few blocks;
 * the minimum is safe for every one of them).
 */
export async function minFinalizedBlock(clients: ChainClients, tag: 'finalized' | 'safe' | 'latest' = 'finalized'): Promise<bigint> {
  const blocks = await Promise.all(clients.perRpc.map((c) => c.getBlock({ blockTag: tag })));
  return blocks.reduce((m, b) => (b.number < m ? b.number : m), blocks[0]!.number);
}
