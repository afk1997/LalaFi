import { join } from 'node:path';
import {
  KvStore,
  Metrics,
  closeServer,
  createLogger,
  createProtocolContext,
  createShutdown,
  envBig,
  envBool,
  envInt,
  envStr,
  loadAccount,
  loadConfig,
  runLoop,
  startOpsServer,
} from '@xpool/service-common';
import { CctpCompleter } from './cctp.js';
import { defaultIrisBase } from './iris.js';
import { QueueProcessor, Rebalancer } from './rebalancer.js';

async function main() {
  const logger = createLogger('keeper');
  const shutdown = createShutdown(logger);
  const cfg = loadConfig();
  const env = process.env;
  const tickMs = envInt(env, 'KEEPER_TICK_MS', cfg.isLocal ? 3_000 : 60_000);
  const stateDir = envStr(env, 'STATE_DIR', join(cfg.root, '.xpool', 'keeper'));
  const irisBase = envStr(env, 'KEEPER_IRIS_URL', defaultIrisBase(cfg.env));
  const account = loadAccount('KEEPER_PRIVATE_KEY');
  const ctx = createProtocolContext(cfg, account);
  const metrics = new Metrics('keeper');
  const kv = new KvStore(join(stateDir, 'keeper.sqlite'), 'keeper');
  shutdown.onShutdown(() => kv.close());

  const rebalancer = new Rebalancer(
    ctx,
    Math.max(3000, envInt(env, 'KEEPER_ARB_MARGIN_BPS', 3000)),
    envInt(env, 'KEEPER_REBALANCE_COOLDOWN_SEC', cfg.isLocal ? 30 : 900) * 1000,
    logger,
    metrics,
  );
  const cctp = new CctpCompleter(ctx, kv.scoped('cctp'), irisBase, logger, metrics);
  const queue = new QueueProcessor(ctx, envBig(env, 'KEEPER_QUEUE_MAX_ITEMS', 16n), logger);

  let lastOk = Date.now();
  const ops = await startOpsServer(metrics, envInt(env, 'METRICS_PORT', 9104), () => ({ ok: Date.now() - lastOk < 10 * tickMs + 60_000 }));
  shutdown.onShutdown(() => closeServer(ops));
  const loop = (name: string, tick: () => Promise<void>) =>
    void runLoop(
      name,
      async () => {
        await tick();
        lastOk = Date.now();
      },
      { intervalMs: tickMs, signal: shutdown.signal, logger },
    );

  if (envBool(env, 'KEEPER_REBALANCE_ENABLED', true)) loop('rebalance', () => rebalancer.tick());
  loop('cctp', async () => {
    await cctp.discover();
    await cctp.complete();
  });
  loop('queue', () => queue.tick());

  logger.info('keeper started', { address: account.address, env: cfg.env, iris: irisBase.startsWith('https://iris') ? irisBase : 'custom' });
}

main().catch((err) => {
  createLogger('keeper').error('fatal', { err });
  process.exit(1);
});
