import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KvStore,
  Metrics,
  ReleaseState,
  applyL1ToL2Alias,
  createLogger,
  loadPrivateKey,
  releaseAction,
  retryableValue,
  undoL1ToL2Alias,
  withMargin,
  type TrackedRelease,
} from '../src/index.js';

describe('Arbitrum aliasing', () => {
  it('adds 0x1111…1111 modulo 2^160 and undoes it', () => {
    expect(applyL1ToL2Alias('0x0000000000000000000000000000000000000001')).toBe('0x1111000000000000000000000000000000001112');
    expect(applyL1ToL2Alias('0xffffffffffffffffffffffffffffffffffffffff').toLowerCase()).toBe('0x1111000000000000000000000000000000001110');
    const a = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    expect(undoL1ToL2Alias(applyL1ToL2Alias(a))).toBe(a);
  });

  it('margin and retryable value', () => {
    expect(withMargin(100n, 3000)).toBe(130n);
    expect(withMargin(101n, 3000)).toBe(132n); // 131.3 rounded up
    expect(retryableValue({ maxSubmissionCost: 5n, gasLimit: 10n, maxFeePerGas: 3n, refundAddress: '0x0000000000000000000000000000000000000000' })).toBe(35n);
  });
});

describe('KvStore', () => {
  it('persists bigint-safe JSON across reopen and lists by prefix', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'xpool-kv-')), 'kv.sqlite');
    const kv = new KvStore(path, 'ns');
    kv.set('a:1', { x: 1n << 200n });
    kv.set('a:2', 5);
    kv.set('b:1', 'z');
    kv.close();
    const kv2 = new KvStore(path, 'ns');
    expect(kv2.get<{ x: bigint }>('a:1')?.x).toBe(1n << 200n);
    expect(kv2.list('a:').map(([k]) => k)).toEqual(['a:1', 'a:2']);
    expect(kv2.scoped('other').get('a:1')).toBeUndefined();
    kv2.delete('a:1');
    expect(kv2.get('a:1')).toBeUndefined();
  });
});

describe('logger', () => {
  it('redacts secrets, IPs, bodies, headers and URLs', () => {
    const lines: string[] = [];
    const log = createLogger('t', { write: (l) => lines.push(l), level: 'debug' });
    log.info('rpc https://eth.example/v2/SECRETKEY failed', {
      privateKey: '0xdead',
      ip: '1.2.3.4',
      remoteAddress: '1.2.3.4',
      body: { proof: 1 },
      headers: { a: 1 },
      nested: { apiKey: 'x', ok: 7n },
      err: new Error('call to http://10.0.0.1:8545 failed'),
    });
    const rec = JSON.parse(lines[0]!);
    expect(lines[0]).not.toContain('SECRETKEY');
    expect(lines[0]).not.toContain('1.2.3.4');
    expect(lines[0]).not.toContain('10.0.0.1');
    expect(rec.privateKey).toBe('[redacted]');
    expect(rec.body).toBe('[redacted]');
    expect(rec.headers).toBe('[redacted]');
    expect(rec.nested).toEqual({ apiKey: '[redacted]', ok: '7' });
  });

  it('respects the level', () => {
    const lines: string[] = [];
    createLogger('t', { write: (l) => lines.push(l), level: 'warn' }).info('x');
    expect(lines).toHaveLength(0);
  });
});

describe('keys', () => {
  it('loads from env only, validates, and scrubs the env var', () => {
    const env: NodeJS.ProcessEnv = { K: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
    expect(loadPrivateKey('K', env)).toMatch(/^0x59c6/);
    expect(env.K).toBeUndefined();
    expect(() => loadPrivateKey('K', env)).toThrow(/missing/);
    expect(() => loadPrivateKey('B', { B: '0x1234' })).toThrow(/32-byte/);
  });
});

describe('releaseAction', () => {
  const t: TrackedRelease = {
    release: { dstChainId: 31339n, index: 0n, recipient: '0x2222222222222222222222222222222222222222', amount: 1n, spendId: '0x00' },
    firstSeenMs: 0,
    lastAttemptMs: 1000,
    resends: 0,
  };
  it('done once the spoke has any terminal state', () => {
    for (const s of [ReleaseState.Executed, ReleaseState.Queued, ReleaseState.Failed]) expect(releaseAction(t, s, 0, 10, 3)).toBe('done');
  });
  it('waits, then resends, then gives up', () => {
    expect(releaseAction(t, ReleaseState.None, 1500, 1000, 3)).toBe('wait');
    expect(releaseAction(t, ReleaseState.None, 2000, 1000, 3)).toBe('resend');
    expect(releaseAction({ ...t, resends: 3 }, ReleaseState.None, 9000, 1000, 3)).toBe('stuck');
  });
});

describe('Metrics', () => {
  it('get-or-create: the same name returns the same metric (per-chain components)', async () => {
    const m = new Metrics('t');
    const a = m.counter('x_total', 'x', ['chain']);
    expect(m.counter('x_total', 'x', ['chain'])).toBe(a);
    a.inc({ chain: '1' });
    expect(await m.registry.getSingleMetricAsString('xpool_x_total')).toContain('chain="1"');
  });
});
