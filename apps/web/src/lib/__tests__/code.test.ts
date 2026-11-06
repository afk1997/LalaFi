import { describe, expect, it, vi } from 'vitest';

vi.mock('../env', () => ({ ENV_NAME: 'testnet' }));
const { groupCode, newCode, parseCode } = await import('../code');

describe('withdrawal codes', () => {
  it('round-trips and derives the same keys', () => {
    const c = newCode();
    expect(c.text.startsWith('txnote1')).toBe(true);
    const p = parseCode(c.text);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.code.keys.sk).toBe(c.keys.sk);
      expect(p.code.keys.pk).toBe(c.keys.pk);
      expect(Buffer.from(p.code.keys.encPk).equals(Buffer.from(c.keys.encPk))).toBe(true);
    }
  });

  it('is fresh every time', () => {
    expect(newCode().text).not.toBe(newCode().text);
  });

  it('accepts the grouped form, spaces and upper case', () => {
    const c = newCode();
    expect(parseCode(groupCode(c.text).join(' ').toUpperCase()).ok).toBe(true);
  });

  it('rejects a single-character typo (bech32m checksum)', () => {
    const c = newCode();
    const i = c.text.length - 5;
    const typo = c.text.slice(0, i) + (c.text[i] === 'q' ? 'p' : 'q') + c.text.slice(i + 1);
    const p = parseCode(typo);
    expect(p.ok).toBe(false);
  });

  it('rejects codes from another network and empty input', () => {
    expect(parseCode('xnote1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toMatchObject({ ok: false });
    expect(parseCode('')).toMatchObject({ ok: false });
  });
});
