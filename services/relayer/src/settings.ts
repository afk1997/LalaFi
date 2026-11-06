import { join } from 'node:path';
import { envBig, envInt, envStr, type XpoolConfig } from '@xpool/service-common';
import { parseUsdc } from './fees.js';

/** Relayer settings from environment variables (keys are loaded separately, env only). */
export interface RelayerSettings {
  port: number;
  host: string;
  metricsPort: number;
  dbPath: string;
  ethPriceUsdc: bigint;
  feeMarginBps: bigint;
  flatFee: bigint;
  transactGas: bigint;
  arbMarginBps: number;
  quoteTtlSec: number;
  minDeadlineSec: bigint;
  maxBodyBytes: number;
  rateLimit: { perKey: { capacity: number; refillPerSec: number }; global: { capacity: number; refillPerSec: number } };
  resendAfterSec: { opstack: number; arbitrum: number };
  maxResends: number;
  monitorIntervalMs: number;
  /** Browser origins allowed to call the API (apps/web). */
  corsOrigins: string[];
}

export function loadSettings(cfg: XpoolConfig, env: NodeJS.ProcessEnv = process.env): RelayerSettings {
  const stateDir = envStr(env, 'STATE_DIR', join(cfg.root, '.xpool', 'relayer'));
  return {
    port: envInt(env, 'RELAYER_PORT', 8080),
    corsOrigins: envStr(env, 'RELAYER_CORS_ORIGINS', cfg.isLocal ? 'http://localhost:5173,http://127.0.0.1:5173' : '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    host: envStr(env, 'RELAYER_HOST', '0.0.0.0'),
    metricsPort: envInt(env, 'METRICS_PORT', 9101),
    dbPath: join(stateDir, 'relayer.sqlite'),
    // ETH price in the pool token's base units (USDC-style 6-decimal input, scaled to e.g. 18 for DAI).
    ethPriceUsdc: parseUsdc(envStr(env, 'RELAYER_ETH_PRICE_USDC', '3000')) * 10n ** BigInt(Math.max(0, cfg.token.decimals - 6)),
    feeMarginBps: envBig(env, 'RELAYER_FEE_MARGIN_BPS', 2000n),
    flatFee: envBig(env, 'RELAYER_FLAT_FEE', 0n),
    transactGas: envBig(env, 'RELAYER_TRANSACT_GAS', 900_000n),
    arbMarginBps: Math.max(3000, envInt(env, 'RELAYER_ARB_MARGIN_BPS', 3000)),
    quoteTtlSec: envInt(env, 'RELAYER_QUOTE_TTL_SEC', 300),
    minDeadlineSec: envBig(env, 'RELAYER_MIN_DEADLINE_SEC', 60n),
    maxBodyBytes: envInt(env, 'RELAYER_MAX_BODY_BYTES', 32 * 1024),
    rateLimit: {
      perKey: { capacity: envInt(env, 'RELAYER_RL_PER_CLIENT_BURST', 20), refillPerSec: envInt(env, 'RELAYER_RL_PER_CLIENT_PER_SEC', 1) },
      global: { capacity: envInt(env, 'RELAYER_RL_GLOBAL_BURST', 200), refillPerSec: envInt(env, 'RELAYER_RL_GLOBAL_PER_SEC', 20) },
    },
    resendAfterSec: {
      opstack: envInt(env, 'RELAYER_RESEND_AFTER_OP_SEC', cfg.isLocal ? 60 : 1800),
      arbitrum: envInt(env, 'RELAYER_RESEND_AFTER_ARB_SEC', cfg.isLocal ? 60 : 3600),
    },
    maxResends: envInt(env, 'RELAYER_MAX_RESENDS', 3),
    monitorIntervalMs: envInt(env, 'RELAYER_MONITOR_INTERVAL_MS', cfg.isLocal ? 5_000 : 30_000),
  };
}
