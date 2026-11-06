/**
 * Pools = one deployment per token (USDC, DAI, …). Each is config/<stem>.json + deployments/<stem>.json,
 * validated by the SDK. A pool shows up automatically once both files exist for this environment, so
 * adding a token is: write its config, deploy it, rebuild. Bundled at build time; nothing is fetched.
 *
 * VITE_XPOOL_ENV=local|testnet|mainnet (default testnet)
 * VITE_RELAYER_URLS="usdc=http://127.0.0.1:8080,dai=http://127.0.0.1:8081" (per pool; VITE_RELAYER_URL is the default)
 */
import { resolveEnv, type Env, type RawConfig, type RawDeployments, type ResolvedEnv } from '@xpool/sdk/browser';

const configs = import.meta.glob<RawConfig>('../../../../config/*.json', { eager: true, import: 'default' });
const deployments = import.meta.glob<RawDeployments>('../../../../deployments/*.json', { eager: true, import: 'default' });

export const ENV_NAME = ((import.meta.env.VITE_XPOOL_ENV as string | undefined) ?? 'testnet') as Env;
export const NETWORK_LABEL = ENV_NAME === 'local' ? 'Local' : ENV_NAME === 'testnet' ? 'Testnet' : '';

export type ChainKey = 'eth' | 'base' | 'arb';

export interface ChainInfo {
  key: ChainKey;
  id: number;
  label: string;
  /** The pool token's address on this chain. */
  token: `0x${string}`;
  rpc: string[];
  explorer?: string;
  /** Where deposits are sent on this chain (DepositManager on the hub, the spoke on L2s). */
  depositTo: `0x${string}`;
}

export interface Pool {
  id: string;
  symbol: string;
  decimals: number;
  env: ResolvedEnv;
  chains: ChainInfo[];
  relayerUrl: string;
  /** bech32m prefix of this pool's withdrawal codes. */
  codePrefix: string;
  /** Superseded pool: still withdrawable with its codes, but not offered for new deposits. */
  legacy: boolean;
}

const LABELS: Record<ChainKey, string> = { eth: 'Ethereum', base: 'Base', arb: 'Arbitrum' };
const EXPLORERS: Record<number, string> = {
  11155111: 'https://sepolia.etherscan.io',
  84532: 'https://sepolia.basescan.org',
  421614: 'https://sepolia.arbiscan.io',
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
};

const ENV_PREFIX: Record<Env, string> = { mainnet: '', testnet: 't', local: 'l' };

/** USDC keeps the original `xnote` codes; other pools use `x<pool>` (e.g. `txdai1…`). */
function codePrefix(pool: string): string {
  return `${ENV_PREFIX[ENV_NAME]}${pool === 'usdc' ? 'xnote' : `x${pool}`}`;
}

function relayerUrls(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of ((import.meta.env.VITE_RELAYER_URLS as string | undefined) ?? '').split(',')) {
    const [k, v] = part.split('=');
    if (k && v) out[k.trim().toLowerCase()] = v.trim();
  }
  return out;
}

function chainsOf(env: ResolvedEnv): ChainInfo[] {
  return [
    {
      key: 'eth',
      id: env.hub.chainId,
      label: LABELS.eth,
      token: env.hub.usdc,
      rpc: env.hub.rpc,
      explorer: EXPLORERS[env.hub.chainId],
      depositTo: env.hub.contracts.DepositManager,
    },
    ...env.spokes.map((s): ChainInfo => {
      const key: ChainKey = s.stack === 'arbitrum' ? 'arb' : 'base';
      return { key, id: s.chainId, label: LABELS[key], token: s.usdc, rpc: s.rpc, explorer: EXPLORERS[s.chainId], depositTo: s.spoke };
    }),
  ];
}

function loadPools(): Pool[] {
  const urls = relayerUrls();
  const fallback = (import.meta.env.VITE_RELAYER_URL as string | undefined) ?? 'http://127.0.0.1:8080';
  const out: Pool[] = [];
  for (const [path, cfg] of Object.entries(configs)) {
    if (cfg.environment !== ENV_NAME) continue;
    const stem = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
    const depKey = Object.keys(deployments).find((p) => p.endsWith(`/${stem}.json`));
    if (!depKey) continue; // configured but not deployed yet
    const env = resolveEnv(cfg, deployments[depKey]!);
    out.push({
      id: env.pool,
      symbol: env.token.symbol,
      decimals: env.token.decimals,
      env,
      chains: chainsOf(env),
      relayerUrl: urls[env.pool] ?? fallback,
      codePrefix: codePrefix(env.pool),
      legacy: (cfg as { legacy?: boolean }).legacy === true,
    });
  }
  // USDC first, then alphabetical
  out.sort((a, b) => (a.id === 'usdc' ? -1 : b.id === 'usdc' ? 1 : a.symbol.localeCompare(b.symbol)));
  if (out.length === 0) throw new Error(`xpool: no deployed pools for ${ENV_NAME} (config/*.json + deployments/*.json)`);
  return out;
}

export const pools: Pool[] = loadPools();

/** Pools offered for new deposits. */
export const depositPools: Pool[] = pools.filter((p) => !p.legacy);

export const poolById = (id: string): Pool => {
  const p = pools.find((x) => x.id === id);
  if (!p) throw new Error(`unknown pool ${id}`);
  return p;
};

export function chainOf(pool: Pool, id: number): ChainInfo {
  const c = pool.chains.find((x) => x.id === id);
  if (!c) throw new Error(`${pool.symbol} is not on chain ${id}`);
  return c;
}

/** Every chain any pool uses (for the wallet's chain switching). */
export const allChains: ChainInfo[] = pools.flatMap((p) => p.chains).filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i);

export const chainById = (id: number): ChainInfo => {
  const c = allChains.find((x) => x.id === id);
  if (!c) throw new Error(`unknown chain ${id}`);
  return c;
};
