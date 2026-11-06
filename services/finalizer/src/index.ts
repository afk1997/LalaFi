import { join } from 'node:path';
import {
  KvStore,
  Metrics,
  ReleaseMonitor,
  closeServer,
  createLogger,
  createProtocolContext,
  createShutdown,
  loadAccount,
  loadConfig,
  runLoop,
  scanReleaseLogs,
  spokeById,
  startOpsServer,
} from '@xpool/service-common';
import { CheckpointSender, scanFastInserted, scanSentCheckpoints, type SentCheckpoint } from './checkpoints.js';
import { deliveryFor } from './delivery.js';
import { CheckpointProcessor } from './processor.js';
import { loadSettings } from './settings.js';

async function main() {
  const logger = createLogger('finalizer');
  const shutdown = createShutdown(logger);
  const cfg = loadConfig();
  const s = loadSettings(cfg);
  const account = loadAccount('FINALIZER_PRIVATE_KEY');
  const ctx = createProtocolContext(cfg, account);
  const metrics = new Metrics('finalizer');
  const kv = new KvStore(join(s.stateDir, 'finalizer.sqlite'), 'finalizer');
  shutdown.onShutdown(() => kv.close());

  const sender = new CheckpointSender(ctx, kv, s, logger, metrics);
  const processor = new CheckpointProcessor(ctx, kv, s.processChunk, s.maxProcessAttempts, logger, metrics);
  const monitor = new ReleaseMonitor({
    ctx,
    kv: kv.scoped('releases'),
    logger,
    metrics,
    resendAfterMs: (dst) => 1000 * s.resendAfterSec[spokeById(cfg, dst).stack],
    maxResends: s.maxResends,
    marginBps: s.arbMarginBps,
    refundAddress: account.address,
  });

  let lastOk = Date.now();
  const ops = await startOpsServer(metrics, s.metricsPort, () => ({ ok: Date.now() - lastOk < 10 * s.tickMs + 60_000 }));
  shutdown.onShutdown(() => closeServer(ops));
  const loop = (name: string, tick: () => Promise<void>) =>
    void runLoop(
      name,
      async () => {
        await tick();
        lastOk = Date.now();
      },
      { intervalMs: s.tickMs, signal: shutdown.signal, logger },
    );

  for (const spoke of ctx.spokes.values()) {
    const delivery = deliveryFor(ctx, spoke, s.arbAssertionLookbackBlocks, logger);
    loop(`checkpoints-${spoke.cfg.chainId}`, async () => {
      await scanSentCheckpoints(spoke, kv);
      await sender.tick(spoke);
      for (const [key, cp] of kv.list<SentCheckpoint>(`sent:${spoke.cfg.chainId}:`)) {
        if (cp.delivered) continue;
        const step = await delivery.step(cp);
        if (step === 'delivered') kv.set(key, { ...cp, delivered: true });
      }
    });
  }
  loop('process', async () => {
    await scanFastInserted(ctx, kv);
    await processor.scan();
    await processor.processAll();
  });
  loop('releases', async () => {
    await scanReleaseLogs(ctx, kv, monitor);
    await monitor.tick();
  });

  logger.info('finalizer started', { address: account.address, env: cfg.env });
}

main().catch((err) => {
  createLogger('finalizer').error('fatal', { err });
  process.exit(1);
});
