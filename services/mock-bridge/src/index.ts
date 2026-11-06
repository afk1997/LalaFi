import { join } from 'node:path';
import type { Hex } from 'viem';
import { z } from 'zod';
import {
  HttpError,
  KvStore,
  Metrics,
  closeServer,
  createJsonServer,
  createLogger,
  createProtocolContext,
  createShutdown,
  envInt,
  envStr,
  listen,
  loadAccount,
  loadConfig,
  runLoop,
  startOpsServer,
  type ChainClients,
} from '@xpool/service-common';
import { attest, decodeMockMessage, irisResponse, IrisStore } from './cctp.js';
import { deliver } from './deliver.js';
import { DelayQueue, FailureInjector, ROUTES, retryDelayMs, type RouteName, type Scheduled } from './queue.js';
import { buildCctpSources, buildSources, scanNext } from './watchers.js';

/** LOCAL ONLY: relays mock OP / Arbitrum messages and attests mock CCTP burns (PRD 14.1). */

interface DoneRecord {
  tx: Hex;
  ok: boolean;
  at: number;
  item: Scheduled;
}

const MAX_ATTEMPTS = 8;

async function main() {
  const logger = createLogger('mock-bridge');
  const shutdown = createShutdown(logger);
  const cfg = loadConfig();
  if (!cfg.isLocal) throw new Error('mock-bridge is LOCAL ONLY (XPOOL_ENV=local)');
  const env = process.env;
  const account = loadAccount('MOCK_BRIDGE_PRIVATE_KEY'); // mock relayer + CCTP attester (acct 1)
  const ctx = createProtocolContext(cfg, account);
  const chains = new Map<number, ChainClients>([[cfg.hub.chainId, ctx.hub], ...[...ctx.spokes].map(([id, s]) => [id, s.clients] as const)]);
  const kv = new KvStore(join(envStr(env, 'STATE_DIR', join(cfg.root, '.xpool', 'mock-bridge')), 'mock-bridge.sqlite'), 'mock-bridge');
  shutdown.onShutdown(() => kv.close());
  const metrics = new Metrics('mock-bridge');
  const delivered = metrics.counter('mock_deliveries_total', 'Mock deliveries', ['route', 'outcome']);

  const delays = {
    l1ToL2: envInt(env, 'MOCK_L1_TO_L2_DELAY_SEC', cfg.mocks?.l1ToL2DelaySeconds ?? 5) * 1000,
    l2ToL1: envInt(env, 'MOCK_L2_TO_L1_DELAY_SEC', cfg.mocks?.l2ToL1DelaySeconds ?? 60) * 1000,
    cctp: envInt(env, 'MOCK_CCTP_DELAY_SEC', cfg.mocks?.cctpDelaySeconds ?? 10) * 1000,
  };
  const delayOf = (r: RouteName) => (r === 'op-l1-to-l2' || r === 'arb-l1-to-l2' ? delays.l1ToL2 : delays.l2ToL1);

  const queue = new DelayQueue();
  for (const [, item] of kv.list<Scheduled>('pending:')) queue.add(item);
  const injector = new FailureInjector(env.MOCK_FAIL_NEXT);
  const iris = new IrisStore(kv.scoped('iris'));

  const schedule = (item: Scheduled) => {
    kv.set(`pending:${item.key}`, item);
    queue.add(item);
  };

  // ------------------------------------------------------------------ scanning
  const sources = buildSources(cfg, ctx.hub, new Map([...ctx.spokes].map(([id, s]) => [id, s.clients])));
  const cctpSources = buildCctpSources(cfg, ctx.hub, new Map([...ctx.spokes].map(([id, s]) => [id, s.clients])));

  void runLoop(
    'scan',
    async () => {
      const now = Date.now();
      for (const src of sources) {
        await scanNext(kv, src.name, src, (items) => {
          for (const o of items) {
            if (kv.get(`done:${o.key}`) || kv.get(`pending:${o.key}`)) continue;
            schedule({ key: o.key, dueAt: now + delayOf(o.delivery.route), delivery: o.delivery, attempts: 0, lowGas: false });
            logger.info('message observed', { route: o.delivery.route, key: o.key });
          }
        });
      }
      for (const src of cctpSources) {
        await scanNext(kv, `cctp:${src.chainId}`, src, async (items) => {
          for (const m of items) {
            const decoded = decodeMockMessage(m.message);
            iris.add(src.domain, m.txHash, { message: m.message, attestation: await attest(account, m.message), eventNonce: decoded.nonce.toString(), readyAt: now + delays.cctp });
            logger.info('CCTP burn attested', { srcDomain: src.domain, dstDomain: decoded.dstDomain, nonce: decoded.nonce });
          }
        });
      }
    },
    { intervalMs: 1_000, signal: shutdown.signal, logger },
  );

  // ------------------------------------------------------------------ delivering (sequential: one nonce stream, no interleaved impersonation)
  void runLoop(
    'deliver',
    async () => {
      for (const item of queue.takeDue(Date.now())) {
        const lowGas = item.lowGas || injector.consume(item.delivery.route);
        try {
          const r = await deliver(cfg, chains, item.delivery, lowGas);
          kv.delete(`pending:${item.key}`);
          kv.set(`done:${item.key}`, { tx: r.tx, ok: r.ok, at: Date.now(), item } satisfies DoneRecord);
          delivered.inc({ route: item.delivery.route, outcome: r.ok ? 'ok' : 'call_failed' });
          (r.ok ? logger.info : logger.warn)('delivered', { route: item.delivery.route, key: item.key, ok: r.ok, lowGas, tx: r.tx });
        } catch (err) {
          const attempts = item.attempts + 1;
          delivered.inc({ route: item.delivery.route, outcome: 'error' });
          if (attempts >= MAX_ATTEMPTS) {
            kv.delete(`pending:${item.key}`);
            kv.set(`done:${item.key}`, { tx: '0x', ok: false, at: Date.now(), item } satisfies DoneRecord);
            logger.error('delivery abandoned', { key: item.key, err });
          } else {
            schedule({ ...item, attempts, dueAt: Date.now() + retryDelayMs(attempts) });
            logger.warn('delivery failed; will retry', { key: item.key, attempts, err });
          }
        }
      }
    },
    { intervalMs: 500, signal: shutdown.signal, logger },
  );

  // ------------------------------------------------------------------ HTTP: Iris-compatible + admin
  const failSchema = z.strictObject({ route: z.enum(ROUTES as [RouteName, ...RouteName[]]), count: z.number().int().min(0).max(100) });
  const redeliverSchema = z.strictObject({ key: z.string().max(200) });
  const server = createJsonServer({
    logger,
    routes: [
      {
        method: 'GET',
        path: '/v2/messages/:srcDomain',
        cost: 0,
        handler: async ({ params, query }) => {
          const tx = query.get('transactionHash') ?? '';
          if (!/^\d+$/.test(params.srcDomain ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new HttpError(400, 'bad_request');
          const r = irisResponse(iris.get(Number(params.srcDomain), tx as Hex), Date.now());
          return { status: r.status, body: r.body };
        },
      },
      {
        method: 'POST',
        path: '/admin/fail-next',
        cost: 0,
        handler: async ({ body }) => {
          const p = failSchema.safeParse(body);
          if (!p.success) throw new HttpError(400, 'bad_request');
          injector.set(p.data.route, p.data.count);
          return { body: { failNext: injector.snapshot() } };
        },
      },
      {
        method: 'POST',
        path: '/admin/redeliver',
        cost: 0,
        handler: async ({ body }) => {
          const p = redeliverSchema.safeParse(body);
          if (!p.success) throw new HttpError(400, 'bad_request');
          const done = kv.get<DoneRecord>(`done:${p.data.key}`);
          if (!done) throw new HttpError(404, 'unknown_key');
          kv.delete(`done:${p.data.key}`);
          schedule({ ...done.item, attempts: 0, lowGas: false, dueAt: Date.now() });
          return { body: { scheduled: p.data.key } };
        },
      },
      {
        method: 'GET',
        path: '/admin/status',
        cost: 0,
        handler: async () => ({
          body: {
            pending: queue.list().map((i) => ({ key: i.key, route: i.delivery.route, dueAt: i.dueAt, attempts: i.attempts })),
            failed: kv.list<DoneRecord>('done:').filter(([, d]) => !d.ok).map(([k, d]) => ({ key: k.slice(5), route: d.item.delivery.route, tx: d.tx })),
            failNext: injector.snapshot(),
          },
        }),
      },
    ],
  });
  await listen(server, envInt(env, 'MOCK_BRIDGE_PORT', 8090), envStr(env, 'MOCK_BRIDGE_HOST', '0.0.0.0'));
  shutdown.onShutdown(() => closeServer(server));
  const ops = await startOpsServer(metrics, envInt(env, 'METRICS_PORT', 9105), () => ({ ok: true, details: { pending: queue.size } }));
  shutdown.onShutdown(() => closeServer(ops));

  logger.info('mock-bridge started', { relayer: account.address, delays });
}

main().catch((err) => {
  createLogger('mock-bridge').error('fatal', { err });
  process.exit(1);
});
