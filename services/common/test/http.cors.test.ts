import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeServer, createJsonServer, listen } from '../src/http.js';
import { createLogger } from '../src/logger.js';

function call(port: number, method: string, origin?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/info', method, headers: origin ? { origin } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CORS allowlist', () => {
  const server = createJsonServer({
    routes: [{ method: 'GET', path: '/v1/info', handler: async () => ({ body: { ok: true } }) }],
    logger: createLogger('test'),
    corsOrigins: ['https://app.example'],
  });
  let port = 0;
  beforeAll(async () => {
    await listen(server, 0, '127.0.0.1');
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => closeServer(server));

  it('echoes an allowed origin', async () => {
    const r = await call(port, 'GET', 'https://app.example');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example');
  });
  it('answers preflight with 204', async () => {
    const r = await call(port, 'OPTIONS', 'https://app.example');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-methods']).toContain('POST');
  });
  it('sends no CORS headers to other origins', async () => {
    const r = await call(port, 'GET', 'https://evil.example');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});
