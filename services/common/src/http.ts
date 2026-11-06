import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './logger.js';
import { toWire } from './json.js';
import { ClientKeyer, RateLimiter } from './ratelimit.js';

/**
 * Minimal JSON HTTP server.
 * - Request bodies are size-limited and never logged; only method, route pattern, status, latency.
 * - The client's IP is turned into an opaque rate-limit key in memory and then dropped.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Opaque, rotating rate-limit key; NOT the IP. */
  clientKey: string;
}

export interface Route {
  method: 'GET' | 'POST';
  /** Pattern like `/v1/status/:requestId`. */
  path: string;
  /** Rate-limit cost (default 1). 0 disables limiting for this route. */
  cost?: number;
  handler: (ctx: RequestContext) => Promise<{ status?: number; body: unknown }>;
}

export interface HttpServerOptions {
  routes: Route[];
  logger: Logger;
  maxBodyBytes?: number;
  rateLimiter?: RateLimiter;
  keyer?: ClientKeyer;
  onRequest?: (route: string, status: number, ms: number) => void;
}

interface CompiledRoute extends Route {
  re: RegExp;
  names: string[];
}

function compile(r: Route): CompiledRoute {
  const names: string[] = [];
  const src = r.path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...r, re: new RegExp(`^${src}$`), names };
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const ct = req.headers['content-type'] ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(toWire(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createJsonServer(opts: HttpServerOptions): Server {
  const routes = opts.routes.map(compile);
  const limit = opts.maxBodyBytes ?? 64 * 1024;
  const keyer = opts.keyer ?? new ClientKeyer();
  const log = opts.logger.child({ component: 'http' });

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let routeName = 'unmatched';
    let status = 500;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      let match: { route: CompiledRoute; params: Record<string, string> } | undefined;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params: Record<string, string> = {};
        r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] ?? '')));
        match = { route: r, params };
        break;
      }
      if (!match) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found');
      routeName = `${match.route.method} ${match.route.path}`;

      // The socket address is used only here, transformed into an opaque key, and discarded.
      const clientKey = keyer.key(req.socket.remoteAddress);
      const cost = match.route.cost ?? 1;
      if (opts.rateLimiter && cost > 0) {
        const rl = opts.rateLimiter.check(clientKey, cost);
        if (!rl.ok) throw new HttpError(429, rl.scope === 'global' ? 'busy' : 'rate_limited');
      }

      const body = method === 'POST' ? await readBody(req, limit) : undefined;
      const out = await match.route.handler({ params: match.params, query: url.searchParams, body, clientKey });
      status = out.status ?? 200;
      send(res, status, out.body);
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        send(res, status, { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      } else {
        status = 500;
        log.error('handler error', { route: routeName, err });
        send(res, 500, { error: 'internal' });
      }
    } finally {
      const ms = Date.now() - started;
      opts.onRequest?.(routeName, status, ms);
      log.debug('request', { route: routeName, status, ms });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function listen(server: Server, port: number, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
