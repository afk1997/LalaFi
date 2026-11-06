import { join } from 'node:path';
import { envBig, envBool, envInt, envStr, type XpoolConfig } from '@xpool/service-common';
import { parseAllocations } from './bootstrap.js';

export interface ValidatorSettings {
  /** Testnet only: sign at latest - N instead of the L2 finalized tag. */
  l2Confirmations?: bigint;
  port: number;
  host: string;
  metricsPort: number;
  stateDir: string;
  peers: string[];
  tickMs: number;
  submitStaggerMs: number;
  allowSingleRpc: boolean;
  enable: { submitter: boolean; watchtower: boolean; epochKeeper: boolean };
  bootstrap?: { bond: bigint; allocations?: Map<bigint, bigint> };
}

export function loadSettings(cfg: XpoolConfig, env: NodeJS.ProcessEnv = process.env): ValidatorSettings {
  const bond = envBig(env, 'VALIDATOR_BOOTSTRAP_BOND', 0n);
  const allocations = parseAllocations(env.VALIDATOR_BOOTSTRAP_ALLOCATIONS);
  const peers = (env.VALIDATOR_PEERS ?? '')
    .split(',')
    .map((p) => p.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const p of peers) if (!/^https?:\/\//.test(p)) throw new Error(`bad peer url ${p}`);
  const conf = env.VALIDATOR_L2_CONFIRMATIONS;
  if (conf !== undefined && cfg.env === 'mainnet') {
    throw new Error('VALIDATOR_L2_CONFIRMATIONS is testnet-only; mainnet validators sign at the finalized tag');
  }
  if (conf !== undefined && !/^[0-9]+$/.test(conf)) throw new Error('VALIDATOR_L2_CONFIRMATIONS must be a block count');
  return {
    l2Confirmations: conf === undefined ? undefined : BigInt(conf),
    port: envInt(env, 'VALIDATOR_PORT', 7000),
    host: envStr(env, 'VALIDATOR_HOST', '0.0.0.0'),
    metricsPort: envInt(env, 'METRICS_PORT', 9102),
    stateDir: envStr(env, 'STATE_DIR', join(cfg.root, '.xpool', 'validator')),
    peers,
    tickMs: envInt(env, 'VALIDATOR_TICK_MS', cfg.isLocal ? 2_000 : 15_000),
    submitStaggerMs: envInt(env, 'VALIDATOR_SUBMIT_STAGGER_MS', cfg.isLocal ? 3_000 : 30_000),
    allowSingleRpc: envBool(env, 'VALIDATOR_ALLOW_SINGLE_RPC', cfg.isLocal),
    enable: {
      submitter: envBool(env, 'VALIDATOR_ENABLE_SUBMITTER', true),
      watchtower: envBool(env, 'VALIDATOR_ENABLE_WATCHTOWER', true),
      epochKeeper: envBool(env, 'VALIDATOR_ENABLE_EPOCH_KEEPER', true),
    },
    ...(bond > 0n ? { bootstrap: { bond, ...(allocations ? { allocations } : {}) } } : {}),
  };
}
