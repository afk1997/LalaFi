import { describe, expect, it } from 'vitest';
import { fmtAmount, parseAmount, plainAmount } from '../format';

describe('amount formatting', () => {
  it('parses plain decimals for 6 and 18 decimals', () => {
    expect(parseAmount('12.5', 6)).toBe(12_500_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
    expect(parseAmount('1,000', 6)).toBe(1_000_000_000n);
    expect(parseAmount('1.0000001', 6)).toBeUndefined();
    expect(parseAmount('2.5', 18)).toBe(2_500_000_000_000_000_000n);
    expect(parseAmount('abc', 18)).toBeUndefined();
    expect(parseAmount('', 6)).toBeUndefined();
  });
  it('formats with grouping and never shows a non-zero as zero', () => {
    expect(fmtAmount(1_234_560_000n, 6)).toBe('1,234.56');
    expect(fmtAmount(100_000_000n, 6)).toBe('100');
    expect(fmtAmount(1n, 6)).toBe('<0.01');
    expect(fmtAmount(0n, 18)).toBe('0');
    expect(fmtAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(plainAmount(1_234_560_000n, 6)).toBe('1234.56');
  });
});
