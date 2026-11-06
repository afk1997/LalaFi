import { ceilDiv, roundUpToBucket } from '@xpool/service-common';

/** Pure relayer fee math (PRD 10.5). All USDC amounts in 6-decimal units. */

export interface FeeInputs {
  /** L1 gas the relayer expects `transact` to use. */
  gasUnits: bigint;
  gasPriceWei: bigint;
  /** ETH the relayer attaches (Arbitrum retryable). */
  ethValueWei: bigint;
  /** USDC units per 1 ETH (e.g. 3000 USDC = 3_000_000_000n). */
  ethPriceUsdc: bigint;
  marginBps: bigint;
  flatFee: bigint;
  bucket: bigint;
}

/** fee = max(bucket, roundUp_bucket(ceil(costUsdc * (1 + margin)) + flat)). */
export function computeRelayerFee(i: FeeInputs): bigint {
  const costWei = i.gasUnits * i.gasPriceWei + i.ethValueWei;
  const costUsdc = ceilDiv(costWei * i.ethPriceUsdc, 10n ** 18n);
  const withMargin = ceilDiv(costUsdc * (10_000n + i.marginBps), 10_000n) + i.flatFee;
  const fee = roundUpToBucket(withMargin, i.bucket);
  return fee < i.bucket ? i.bucket : fee;
}

/** Parses a decimal USDC price like "3000" or "2999.5" into 6-decimal units. */
export function parseUsdc(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad USDC amount ${s}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

/**
 * Remembers the fees this relayer quoted (in memory only, keyed by destination and amount, never
 * by client) so a proof built on a quote is honoured until the quote expires even if gas rises.
 */
export class QuoteBook {
  private readonly quotes = new Map<string, Array<{ fee: bigint; expiresAt: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  record(dst: bigint, w: bigint, fee: bigint, expiresAtMs: number): void {
    const k = `${dst}:${w}`;
    const list = (this.quotes.get(k) ?? []).filter((q) => q.expiresAt > this.now());
    list.push({ fee, expiresAt: expiresAtMs });
    this.quotes.set(k, list.slice(-16));
  }

  /** Lowest fee among unexpired quotes for (dst, w), if any. */
  lowest(dst: bigint, w: bigint): bigint | undefined {
    const list = (this.quotes.get(`${dst}:${w}`) ?? []).filter((q) => q.expiresAt > this.now());
    return list.reduce<bigint | undefined>((m, q) => (m === undefined || q.fee < m ? q.fee : m), undefined);
  }

  prune(): void {
    const t = this.now();
    for (const [k, list] of this.quotes) {
      const live = list.filter((q) => q.expiresAt > t);
      if (live.length) this.quotes.set(k, live);
      else this.quotes.delete(k);
    }
  }
}
