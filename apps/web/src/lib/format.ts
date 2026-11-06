const DECIMALS = 6n;
const UNIT = 10n ** DECIMALS;

/** "12.5" → 12_500_000n. Returns undefined for anything that isn't a plain positive decimal. */
export function parseUsdc(s: string): bigint | undefined {
  const t = s.trim().replace(/,/g, '');
  if (!/^\d*(\.\d{0,6})?$/.test(t) || t === '' || t === '.') return undefined;
  const [i = '0', f = ''] = t.split('.');
  return BigInt(i || '0') * UNIT + BigInt((f + '000000').slice(0, 6));
}

/** 12_500_000n → "12.5"; keeps up to `max` decimals, trims zeros; tiny non-zero values show as "<0.01". */
export function fmtUsdc(v: bigint, max = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scale = 10n ** BigInt(6 - max);
  const shown = a / scale;
  if (shown === 0n && a > 0n) return `${neg ? '-' : ''}<${(1 / 10 ** max).toFixed(max)}`;
  const i = a / UNIT;
  const f = (a % UNIT).toString().padStart(6, '0').slice(0, max).replace(/0+$/, '');
  return `${neg ? '-' : ''}${i.toLocaleString('en-US')}${f ? `.${f}` : ''}`;
}

export function fmtEth(wei: bigint): string {
  const v = Number(wei) / 1e18;
  return v === 0 ? '0' : v < 0.0001 ? '<0.0001' : v.toFixed(4);
}
