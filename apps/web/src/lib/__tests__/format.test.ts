import { describe, expect, it } from 'vitest';
import { fmtUsdc, parseUsdc } from '../format';

describe('USDC formatting', () => {
  it('parses plain decimals only', () => {
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('1,000')).toBe(1_000_000_000n);
    expect(parseUsdc('1.0000001')).toBeUndefined();
    expect(parseUsdc('abc')).toBeUndefined();
    expect(parseUsdc('')).toBeUndefined();
  });
  it('formats with grouping and never shows a non-zero as zero', () => {
    expect(fmtUsdc(1_234_560_000n)).toBe('1,234.56');
    expect(fmtUsdc(100_000_000n)).toBe('100');
    expect(fmtUsdc(1n)).toBe('<0.01');
    expect(fmtUsdc(0n)).toBe('0');
  });
});
