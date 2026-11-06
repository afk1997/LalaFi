import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { P, type L2Deposit } from '@xpool/service-common';
import { buildBatches, isEligible } from '../src/batch.js';
import {
  checkQuorum,
  exposureShare,
  fastCapacity,
  safetyValveOk,
  selectQuorum,
  valveHeadroom,
  type Candidate,
  type QuorumParams,
} from '../src/quorum.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const cand = (n: number, stake: bigint, exposure = 0n): Candidate => ({ signer: addr(n), id: n, stake, exposure, signature: '0x' });
const params = (totalStake: bigint): QuorumParams => ({ totalStake, k: [3n, 2n], theta: [2n, 3n] });

describe('R1–R3', () => {
  const four = [cand(4, 100n), cand(3, 100n), cand(2, 100n), cand(1, 100n)];

  it('x_v = ceil(A·s_v / S_Q)', () => {
    expect(exposureShare(100n, 100n, 300n)).toBe(34n);
    expect(exposureShare(99n, 100n, 300n)).toBe(33n);
  });

  it('passes with enough stake and room', () => {
    const r = checkQuorum(four.slice(0, 3), 100n, params(400n));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stake).toBe(300n);
      expect(r.x.reduce((a, b) => a + b, 0n) >= 100n).toBe(true); // Σx ≥ A
    }
  });

  it('R1: needs θ = 2/3 of total stake', () => {
    // 2·3 = 6 < 2·... : θd·S_Q = 3·200 = 600 < θn·S = 2·400 = 800
    expect(checkQuorum(four.slice(0, 2), 10n, params(400n))).toEqual({ ok: false, rule: 'R1' });
    // exactly 2/3: 3·200 = 600 ≥ 2·300 = 600
    expect(checkQuorum(four.slice(0, 2), 10n, params(300n)).ok).toBe(true);
  });

  it('R2: S_Q ≥ k·A', () => {
    // kd·S_Q = 2·300 = 600; kn·A = 3·201 = 603 > 600
    expect(checkQuorum(four.slice(0, 3), 201n, params(400n))).toEqual({ ok: false, rule: 'R2' });
    expect(checkQuorum(four.slice(0, 3), 200n, params(400n)).ok).toBe(false); // R3 via ceil: x = 67 → 3·67 = 201 > 200
    expect(checkQuorum(four.slice(0, 3), 198n, params(400n)).ok).toBe(true);
  });

  it('R3: per-signer exposure limit kn·(e+x) ≤ kd·s, reports violators', () => {
    const set = [cand(1, 100n, 60n), cand(2, 100n), cand(3, 100n)];
    // x = 10 each; v1: 3·(60+10) = 210 > 200
    const r = checkQuorum(set, 30n, params(300n));
    expect(r).toEqual({ ok: false, rule: 'R3', violators: [addr(1)] });
  });

  it('selectQuorum drops at-capacity signers and sorts ascending', () => {
    const set = [cand(9, 100n), cand(1, 100n, 66n), cand(5, 100n), cand(7, 100n)];
    const q = selectQuorum(set, 30n, params(400n));
    expect(q).not.toBeNull();
    expect(q!.signers.map((s) => s.id)).toEqual([5, 7, 9]);
    expect(checkQuorum(q!.signers, 30n, params(400n)).ok).toBe(true);
  });

  it('selectQuorum returns null when dropping breaks R1, and ignores zero stake / duplicates', () => {
    const set = [cand(1, 100n, 66n), cand(2, 100n, 66n), cand(3, 100n), cand(3, 100n), cand(4, 0n)];
    expect(selectQuorum(set, 30n, params(300n))).toBeNull();
    expect(selectQuorum([], 1n, params(1n))).toBeNull();
  });
});

describe('safety valve and capacity', () => {
  it('β·(lp + ins) bounds unconfirmed + A', () => {
    expect(safetyValveOk(0n, 50n, 80n, 20n, [1n, 2n])).toBe(true);
    expect(safetyValveOk(1n, 50n, 80n, 20n, [1n, 2n])).toBe(false);
    expect(valveHeadroom(10n, 80n, 20n, [1n, 2n])).toBe(40n);
    expect(valveHeadroom(60n, 80n, 20n, [1n, 2n])).toBe(0n);
  });

  it('fast capacity is the batch value the active set can still absorb', () => {
    const vs = [{ stake: 100n, exposure: 0n }, { stake: 100n, exposure: 0n }, { stake: 100n, exposure: 0n }];
    const cap = fastCapacity(vs, [3n, 2n]);
    expect(cap).toBe(197n); // 200 minus rounding slack
    const all = vs.map((v, i) => cand(i + 1, v.stake, v.exposure));
    expect(checkQuorum(all, cap, params(300n)).ok).toBe(true);
    expect(fastCapacity([{ stake: 100n, exposure: 67n }], [3n, 2n])).toBe(0n);
    expect(fastCapacity([], [3n, 2n])).toBe(0n);
  });
});

describe('batch building', () => {
  const d = (index: number, amount = 1_000_000n, ownerDigest = 1n): L2Deposit => ({ index: BigInt(index), ownerDigest, amount, fee: 0n, l2Block: 1n });
  const policy = { minDeposit: 1_000_000n, maxFastDeposit: 10_000_000n, maxBatchValue: 1n << 100n };

  it('eligibility: amount bounds and ownerDigest < P', () => {
    expect(isEligible(d(0), policy)).toBe(true);
    expect(isEligible(d(0, 999_999n), policy)).toBe(false);
    expect(isEligible(d(0, 10_000_001n), policy)).toBe(false);
    expect(isEligible(d(0, 1_000_000n, P), policy)).toBe(false);
  });

  it('skips inserted/ineligible, sorts, chunks at 32', () => {
    const deps = Array.from({ length: 70 }, (_, i) => d(69 - i));
    deps.push(d(100, 20_000_000n)); // above maxFastDeposit → slow lane only
    const out = buildBatches(deps, new Set([0n, 1n]), policy);
    expect(out.map((b) => b.length)).toEqual([32, 32, 4]);
    expect(out[0]![0]!.index).toBe(2n);
    expect(out.flat().every((x, i, a) => i === 0 || x.index > a[i - 1]!.index)).toBe(true);
  });

  it('caps batch value and is deterministic regardless of input order', () => {
    const deps = [d(3, 5_000_000n), d(1, 3_000_000n), d(2, 4_000_000n), d(4, 9_000_000n)];
    const p = { ...policy, maxBatchValue: 8_000_000n };
    const a = buildBatches(deps, new Set(), p);
    const b = buildBatches([...deps].reverse(), new Set(), p);
    expect(a).toEqual(b);
    expect(a.map((x) => x.map((y) => y.index))).toEqual([[1n, 2n], [3n]]); // 9M > cap: skipped
  });
});
