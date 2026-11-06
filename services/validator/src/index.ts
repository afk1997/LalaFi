import { join } from 'node:path';
import {
  KvStore,
  Metrics,
  RateLimiter,
  closeServer,
  createJsonServer,
  createLogger,
  createProtocolContext,
  createShutdown,
  listen,
  loadAccount,
  loadConfig,
  loadPrivateKey,
  openDatabase,
  runLoop,
  startOpsServer,
} from '@xpool/service-common';
import { AttestationSigner } from './attestation-signer.js';
import { Attester } from './attester.js';
import { bootstrapValidator } from './bootstrap.js';
import { ChainView } from './chain-view.js';
import { DepositStore } from './deposit-store.js';
import { EpochKeeper } from './epoch-keeper.js';
import { AttestationVerifier, GossipClient, gossipRoutes, type IngestDeps } from './gossip.js';
import { GossipStore } from './gossip-store.js';
import { loadSettings } from './settings.js';
import { LocalSigner } from './signer.js';
import { SlashingProtectionDb } from './slashing-db.js';
import { Submitter } from './submitter.js';
import { SpokeWatcher } from './watcher.js';
import { Watchtower } from './watchtower.js';

async function main() {
  const logger = createLogger('validator');
  const shutdown = createShutdown(logger);
  const cfg = loadConfig();
  const settings = loadSettings(cfg);

  // Two separate keys: the operator pays gas / holds stake; the signer only signs attestations.
  const operator = loadAccount('VALIDATOR_OPERATOR_KEY');
  const signer = new LocalSigner(loadPrivateKey('VALIDATOR_SIGNER_KEY'));
  if (operator.address.toLowerCase() === signer.address.toLowerCase()) throw new Error('signer key must differ from operator key');

  const ctx = createProtocolContext(cfg, operator);
  for (const c of [ctx.hub, ...[...ctx.spokes.values()].map((s) => s.clients)]) {
    if (c.perRpc.length < 2) {
      if (!settings.allowSingleRpc) throw new Error(`chain ${c.chainId}: at least 2 RPCs required for cross-checking`);
      logger.warn('only one RPC configured; cross-checking is degenerate', { chain: c.chainId });
    }
  }

  const metrics = new Metrics('validator');
  const eip = { hubChainId: BigInt(cfg.hub.chainId), depositManager: cfg.hub.contracts.DepositManager };
  const domain = `${cfg.hub.chainId}:${cfg.hub.contracts.DepositManager.toLowerCase()}`;
  const slashing = new SlashingProtectionDb(join(settings.stateDir, 'slashing-protection.sqlite'), domain);
  shutdown.onShutdown(() => slashing.close());
  const db = openDatabase(join(settings.stateDir, 'validator.sqlite'));
  shutdown.onShutdown(() => db.close());
  const kv = new KvStore(db, 'validator');
  const deposits = new DepositStore(db);
  const gossip = new GossipStore(db);
  const view = new ChainView(ctx);
  const attSigner = new AttestationSigner(signer, slashing, eip);

  if (settings.bootstrap) {
    await bootstrapValidator(ctx, view, kv, { signer: signer.address, mintIfShort: cfg.isLocal, ...settings.bootstrap }, logger);
  }

  const equivocations = metrics.counter('validator_equivocations_detected_total', 'Equivocations seen in gossip');
  const ingestDeps: IngestDeps = {
    verifier: new AttestationVerifier(ctx, eip, view),
    store: gossip,
    logger,
    onEquivocation: () => equivocations.inc(),
  };
  const client = new GossipClient(settings.peers, ingestDeps, logger, metrics);

  const server = createJsonServer({
    routes: gossipRoutes({ ...ingestDeps, ctx }),
    logger,
    maxBodyBytes: 512 * 1024,
    rateLimiter: new RateLimiter({ perKey: { capacity: 120, refillPerSec: 20 }, global: { capacity: 1000, refillPerSec: 200 } }),
  });
  await listen(server, settings.port, settings.host);
  shutdown.onShutdown(() => closeServer(server));

  let lastOk = Date.now();
  const ops = await startOpsServer(metrics, settings.metricsPort, () => ({ ok: Date.now() - lastOk < 10 * settings.tickMs + 60_000 }));
  shutdown.onShutdown(() => closeServer(ops));

  const loop = (name: string, tick: () => Promise<void>, intervalMs = settings.tickMs) =>
    void runLoop(
      name,
      async () => {
        await tick();
        lastOk = Date.now();
      },
      { intervalMs, signal: shutdown.signal, logger },
    );

  for (const s of ctx.spokes.values()) {
    const watcher = new SpokeWatcher(s, deposits, logger, metrics, undefined, settings.l2Confirmations);
    const attester = new Attester(s.cfg, deposits, gossip, attSigner, view, client, logger, metrics);
    loop(`watch-${s.cfg.chainId}`, () => watcher.tick());
    loop(`attest-${s.cfg.chainId}`, () => attester.tick());
    if (settings.enable.submitter) {
      const submitter = new Submitter(ctx, s.cfg, gossip, view, signer.address, settings.submitStaggerMs, logger, metrics);
      loop(`submit-${s.cfg.chainId}`, () => submitter.tick());
    }
  }
  if (settings.enable.watchtower) {
    const tower = new Watchtower(ctx, gossip, deposits, view, kv.scoped('watchtower'), ingestDeps, logger, metrics);
    loop('watchtower', () => tower.tick(), settings.tickMs * 2);
  }
  if (settings.enable.epochKeeper) {
    const keeper = new EpochKeeper(ctx, view, logger);
    loop('epoch-keeper', () => keeper.tick(), Math.max(settings.tickMs, 5_000));
  }
  loop(
    'prune',
    async () => {
      const epoch = await view.currentEpoch();
      for (const s of ctx.spokes.keys()) gossip.prune(BigInt(s), epoch > 3n ? epoch - 3n : 0n);
    },
    60_000,
  );

  logger.info('validator started', { operator: operator.address, signer: signer.address, peers: settings.peers.length, env: cfg.env });
}

main().catch((err) => {
  createLogger('validator').error('fatal', { err });
  process.exit(1);
});
