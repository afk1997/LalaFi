import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zeroAddress } from 'viem';
import {
  RelayerClient, RelayerError, parseQuote, serializeExtData, isLoopbackUrl, resolveNetworkPolicy, torWarning,
  isPortReachable, agentFetch, type FetchFn,
} from '../src/relayer/index.js';
import { makeExtData } from '../src/tx/extdata.js';
import { Agent } from 'node:http';

const RELAYER = '0x2222222222222222222222222222222222222222';

function mockFetch(routes: Record<string, (body: unknown) => [number, unknown]>, seen: { path: string; body: unknown }[] = []): FetchFn {
  return async (input, init) => {
    const u = new URL(input.toString());
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    seen.push({ path: u.pathname, body });
    const h = routes[`${init?.method ?? 'GET'} ${u.pathname}`];
    if (!h) return new Response('{"error":"not found"}', { status: 404 });
    const [status, json] = h(body);
    return new Response(JSON.stringify(json), { status });
  };
}

describe('RelayerClient', () => {
  const ext = makeExtData({
    hubChainId: 1n, hub: RELAYER, dstChainId: 0n, recipient: zeroAddress, withdrawAmount: 0n, relayer: RELAYER,
    relayerFee: 10_000n, protocolFee: 0n, deadline: 99n, encOut0: '0x01', encOut1: '0x',
  });

  it('quote / relay / status / info with string-encoded integers', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const c = new RelayerClient({
      baseUrl: 'http://127.0.0.1:1/',
      fetch: mockFetch(
        {
          'POST /v1/quote': () => [200, { relayer: RELAYER, relayerFee: '20000', ethValue: '0', bridgeParams: {}, expiresAt: 1900000000 }],
          'POST /v1/relay': () => [200, { requestId: 'abc-123' }],
          'GET /v1/status/abc-123': () => [200, { state: 'mined', txHash: `0x${'aa'.repeat(32)}`, releaseIndex: '4' }],
          'GET /v1/info': () => [200, { relayer: RELAYER, chains: [1, 8453], feeBucket: '10000', version: '1' }],
        },
        seen,
      ),
    });
    const q = await c.quote(8453n, 5_000_000n);
    expect(q.relayerFee).toBe(20_000n);
    expect(seen[0]!.body).toEqual({ dstChainId: '8453', withdrawAmount: '5000000' });
    const id = await c.relay({ a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] }, {
      root: 1n, publicAmount: 2n, extDataHash: 3n, inputNullifiers: [4n, 5n], outputCommitments: [6n, 7n],
    }, ext);
    expect(id).toBe('abc-123');
    const rb = seen[1]!.body as Record<string, Record<string, unknown>>;
    expect(rb.proof!.b).toEqual([['3', '4'], ['5', '6']]);
    expect(rb.extData!.relayerFee).toBe('10000');
    expect(rb.publicInputs!.inputNullifiers).toEqual(['4', '5']);
    expect((await c.status(id)).releaseIndex).toBe(4n);
    expect((await c.info()).feeBucket).toBe(10_000n);
  });

  it('rejects malformed responses and bad ids', async () => {
    const c = new RelayerClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: mockFetch({
        'POST /v1/quote': () => [200, { relayer: 'nope', relayerFee: '1', expiresAt: 1 }],
        'POST /v1/relay': () => [500, { error: 'simulation failed' }],
      }),
    });
    await expect(c.quote(1n, 1n)).rejects.toThrow(RelayerError);
    await expect(c.relay({ a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] }, { root: 0n, publicAmount: 0n, extDataHash: 0n, inputNullifiers: [0n, 0n], outputCommitments: [0n, 0n] }, ext)).rejects.toThrow(/simulation failed/);
    await expect(c.status('../../etc')).rejects.toThrow(RelayerError);
    expect(() => parseQuote({ relayer: RELAYER, relayerFee: '-1', expiresAt: 5 })).toThrow();
    expect(() => new RelayerClient({ baseUrl: 'file:///x' })).toThrow();
  });

  it('serializes ExtData with decimal strings and hex bytes', () => {
    expect(serializeExtData(ext)).toMatchObject({ version: 1, hubChainId: '1', deadline: '99', encOut0: '0x01' });
  });
});

describe('Tor policy (W8)', () => {
  it('detects loopback URLs', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8545')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1')).toBe(true);
    expect(isLoopbackUrl('https://rpc.example.org')).toBe(false);
  });

  it('--no-tor gives a loud warning; unreachable proxy too', async () => {
    const off = await resolveNetworkPolicy({ disabled: true });
    expect(off.tor).toBe(false);
    expect(torWarning(off)).toMatch(/PRIVACY WARNING/);
    const none = await resolveNetworkPolicy({ port: 1 });
    expect(none.tor).toBe(false);
    expect(torWarning(none)).toMatch(/no Tor SOCKS5 proxy/);
  });

  it('enables Tor when the SOCKS port is reachable', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    expect(await isPortReachable('127.0.0.1', port)).toBe(true);
    const p = await resolveNetworkPolicy({ port });
    expect(p.tor).toBe(true);
    expect(torWarning(p)).toBeUndefined();
    srv.close();
  });

  it('agentFetch performs HTTP requests through a node agent', async () => {
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body: b }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const f = agentFetch(new Agent());
    const res = await f(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toEqual({ method: 'POST', body: '{"a":1}' });
    srv.close();
  });
});
