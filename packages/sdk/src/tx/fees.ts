/**
 * Fee math (PRD 5.7, 10.1, 10.5):
 *   v = w + f_rel + f_prot,  f_prot = ceil(w * phiBps / 1e4),  publicAmount = v == 0 ? 0 : p - v
 */
import { AMOUNT_BOUND, P } from '../constants.js';
import type { Field } from '../crypto/field.js';

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv by non-positive');
  if (a < 0n) throw new RangeError('ceilDiv of negative');
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function protocolFee(w: bigint, phiBps: bigint): bigint {
  if (w < 0n || phiBps < 0n) throw new RangeError('negative fee input');
  return ceilDiv(w * phiBps, 10_000n);
}

/** Round a relayer fee UP to the next multiple of the bucket (W7). */
export function roundUpToBucket(fee: bigint, bucket: bigint): bigint {
  if (bucket <= 0n) throw new RangeError('bucket must be > 0');
  if (fee < 0n) throw new RangeError('negative fee');
  return ceilDiv(fee, bucket) * bucket;
}

export function isBucketMultiple(fee: bigint, bucket: bigint): boolean {
  return bucket > 0n && fee >= 0n && fee % bucket === 0n;
}

export function totalOut(w: bigint, relayerFee: bigint, protoFee: bigint): bigint {
  const v = w + relayerFee + protoFee;
  if (v < 0n || v >= AMOUNT_BOUND) throw new RangeError('v out of range [0, 2^248)');
  return v;
}

export function publicAmount(v: bigint): Field {
  if (v < 0n || v >= AMOUNT_BOUND) throw new RangeError('v out of range [0, 2^248)');
  return v === 0n ? 0n : P - v;
}

/** Largest w such that w + ceil(w*phi/1e4) + relayerFee <= available. */
export function maxWithdrawable(available: bigint, relayerFee: bigint, phiBps: bigint): bigint {
  const budget = available - relayerFee;
  if (budget <= 0n) return 0n;
  let w = (budget * 10_000n) / (10_000n + phiBps);
  while (w > 0n && w + protocolFee(w, phiBps) > budget) w--;
  while (w + 1n + protocolFee(w + 1n, phiBps) <= budget) w++;
  return w;
}
