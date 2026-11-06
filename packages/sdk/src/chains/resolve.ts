/**
 * Pure, browser-safe validation of config/<env>.json (PRD 14.6) + deployments/<env>.json.
 * File loading lives in config.ts (Node only).
 * Every address and numeric parameter is validated; nothing unvalidated reaches the wallet.
 */
import { getAddress, isAddress, type Address } from 'viem';

export type Env = 'local' | 'testnet' | 'mainnet';
export const ENVS: readonly Env[] = ['local', 'testnet', 'mainnet'];
export type Stack = 'opstack' | 'arbitrum';

export interface RawChainConfig {
  name: string;
  chainId: number;
  rpc: string[];
  usdc: string;
  stack?: Stack;
}

export interface RawConfig {
  environment: Env;
  hrp: string;
  hub: RawChainConfig;
  spokes: RawChainConfig[];
  params: {
    phiBps: number;
    relayerFeeBucket: string;
    minDeposit: string;
    maxDeposit: string;
    maxFastDeposit: string;
    minWithdraw?: string;
    settleFee: { insert: string; final: string };
    [k: string]: unknown;
  };
  artifacts: { wasm: string; zkey: string; vkey: string };
}

export interface RawDeployments {
  environment: Env;
  hub: { chainId: number; deployBlock: number; usdc: string; contracts: Record<string, string> };
  spokes: Record<string, { name: string; stack: Stack; deployBlock: number; usdc: string; contracts: Record<string, string> }>;
}

export interface HubContracts {
  HubCore: Address;
  DepositManager: Address;
  StakeManager: Address;
  LiquidityManager: Address;
}

export interface ResolvedHub {
  name: string;
  chainId: number;
  rpc: string[];
  usdc: Address;
  deployBlock: bigint;
  contracts: HubContracts;
}

export interface ResolvedSpoke {
  name: string;
  chainId: number;
  stack: Stack;
  rpc: string[];
  usdc: Address;
  deployBlock: bigint;
  spoke: Address;
}

export interface ResolvedParams {
  phiBps: bigint;
  relayerFeeBucket: bigint;
  minDeposit: bigint;
  maxDeposit: bigint;
  maxFastDeposit: bigint;
  minWithdraw: bigint;
  settleFeeInsert: bigint;
  settleFeeFinal: bigint;
}

/** sha256 hex (no prefix) pins, or undefined while still "TBD". */
export interface ArtifactPins {
  wasm?: string;
  zkey?: string;
  vkey?: string;
}

export interface ResolvedEnv {
  env: Env;
  hrp: string;
  hub: ResolvedHub;
  spokes: ResolvedSpoke[];
  params: ResolvedParams;
  artifacts: ArtifactPins;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function addr(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new ConfigError(`${what}: invalid address ${String(v)}`);
  return getAddress(v);
}

function uint(v: unknown, what: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new ConfigError(`${what}: expected a non-negative integer`);
}

function rpcs(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new ConfigError(`${what}: rpc list required`);
  return v.map((u) => {
    if (typeof u !== 'string') throw new ConfigError(`${what}: bad rpc`);
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError(`${what}: rpc must be http(s)`);
    return u;
  });
}

function pin(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(v);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Combine a raw config and deployments into a validated environment. */
export function resolveEnv(cfg: RawConfig, dep: RawDeployments): ResolvedEnv {
  if (!ENVS.includes(cfg.environment)) throw new ConfigError('bad environment');
  if (dep.environment !== cfg.environment) throw new ConfigError('deployments/config environment mismatch');
  if (dep.hub.chainId !== cfg.hub.chainId) throw new ConfigError('hub chainId mismatch between config and deployments');
  const c = dep.hub.contracts;
  const hub: ResolvedHub = {
    name: cfg.hub.name ?? 'eth',
    chainId: cfg.hub.chainId,
    rpc: rpcs(cfg.hub.rpc, 'hub'),
    usdc: addr(cfg.hub.usdc.startsWith('0x') ? cfg.hub.usdc : dep.hub.usdc, 'hub.usdc'),
    deployBlock: uint(dep.hub.deployBlock, 'hub.deployBlock'),
    contracts: {
      HubCore: addr(c.HubCore, 'HubCore'),
      DepositManager: addr(c.DepositManager, 'DepositManager'),
      StakeManager: addr(c.StakeManager, 'StakeManager'),
      LiquidityManager: addr(c.LiquidityManager, 'LiquidityManager'),
    },
  };
  const spokes: ResolvedSpoke[] = cfg.spokes.map((s) => {
    const d = dep.spokes[String(s.chainId)];
    if (!d) throw new ConfigError(`deployments missing spoke ${s.chainId}`);
    const stack = s.stack ?? d.stack;
    if (stack !== 'opstack' && stack !== 'arbitrum') throw new ConfigError(`spoke ${s.chainId}: bad stack`);
    return {
      name: s.name,
      chainId: s.chainId,
      stack,
      rpc: rpcs(s.rpc, s.name),
      usdc: addr(s.usdc.startsWith('0x') ? s.usdc : d.usdc, `${s.name}.usdc`),
      deployBlock: uint(d.deployBlock, `${s.name}.deployBlock`),
      spoke: addr(d.contracts.Spoke, `${s.name}.Spoke`),
    };
  });
  const p = cfg.params;
  const params: ResolvedParams = {
    phiBps: uint(p.phiBps, 'phiBps'),
    relayerFeeBucket: uint(p.relayerFeeBucket, 'relayerFeeBucket'),
    minDeposit: uint(p.minDeposit, 'minDeposit'),
    maxDeposit: uint(p.maxDeposit, 'maxDeposit'),
    maxFastDeposit: uint(p.maxFastDeposit, 'maxFastDeposit'),
    minWithdraw: uint(p.minWithdraw ?? '0', 'minWithdraw'),
    settleFeeInsert: uint(p.settleFee.insert, 'settleFee.insert'),
    settleFeeFinal: uint(p.settleFee.final, 'settleFee.final'),
  };
  if (params.relayerFeeBucket === 0n) throw new ConfigError('relayerFeeBucket must be > 0');
  if (params.phiBps > 10_000n) throw new ConfigError('phiBps > 10000');
  return {
    env: cfg.environment,
    hrp: cfg.hrp,
    hub,
    spokes,
    params,
    artifacts: { wasm: pin(cfg.artifacts?.wasm), zkey: pin(cfg.artifacts?.zkey), vkey: pin(cfg.artifacts?.vkey) },
  };
}

/** CLI chain aliases: eth | base | arb (or a numeric chain id). */
export function chainIdFor(env: ResolvedEnv, alias: string): number {
  const a = alias.toLowerCase();
  if (a === 'eth' || a === 'ethereum' || a === 'hub' || a === env.hub.name.toLowerCase()) return env.hub.chainId;
  for (const s of env.spokes) {
    const n = s.name.toLowerCase();
    if (a === n || (a === 'arb' && n === 'arbitrum') || (a === 'base' && n === 'base')) return s.chainId;
  }
  if (/^[0-9]+$/.test(a)) {
    const id = Number(a);
    if (id === env.hub.chainId || env.spokes.some((s) => s.chainId === id)) return id;
  }
  throw new ConfigError(`unknown chain "${alias}" (use eth|base|arb)`);
}

export function chainName(env: ResolvedEnv, chainId: number): string {
  if (chainId === env.hub.chainId) return 'eth';
  const s = env.spokes.find((x) => x.chainId === chainId);
  if (!s) return String(chainId);
  return s.name === 'arbitrum' ? 'arb' : s.name;
}
