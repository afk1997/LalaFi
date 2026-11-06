import type { Pool } from '../env';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env', () => {
  const pools = [
    { id: 'usdc', symbol: 'USDC', codePrefix: 'txnote' },
    { id: 'dai', symbol: 'DAI', codePrefix: 'txdai' },
  ];
  return { pools };
});
const { pools } = (await import('../env')) as unknown as { pools: { id: string; codePrefix: string }[] };
const { groupCode, newCode, parseCode } = await import('../code');
const [usdc, dai] = pools as unknown as [Pool, Pool];

describe('withdrawal codes', () => {
  it('round-trips, derives the same keys and remembers its pool', () => {
    for (const pool of [usdc, dai]) {
      const c = newCode(pool);
      const p = parseCode(c.text);
      expect(p.ok).toBe(true);
      if (p.ok) {
        expect(p.code.pool).toBe(pool);
        expect(p.code.keys.sk).toBe(c.keys.sk);
        expect(Buffer.from(p.code.keys.encPk).equals(Buffer.from(c.keys.encPk))).toBe(true);
      }
    }
  });

  it('uses the pool prefix (USDC keeps txnote)', () => {
    expect(newCode(usdc).text.startsWith('txnote1')).toBe(true);
    expect(newCode(dai).text.startsWith('txdai1')).toBe(true);
  });

  it('is fresh every time', () => {
    expect(newCode(usdc).text).not.toBe(newCode(usdc).text);
  });

  it('accepts the grouped form, spaces and upper case', () => {
    const c = newCode(dai);
    expect(parseCode(groupCode(c.text).join(' ').toUpperCase()).ok).toBe(true);
  });

  it('rejects a single-character typo and a swapped prefix (bech32m checksum)', () => {
    const c = newCode(usdc);
    const i = c.text.length - 5;
    expect(parseCode(c.text.slice(0, i) + (c.text[i] === 'q' ? 'p' : 'q') + c.text.slice(i + 1)).ok).toBe(false);
    // the same data under the other pool's prefix fails the checksum, so a code can't be misread as another token
    expect(parseCode(c.text.replace(/^txnote1/, 'txdai1')).ok).toBe(false);
  });

  it('rejects unknown prefixes and empty input', () => {
    expect(parseCode('xnote1qqqqqqqqqqqqqqqqqqqqqqqqqqq')).toMatchObject({ ok: false });
    expect(parseCode('')).toMatchObject({ ok: false });
  });
});
