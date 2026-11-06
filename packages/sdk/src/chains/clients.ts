/**
 * viem clients. Each chain gets a pool of public clients, one per configured RPC; queries are
 * spread round-robin across them with failover (W9). An optional fetch function routes RPC over Tor.
 */
import {
  createPublicClient, createWalletClient, defineChain, http,
  type Account, type Chain, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { randomInt } from '../crypto/random.js';
import type { FetchFn } from '../relayer/tor.js';
import type { ResolvedEnv } from './resolve.js';

export function chainDef(chainId: number, name: string, rpc: string[]): Chain {
  return defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpc } },
  });
}

export class RpcPool {
  readonly clients: PublicClient<Transport, Chain>[];
  private next: number;

  constructor(readonly chain: Chain, rpcs: string[], fetchFn?: FetchFn) {
    if (rpcs.length === 0) throw new Error(`no RPCs for chain ${chain.id}`);
    this.clients = rpcs.map((u) =>
      createPublicClient({ chain, transport: http(u, { retryCount: 1, timeout: 30_000, ...(fetchFn ? { fetchFn } : {}) }) }),
    );
    this.next = randomInt(this.clients.length);
  }

  /** The next client in rotation. */
  pick(): PublicClient<Transport, Chain> {
    const c = this.clients[this.next % this.clients.length]!;
    this.next = (this.next + 1) % this.clients.length;
    return c;
  }

  /** Run `f` on the next client, failing over to the others on error. */
  async run<T>(f: (c: PublicClient<Transport, Chain>) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let k = 0; k < this.clients.length; k++) {
      try {
        return await f(this.pick());
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
}

export interface EnvClients {
  hub: RpcPool;
  spokes: Map<number, RpcPool>;
  pool(chainId: number): RpcPool;
}

export function createEnvClients(env: ResolvedEnv, fetchFn?: FetchFn): EnvClients {
  const hub = new RpcPool(chainDef(env.hub.chainId, env.hub.name, env.hub.rpc), env.hub.rpc, fetchFn);
  const spokes = new Map<number, RpcPool>();
  for (const s of env.spokes) spokes.set(s.chainId, new RpcPool(chainDef(s.chainId, s.name, s.rpc), s.rpc, fetchFn));
  return {
    hub,
    spokes,
    pool(chainId: number): RpcPool {
      if (chainId === env.hub.chainId) return hub;
      const p = spokes.get(chainId);
      if (!p) throw new Error(`unknown chain ${chainId}`);
      return p;
    },
  };
}

export function walletClientFor(env: ResolvedEnv, chainId: number, account: Account, fetchFn?: FetchFn): WalletClient<Transport, Chain, Account> {
  const c = chainId === env.hub.chainId ? env.hub : env.spokes.find((s) => s.chainId === chainId);
  if (!c) throw new Error(`unknown chain ${chainId}`);
  const name = 'name' in c ? c.name : String(chainId);
  return createWalletClient({
    account,
    chain: chainDef(chainId, name, c.rpc),
    transport: http(c.rpc[0], fetchFn ? { fetchFn } : {}),
  });
}
