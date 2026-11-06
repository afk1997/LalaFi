import { createHmac, randomBytes } from 'node:crypto';

/** Token bucket: `capacity` tokens, refilled continuously at `refillPerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** True when the bucket is full, i.e. the key has been idle and can be forgotten. */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number) {
    const dt = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    this.last = now;
  }
}

export interface RateLimitConfig {
  perKey: { capacity: number; refillPerSec: number };
  global: { capacity: number; refillPerSec: number };
  /** Keys are dropped once their bucket is full again; also hard-capped to bound memory. */
  maxKeys?: number;
}

export type RateLimitResult = { ok: true } | { ok: false; scope: 'key' | 'global' };

/**
 * Per-client + global rate limiter. Keys are opaque (see ClientKeyer) and held in memory only:
 * nothing about clients is ever persisted.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly global: TokenBucket;
  private readonly maxKeys: number;

  constructor(
    private readonly cfg: RateLimitConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.global = new TokenBucket(cfg.global.capacity, cfg.global.refillPerSec, now());
    this.maxKeys = cfg.maxKeys ?? 100_000;
  }

  check(key: string, cost = 1): RateLimitResult {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(t, true);
      b = new TokenBucket(this.cfg.perKey.capacity, this.cfg.perKey.refillPerSec, t);
      this.buckets.set(key, b);
    }
    if (!b.take(t, cost)) return { ok: false, scope: 'key' };
    if (!this.global.take(t, cost)) return { ok: false, scope: 'global' };
    return { ok: true };
  }

  /** Forget idle keys. With `force`, also evicts the oldest half when still over the cap. */
  prune(t = this.now(), force = false): void {
    for (const [k, b] of this.buckets) if (b.isFull(t)) this.buckets.delete(k);
    if (force && this.buckets.size >= this.maxKeys) {
      let n = Math.ceil(this.buckets.size / 2);
      for (const k of this.buckets.keys()) {
        if (n-- <= 0) break;
        this.buckets.delete(k);
      }
    }
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }
}

/**
 * Turns a client address into an opaque rate-limit key: HMAC with a random in-memory secret,
 * rotated periodically. The raw address is never stored, logged or persisted, and keys from
 * different rotation periods can't be linked.
 */
export class ClientKeyer {
  private secret = randomBytes(32);
  private rotatedAt: number;

  constructor(
    private readonly rotateMs = 6 * 3600_000,
    private readonly now: () => number = Date.now,
  ) {
    this.rotatedAt = now();
  }

  key(remoteAddress: string | undefined): string {
    if (this.now() - this.rotatedAt > this.rotateMs) {
      this.secret = randomBytes(32);
      this.rotatedAt = this.now();
    }
    return createHmac('sha256', this.secret)
      .update(remoteAddress ?? 'unknown')
      .digest('base64url')
      .slice(0, 22);
  }
}
