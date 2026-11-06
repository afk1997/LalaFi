import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { listen } from './http.js';

/**
 * Per-service Prometheus registry (PRD 13.7) plus a separate ops server exposing
 * `/metrics` and `/healthz`. The ops port is meant to stay private (not the public API port).
 */
export class Metrics {
  readonly registry = new Registry();

  constructor(readonly service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry, prefix: 'xpool_' });
  }

  counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
    return new Counter({ name: `xpool_${name}`, help, labelNames, registers: [this.registry] });
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
    return new Gauge({ name: `xpool_${name}`, help, labelNames, registers: [this.registry] });
  }

  histogram(name: string, help: string, labelNames: string[] = [], buckets?: number[]): Histogram<string> {
    return new Histogram({
      name: `xpool_${name}`,
      help,
      labelNames,
      registers: [this.registry],
      ...(buckets ? { buckets } : {}),
    });
  }
}

export type HealthFn = () => { ok: boolean; details?: Record<string, unknown> };

export async function startOpsServer(metrics: Metrics, port: number, health: HealthFn, host = '0.0.0.0'): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      res.end(await metrics.registry.metrics());
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      const h = health();
      res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: h.ok, ...(h.details ?? {}) }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server, port, host);
  return server;
}
