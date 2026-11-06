/** "12.5" → 12.5 × 10^decimals. Undefined for anything that isn't a plain positive decimal. */
export function parseAmount(s: string, decimals: number): bigint | undefined {
  const t = s.trim().replace(/,/g, '');
  const re = new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`);
  if (!re.test(t) || t === '' || t === '.') return undefined;
  const [i = '0', f = ''] = t.split('.');
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Base units → "1,234.56"; up to `max` decimals, zeros trimmed; a tiny non-zero shows as "<0.01". */
export function fmtAmount(v: bigint, decimals: number, max = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const keep = Math.min(max, decimals);
  if (a > 0n && a < 10n ** BigInt(decimals - keep)) return `${neg ? '-' : ''}<${(1 / 10 ** keep).toFixed(keep)}`;
  const f = (a % unit).toString().padStart(decimals, '0').slice(0, keep).replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / unit).toLocaleString('en-US')}${f ? `.${f}` : ''}`;
}

/** For prefilling an input: no grouping commas. */
export function plainAmount(v: bigint, decimals: number, max = 2): string {
  return fmtAmount(v, decimals, max).replace(/,/g, '').replace(/^<.*/, '0');
}
