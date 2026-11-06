import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import type { Stack } from './types.js';

/**
 * Loads `config/<env>.json` (PRD 14.6) and `deployments/<env>.json` (docs/IMPLEMENTATION.md)
 * and resolves them into one typed object. For `local`, every `DEPLOYED_MOCK` placeholder is
 * replaced from `deployments.mocks`.
 *
 * Environment:
 *   XPOOL_ENV            local | testnet | mainnet (default local)
 *   XPOOL_ROOT           repo root holding config/ and deployments/ (default: search upward from cwd)
 *   XPOOL_RPC_<chainId>  comma-separated RPC override for a chain (e.g. docker hostnames)
 */

export type Environment = 'local' | 'testnet' | 'mainnet';

const addr = z.string();
const big = z.union([z.string(), z.number()]).transform((v) => BigInt(v));
const ratio = z.tuple([z.number(), z.number()]).transform(([n, d]) => [BigInt(n), BigInt(d)] as const);
const cctpSchema = z.object({ domain: z.number().int(), tokenMessengerV2: addr, messageTransmitterV2: addr });

const configSchema = z.object({
  environment: z.enum(['local', 'testnet', 'mainnet']),
  hub: z.object({ name: z.string(), chainId: z.number().int(), rpc: z.array(z.string()).min(1), usdc: addr, cctp: cctpSchema }),
  spokes: z.array(
    z.object({
      name: z.string(),
      chainId: z.number().int(),
      stack: z.enum(['opstack', 'arbitrum']),
      rpc: z.array(z.string()).min(1),
      usdc: addr,
      l1: z.record(z.string(), addr),
      l2: z.record(z.string(), addr).optional(),
      cctp: cctpSchema,
    }),
  ),
  params: z.object({
    phiBps: z.number(),
    relayerFeeBucket: big,
    minDeposit: big,
    maxDeposit: big,
    maxFastDeposit: big,
    minWithdraw: big,
    settleFee: z.object({ insert: big, final: big }),
    k: ratio,
    theta: ratio,
    beta: ratio,
    sMin: big,
    epochSeconds: z.number(),
    unbondSeconds: z.number(),
    maxBatch: z.number(),
    maxCheckpoint: z.number(),
    minEmptyCheckpointInterval: z.number(),
    targetBps: z.record(z.string(), z.number()),
    minRebalance: big,
    minGasL2: z.number(),
    minGasL1: z.number(),
  }),
  mocks: z.object({ l1ToL2DelaySeconds: z.number(), l2ToL1DelaySeconds: z.number(), cctpDelaySeconds: z.number() }).optional(),
});

const contractsSchema = z.record(z.string(), addr);
const deploymentsSchema = z.object({
  environment: z.string(),
  deployer: addr.optional(),
  hub: z.object({ chainId: z.number().int(), deployBlock: z.number().int().default(0), usdc: addr, contracts: contractsSchema }),
  spokes: z.record(
    z.string(),
    z.object({
      name: z.string(),
      stack: z.enum(['opstack', 'arbitrum']),
      deployBlock: z.number().int().default(0),
      usdc: addr,
      contracts: contractsSchema,
    }),
  ),
  mocks: z.record(z.string(), contractsSchema).optional(),
});

export type RawConfig = z.infer<typeof configSchema>;
export type RawDeployments = z.infer<typeof deploymentsSchema>;
export type Params = RawConfig['params'];

export interface CctpConfig {
  domain: number;
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
}

export interface HubConfig {
  name: string;
  chainId: number;
  rpc: string[];
  deployBlock: bigint;
  usdc: Address;
  cctp: CctpConfig;
  contracts: {
    HubCore: Address;
    DepositManager: Address;
    StakeManager: Address;
    LiquidityManager: Address;
    OpStackHubAdapter: Address;
    ArbitrumHubAdapter: Address;
  };
}

