import { describe, expect, it } from 'vitest';
import { QuoteBook, computeRelayerFee, parseUsdc } from '../src/fees.js';

const base = {
  gasUnits: 900_000n,
  gasPriceWei: 10_000_000_000n, // 10 gwei
  ethValueWei: 0n,
  ethPriceUsdc: 3_000_000_000n, // 3000 USDC
  marginBps: 2_000n,
  flatFee: 0n,
  bucket: 10_000n,
};

describe('relayer fee math', () => {
  it('converts gas cost to USDC, adds margin and rounds up to the bucket', () => {
    // 900k * 10 gwei = 0.009 ETH = 27 USDC; +20% = 32.4 USDC = 32_400_000 → already bucketed
    expect(computeRelayerFee(base)).toBe(32_400_000n);
  });

  it('includes the Arbitrum retryable ETH', () => {
    // + 0.001 ETH = 3 USDC → 30 * 1.2 = 36 USDC
    expect(computeRelayerFee({ ...base, ethValueWei: 1_000_000_000_000_000n })).toBe(36_000_000n);
  });

  it('rounds up to the next bucket and never quotes below one bucket', () => {
    const tiny = computeRelayerFee({ ...base, gasPriceWei: 1n });
    expect(tiny).toBe(10_000n);
    const odd = computeRelayerFee({ ...base, gasUnits: 1_000_001n, gasPriceWei: 1_000_000_000n, marginBps: 0n });
    // 1_000_001 gwei = 0.001000001 ETH * 3000 = 3.000003 USDC → 3_000_003 → bucket 3_010_000
    expect(odd).toBe(3_010_000n);
    expect(odd % base.bucket).toBe(0n);
  });

  it('respects a 0.25 USDC mainnet bucket and flat fee', () => {
    // 32.4 + 0.10 = 32.50 (already a multiple of 0.25)
    expect(computeRelayerFee({ ...base, bucket: 250_000n, flatFee: 100_000n })).toBe(32_500_000n);
    // 32.4 + 0.15 = 32.55 → 32.75
    const f = computeRelayerFee({ ...base, bucket: 250_000n, flatFee: 150_000n });
    expect(f % 250_000n).toBe(0n);
    expect(f).toBe(32_750_000n);
  });

  it('parses USDC prices', () => {
    expect(parseUsdc('3000')).toBe(3_000_000_000n);
    expect(parseUsdc('2999.5')).toBe(2_999_500_000n);
    expect(() => parseUsdc('1e3')).toThrow();
  });
});

describe('QuoteBook', () => {
  it('honours the lowest unexpired quote per (dst, w)', () => {
    let now = 0;
    const qb = new QuoteBook(() => now);
    qb.record(31339n, 5n, 30_000n, 1000);
    qb.record(31339n, 5n, 20_000n, 500);
    expect(qb.lowest(31339n, 5n)).toBe(20_000n);
    expect(qb.lowest(31339n, 6n)).toBeUndefined();
    now = 600;
    expect(qb.lowest(31339n, 5n)).toBe(30_000n);
    now = 2000;
    expect(qb.lowest(31339n, 5n)).toBeUndefined();
    qb.prune();
  });
});
