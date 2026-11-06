import {
  KvStore,
  Metrics,
  RateLimiter,
  ReleaseMonitor,
  closeServer,
  createJsonServer,
  createLogger,
  createProtocolContext,
  createShutdown,
  listen,
  loadAccount,
  loadConfig,
  runLoop,
  spokeById,
  startOpsServer,
} from '@xpool/service-common';
import { relayerRoutes } from './api.js';
import { RelayService, readHubParams } from './service.js';
import { loadSettings } from './settings.js';
import { RequestStore } from './store.js';

async function main() {
  const logger = createLogger('relayer');
  const shutdown = createShutdown(logger);
  const cfg = loadConfig();
  const settings = loadSettings(cfg);
  const account = loadAccount('RELAYER_PRIVATE_KEY');
  const ctx = createProtocolContext(cfg, account);
  const metrics = new Metrics('relayer');
  const kv = new KvStore(settings.dbPath, 'relayer');
  shutdown.onShutdown(() => kv.close());

  const params = await readHubParams(ctx);
  const monitor = new ReleaseMonitor({
    ctx,
    kv: kv.scoped('releases'),
    logger,
    metrics,
    resendAfterMs: (dst) => 1000 * settings.resendAfterSec[spokeById(cfg, dst).stack],
    maxResends: settings.maxResends,
    marginBps: settings.arbMarginBps,
    refundAddress: account.address,
  });
  const store = new RequestStore(kv.scoped('requests'));
  const svc = new RelayService(ctx, params, settings, store, monitor, logger, metrics);

  const httpRequests = metrics.counter('relayer_http_requests_total', 'HTTP requests', ['route', 'status']);
  const server = createJsonServer({
    routes: relayerRoutes(svc),
    logger,
    maxBodyBytes: settings.maxBodyBytes,
    rateLimiter: new RateLimiter(settings.rateLimit),
    onRequest: (route, status) => httpRequests.inc({ route, status: String(status) }),
  });
  await listen(server, settings.port, settings.host);
  shutdown.onShutdown(() => closeServer(server));

  const balance = metrics.gauge('relayer_eth_balance_wei', 'Relayer ETH balance on the hub');
  let healthy = true;
  const ops = await startOpsServer(metrics, settings.metricsPort, () => ({ ok: healthy }));
  shutdown.onShutdown(() => closeServer(ops));

  logger.info('relayer started', { address: account.address, port: settings.port, env: cfg.env });

  void runLoop(
    'release-monitor',
    async () => {
      await monitor.tick();
      store.prune();
      svc.pruneMemory();
      balance.set(Number(await ctx.hub.public.getBalance({ address: account.address })));
      healthy = true;
    },
    { intervalMs: settings.monitorIntervalMs, signal: shutdown.signal, logger, onError: () => (healthy = false) },
  );
}

main().catch((err) => {
  createLogger('relayer').error('fatal', { err });
  process.exit(1);
});