export interface SpokeConfig {
  name: string;
  chainId: number;
  stack: Stack;
  rpc: string[];
  deployBlock: bigint;
  usdc: Address;
  spoke: Address;
  /** Hub-side adapter for this spoke. */
  hubAdapter: Address;
  cctp: CctpConfig;
  /** opstack: l1CrossDomainMessenger, optimismPortal, (optional) disputeGameFactory. arbitrum: inbox, bridge, outbox. */
  l1: Record<string, Address>;
  l2: Record<string, Address>;
}

export interface XpoolConfig {
  env: Environment;
  root: string;
  hub: HubConfig;
  spokes: SpokeConfig[];
  params: Params;
  mocks?: { l1ToL2DelaySeconds: number; l2ToL1DelaySeconds: number; cctpDelaySeconds: number };
  /** Local mock contract addresses by chain id (local only). */
  mockContracts: Record<string, Record<string, Address>>;
  isLocal: boolean;
}

export const PLACEHOLDER = 'DEPLOYED_MOCK';

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'config')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('cannot locate repo root (set XPOOL_ROOT)');
    dir = parent;
  }
}

function asAddress(value: string | undefined, what: string): Address {
  if (!value || value === PLACEHOLDER || !isAddress(value)) throw new Error(`config: missing/invalid address for ${what}`);
  return getAddress(value);
}

function pick(value: string | undefined, fallback: string | undefined, what: string): Address {
  return asAddress(value && value !== PLACEHOLDER ? value : fallback, what);
}

function rpcOverride(chainId: number, rpcs: string[], env: NodeJS.ProcessEnv): string[] {
  const o = env[`XPOOL_RPC_${chainId}`];
  return o ? o.split(',').map((s) => s.trim()).filter(Boolean) : rpcs;
}

