import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter, closeServer, createJsonServer, createLogger, listen, type Route } from '@xpool/service-common';
import { parseRelayRequest } from '../src/schema.js';
import { wireRequest } from './fixtures.js';

const lines: string[] = [];
const logger = createLogger('test', { level: 'debug', write: (l) => lines.push(l) });
let close: (() => Promise<void>) | undefined;

async function start(routes: Route[], rl?: RateLimiter, maxBodyBytes?: number) {
  const server = createJsonServer({ routes, logger, ...(rl ? { rateLimiter: rl } : {}), ...(maxBodyBytes ? { maxBodyBytes } : {}) });
  await listen(server, 0, '127.0.0.1');
  close = () => closeServer(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await close?.();
  lines.length = 0;
});

const echo: Route = {
  method: 'POST',
  path: '/v1/relay',
  handler: async ({ body }) => {
    const r = parseRelayRequest(body);
    return { status: r.ok ? 202 : 400, body: { ok: r.ok } };
  },
};

describe('JSON HTTP server', () => {
  it('never logs bodies or client addresses', async () => {
    const url = await start([echo]);
    const res = await fetch(`${url}/v1/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wireRequest()) });
    expect(res.status).toBe(202);
    const all = lines.join('\n');
    expect(all).toContain('POST /v1/relay');
    expect(all).not.toContain('127.0.0.1');
    expect(all).not.toContain('inputNullifiers');
    expect(all).not.toContain('0x2222222222222222222222222222222222222222');
  });

  it('applies per-client and global limits (429)', async () => {
    const rl = new RateLimiter({ perKey: { capacity: 2, refillPerSec: 0 }, global: { capacity: 100, refillPerSec: 0 } });
    const url = await start([{ method: 'GET', path: '/v1/info', handler: async () => ({ body: { ok: 1 } }) }], rl);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${url}/v1/info`)).status);
    expect(codes).toEqual([200, 200, 429]);
  });

  it('rejects oversized bodies, wrong content types, bad JSON, unknown routes and methods', async () => {
    const url = await start([echo], undefined, 1024);
    const post = (body: string, ct = 'application/json') => fetch(`${url}/v1/relay`, { method: 'POST', headers: { 'content-type': ct }, body });
    expect((await post('x'.repeat(2048))).status).toBe(413);
    expect((await post('{}', 'text/plain')).status).toBe(415);
    expect((await post('{bad')).status).toBe(400);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/v1/relay`)).status).toBe(405);
  });

  it('extracts path params', async () => {
    const url = await start([{ method: 'GET', path: '/v1/status/:id', handler: async ({ params }) => ({ body: { id: params.id } }) }]);
    expect(await (await fetch(`${url}/v1/status/abc`)).json()).toEqual({ id: 'abc' });
  });
});
