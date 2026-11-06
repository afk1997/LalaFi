import { describe, expect, it } from 'vitest';
import { ClientKeyer, RateLimiter, TokenBucket } from '../src/index.js';

describe('TokenBucket', () => {
  it('drains and refills continuously', () => {
    const b = new TokenBucket(2, 1, 0);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(500)).toBe(false);
    expect(b.take(1000)).toBe(true);
    expect(b.isFull(10_000)).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('limits per key independently, and globally', () => {
    let now = 0;
    const rl = new RateLimiter({ perKey: { capacity: 2, refillPerSec: 1 }, global: { capacity: 3, refillPerSec: 1 } }, () => now);
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('a')).toEqual({ ok: false, scope: 'key' });
    expect(rl.check('b').ok).toBe(true);
    expect(rl.check('c')).toEqual({ ok: false, scope: 'global' });
    now = 2_000;
    expect(rl.check('c').ok).toBe(true);
  });

  it('forgets idle keys and bounds memory', () => {
    let now = 0;
    const rl = new RateLimiter({ perKey: { capacity: 1, refillPerSec: 1 }, global: { capacity: 1e9, refillPerSec: 1e9 }, maxKeys: 4 }, () => now);
    for (const k of ['a', 'b', 'c', 'd']) rl.check(k);
    expect(rl.trackedKeys).toBe(4);
    rl.check('e');
    expect(rl.trackedKeys).toBeLessThanOrEqual(4);
    now = 10_000;
    rl.prune();
    expect(rl.trackedKeys).toBe(0);
  });

  it('honours cost', () => {
    const rl = new RateLimiter({ perKey: { capacity: 5, refillPerSec: 0 }, global: { capacity: 100, refillPerSec: 0 } }, () => 0);
    expect(rl.check('a', 5).ok).toBe(true);
    expect(rl.check('a', 1).ok).toBe(false);
  });
});

describe('ClientKeyer', () => {
  it('produces opaque, stable keys that never contain the address and rotate', () => {
    let now = 0;
    const k = new ClientKeyer(1000, () => now);
    const a1 = k.key('10.0.0.1');
    expect(a1).not.toContain('10.0.0.1');
    expect(k.key('10.0.0.1')).toBe(a1);
    expect(k.key('10.0.0.2')).not.toBe(a1);
    now = 5000;
    expect(k.key('10.0.0.1')).not.toBe(a1);
  });
});
