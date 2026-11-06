/**
 * Environment = config/<env>.json + deployments/<env>.json, validated by the SDK (resolveEnv).
 * Pick with VITE_XPOOL_ENV=local|testnet (default testnet). Bundled at build time; nothing is fetched.
 */
import { resolveEnv, type Env, type RawConfig, type RawDeployments, type ResolvedEnv } from '@xpool/sdk/browser';

const configs = import.meta.glob<RawConfig>('../../../../config/*.json', { eager: true, import: 'default' });
const deployments = import.meta.glob<RawDeployments>('../../../../deployments/*.json', { eager: true, import: 'default' });

function pick<T>(files: Record<string, T>, env: string): T | undefined {
  const k = Object.keys(files).find((p) => p.endsWith(`/${env}.json`));
  return k ? files[k] : undefined;
}

export const ENV_NAME = ((import.meta.env.VITE_XPOOL_ENV as string | undefined) ?? 'testnet') as Env;

function load(): ResolvedEnv {
  const cfg = pick(configs, ENV_NAME);
  const dep = pick(deployments, ENV_NAME);
  if (!cfg || !dep) throw new Error(`xpool: missing config/${ENV_NAME}.json or deployments/${ENV_NAME}.json`);
  return resolveEnv(cfg, dep);
}

export const env: ResolvedEnv = load();

export const RELAYER_URL: string =
  (import.meta.env.VITE_RELAYER_URL as string | undefined) ?? 'http://127.0.0.1:8080';

export type ChainKey = 'eth' | 'base' | 'arb';

export interface ChainInfo {
  key: ChainKey;
  id: number;
  /** Display name, e.g. "Base". */
  label: string;
  usdc: `0x${string}`;
  rpc: string[];
  explorer?: string;
  /** Where deposits are sent on this chain. */
  depositTo: `0x${string}`;
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

export const chains: ChainInfo[] = [
  {
    key: 'eth',
    id: env.hub.chainId,
    label: LABELS.eth,
    usdc: env.hub.usdc,
    rpc: env.hub.rpc,
    explorer: EXPLORERS[env.hub.chainId],
    depositTo: env.hub.contracts.DepositManager,
  },
  ...env.spokes.map((s) => {
    const key: ChainKey = s.stack === 'arbitrum' ? 'arb' : 'base';
    return {
      key,
      id: s.chainId,
      label: LABELS[key],
      usdc: s.usdc,
      rpc: s.rpc,
      explorer: EXPLORERS[s.chainId],
      depositTo: s.spoke,
    };
  }),
];

export const chainById = (id: number): ChainInfo => {
  const c = chains.find((x) => x.id === id);
  if (!c) throw new Error(`unknown chain ${id}`);
  return c;
};

export const isTestnet = ENV_NAME !== 'mainnet';
export const NETWORK_LABEL = ENV_NAME === 'local' ? 'Local' : ENV_NAME === 'testnet' ? 'Testnet' : '';
