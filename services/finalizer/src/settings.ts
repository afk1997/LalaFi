import { join } from 'node:path';
import { envBig, envInt, envStr, type XpoolConfig } from '@xpool/service-common';

export interface FinalizerSettings {
  metricsPort: number;
  stateDir: string;
  tickMs: number;
  checkpointEveryN: bigint;
  checkpointEverySec: number;
  processChunk: bigint;
  maxProcessAttempts: number;
  resendAfterSec: { opstack: number; arbitrum: number };
  maxResends: number;
  arbMarginBps: number;
  arbAssertionLookbackBlocks: bigint;
}

export function loadSettings(cfg: XpoolConfig, env: NodeJS.ProcessEnv = process.env): FinalizerSettings {
  return {
    metricsPort: envInt(env, 'METRICS_PORT', 9103),
    stateDir: envStr(env, 'STATE_DIR', join(cfg.root, '.xpool', 'finalizer')),
    tickMs: envInt(env, 'FINALIZER_TICK_MS', cfg.isLocal ? 3_000 : 60_000),
    checkpointEveryN: envBig(env, 'FINALIZER_CHECKPOINT_EVERY_N', BigInt(cfg.params.maxCheckpoint)),
    checkpointEverySec: envInt(env, 'FINALIZER_CHECKPOINT_EVERY_SEC', cfg.isLocal ? 20 : 900),
    processChunk: envBig(env, 'FINALIZER_PROCESS_CHUNK', 64n),
    maxProcessAttempts: envInt(env, 'FINALIZER_MAX_PROCESS_ATTEMPTS', 5),
    // Longer than the relayer's so the relayer (which was paid) normally re-delivers first.
    resendAfterSec: {
      opstack: envInt(env, 'FINALIZER_RESEND_AFTER_OP_SEC', cfg.isLocal ? 120 : 3600),
      arbitrum: envInt(env, 'FINALIZER_RESEND_AFTER_ARB_SEC', cfg.isLocal ? 120 : 7200),
    },
    maxResends: envInt(env, 'FINALIZER_MAX_RESENDS', 3),
    arbMarginBps: Math.max(3000, envInt(env, 'FINALIZER_ARB_MARGIN_BPS', 3000)),
    arbAssertionLookbackBlocks: envBig(env, 'FINALIZER_ARB_LOOKBACK_BLOCKS', 50_000n),
  };
}