/** Pure resolution step (unit-testable without the filesystem). */
export function resolveConfig(raw: unknown, rawDeployments: unknown, root: string, env: NodeJS.ProcessEnv = {}): XpoolConfig {
  const cfg = configSchema.parse(raw);
  const dep = deploymentsSchema.parse(rawDeployments);
  if (dep.hub.chainId !== cfg.hub.chainId) throw new Error('deployments hub chain id does not match config');
  const mocks = (dep.mocks ?? {}) as Record<string, Record<string, string>>;
  const hubMocks = mocks[String(cfg.hub.chainId)] ?? {};
  const c = dep.hub.contracts;

  const hub: HubConfig = {
    name: cfg.hub.name,
    chainId: cfg.hub.chainId,
    rpc: rpcOverride(cfg.hub.chainId, cfg.hub.rpc, env),
    deployBlock: BigInt(dep.hub.deployBlock),
    usdc: pick(cfg.hub.usdc, dep.hub.usdc, 'hub.usdc'),
    cctp: {
      domain: cfg.hub.cctp.domain,
      tokenMessengerV2: pick(cfg.hub.cctp.tokenMessengerV2, hubMocks.MockTokenMessengerV2, 'hub.cctp.tokenMessengerV2'),
      messageTransmitterV2: pick(cfg.hub.cctp.messageTransmitterV2, hubMocks.MockMessageTransmitterV2, 'hub.cctp.messageTransmitterV2'),
    },
    contracts: {
      HubCore: asAddress(c.HubCore, 'HubCore'),
      DepositManager: asAddress(c.DepositManager, 'DepositManager'),
      StakeManager: asAddress(c.StakeManager, 'StakeManager'),
      LiquidityManager: asAddress(c.LiquidityManager, 'LiquidityManager'),
      OpStackHubAdapter: asAddress(c.OpStackHubAdapter, 'OpStackHubAdapter'),
      ArbitrumHubAdapter: asAddress(c.ArbitrumHubAdapter, 'ArbitrumHubAdapter'),
    },
  };

  const spokes: SpokeConfig[] = cfg.spokes.map((s) => {
    const d = dep.spokes[String(s.chainId)];
    if (!d) throw new Error(`deployments: missing spoke ${s.chainId}`);
    if (d.stack !== s.stack) throw new Error(`deployments: stack mismatch for spoke ${s.chainId}`);
    const sm = mocks[String(s.chainId)] ?? {};
    const l1: Record<string, Address> = {};
    const l2: Record<string, Address> = {};
    const l1Fallback: Record<string, string | undefined> = {
      l1CrossDomainMessenger: hubMocks.MockL1CrossDomainMessenger,
      inbox: hubMocks.MockInbox,
      bridge: hubMocks.MockBridge,
      outbox: hubMocks.MockOutbox,
    };
    for (const [k, v] of Object.entries(s.l1)) {
      if (v === PLACEHOLDER || isAddress(v)) {
        const resolved = v === PLACEHOLDER ? l1Fallback[k] : v;
        // optimismPortal is the zero address locally (no portal); keep it as-is.
        if (resolved && isAddress(resolved)) l1[k] = getAddress(resolved);
        else throw new Error(`config: cannot resolve spoke ${s.chainId} l1.${k}`);
      }
    }
    for (const [k, v] of Object.entries(s.l2 ?? {})) {
      l2[k] = pick(v, k === 'l2CrossDomainMessenger' ? sm.MockL2CrossDomainMessenger : undefined, `spoke ${s.chainId} l2.${k}`);
    }
    return {
      name: s.name,
      chainId: s.chainId,
      stack: s.stack,
      rpc: rpcOverride(s.chainId, s.rpc, env),
      deployBlock: BigInt(d.deployBlock),
      usdc: pick(s.usdc, d.usdc, `spoke ${s.chainId} usdc`),
      spoke: asAddress(d.contracts.Spoke, `spoke ${s.chainId} Spoke`),
      hubAdapter: s.stack === 'opstack' ? hub.contracts.OpStackHubAdapter : hub.contracts.ArbitrumHubAdapter,
      cctp: {
        domain: s.cctp.domain,
        tokenMessengerV2: pick(s.cctp.tokenMessengerV2, sm.MockTokenMessengerV2, `spoke ${s.chainId} cctp.tokenMessengerV2`),
        messageTransmitterV2: pick(s.cctp.messageTransmitterV2, sm.MockMessageTransmitterV2, `spoke ${s.chainId} cctp.messageTransmitterV2`),
      },
      l1,
      l2,
    };
  });

  const mockContracts: Record<string, Record<string, Address>> = {};
  for (const [chain, entries] of Object.entries(mocks)) {
    mockContracts[chain] = Object.fromEntries(
      Object.entries(entries).filter(([, v]) => isAddress(v)).map(([k, v]) => [k, getAddress(v)]),
    );
  }

  return {
    env: cfg.environment,
    root,
    hub,
    spokes,
    params: cfg.params,
    ...(cfg.mocks ? { mocks: cfg.mocks } : {}),
    mockContracts,
    isLocal: cfg.environment === 'local',
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): XpoolConfig {
  const name = (env.XPOOL_ENV ?? 'local') as Environment;
  if (!['local', 'testnet', 'mainnet'].includes(name)) throw new Error(`bad XPOOL_ENV ${name}`);
  const root = env.XPOOL_ROOT ? resolve(env.XPOOL_ROOT) : findRepoRoot();
  const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as unknown;
  const cfg = read(`config/${name}.json`);
  const depPath = `deployments/${name}.json`;
  if (!existsSync(join(root, depPath))) throw new Error(`missing ${depPath}; deploy first`);
  return resolveConfig(cfg, read(depPath), root, env);
}

export function spokeById(cfg: XpoolConfig, chainId: number | bigint): SpokeConfig {
  const s = cfg.spokes.find((x) => x.chainId === Number(chainId));
  if (!s) throw new Error(`unknown spoke chain ${chainId}`);
  return s;
}

/** Chain id for a CCTP domain (hub or spoke). */
export function chainIdForDomain(cfg: XpoolConfig, domain: number): number | undefined {
  if (cfg.hub.cctp.domain === domain) return cfg.hub.chainId;
  return cfg.spokes.find((s) => s.cctp.domain === domain)?.chainId;
}

/** Small env helpers for service-specific settings. */
export function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

export function envBig(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const v = env[name];
  return v === undefined || v === '' ? fallback : BigInt(v);
}

export function envStr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name]?.toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}
