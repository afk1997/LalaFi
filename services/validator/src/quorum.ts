import type { Address, Hex } from 'viem';
import { ceilDiv } from '@xpool/service-common';

/**
 * Quorum rules for a deposit batch (PRD 9.2), integer form with k = kn/kd, θ = θn/θd:
 *   R1  θd·S_Q ≥ θn·S
 *   R2  kd·S_Q ≥ kn·A
 *   R3  ∀v∈Q: kn·(e_v + x_v) ≤ kd·s_v,   x_v = ⌈A·s_v / S_Q⌉
 * Plus the global safety valve (PRD 9.6): βd·(unconfirmed + A) ≤ βn·(lpAssets + insurance).
 */

export type Ratio = readonly [bigint, bigint];

export interface Candidate {
  signer: Address;
  id: number;
  /** s_v^c(e): snapshotted allocation for (chain, epoch). */
  stake: bigint;
  /** e_v^c: current exposure on the chain. */
  exposure: bigint;
  signature: Hex;
}

export interface QuorumParams {
  /** S^c(e) */
  totalStake: bigint;
  k: Ratio;
  theta: Ratio;
}

export type QuorumCheck =
  | { ok: true; stake: bigint; x: bigint[] }
  | { ok: false; rule: 'empty' | 'R1' | 'R2' | 'R3'; violators?: Address[] };

export const exposureShare = (amount: bigint, stake: bigint, quorumStake: bigint) => ceilDiv(amount * stake, quorumStake);

export function checkQuorum(signers: readonly Candidate[], amount: bigint, p: QuorumParams): QuorumCheck {
  if (signers.length === 0) return { ok: false, rule: 'empty' };
  const [kn, kd] = p.k;
  const [tn, td] = p.theta;
  const sq = signers.reduce((s, v) => s + v.stake, 0n);
  if (sq === 0n) return { ok: false, rule: 'empty' };
  if (td * sq < tn * p.totalStake) return { ok: false, rule: 'R1' };
  if (kd * sq < kn * amount) return { ok: false, rule: 'R2' };
  const x = signers.map((v) => exposureShare(amount, v.stake, sq));
  const violators = signers.filter((v, i) => kn * (v.exposure + x[i]!) > kd * v.stake).map((v) => v.signer);
  if (violators.length) return { ok: false, rule: 'R3', violators };
  return { ok: true, stake: sq, x };
}

const byAddress = (a: Candidate, b: Candidate) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : BigInt(a.signer) > BigInt(b.signer) ? 1 : 0);

/**
 * Picks a signer subset that satisfies R1–R3, ordered strictly ascending by address (as
 * submitAttestation requires). Starts from every candidate with stake and drops R3 violators
 * (validators already at their exposure limit) until the rest pass, or R1/R2 fail.
 */
export function selectQuorum(
  candidates: readonly Candidate[],
  amount: bigint,
  p: QuorumParams,
): { signers: Candidate[]; x: bigint[] } | null {
  const unique = new Map<string, Candidate>();
  for (const c of candidates) if (c.stake > 0n) unique.set(c.signer.toLowerCase(), c);
  let set = [...unique.values()].sort(byAddress);
  for (;;) {
    const r = checkQuorum(set, amount, p);
    if (r.ok) return { signers: set, x: r.x };
    if (r.rule !== 'R3') return null;
    const drop = new Set(r.violators!.map((a) => a.toLowerCase()));
    set = set.filter((v) => !drop.has(v.signer.toLowerCase()));
  }
}

export function safetyValveOk(unconfirmed: bigint, amount: bigint, lpAssets: bigint, insurance: bigint, beta: Ratio): boolean {
  return beta[1] * (unconfirmed + amount) <= beta[0] * (lpAssets + insurance);
}

/** Headroom under the safety valve: max A with βd·(u + A) ≤ βn·(lp + ins). */
export function valveHeadroom(unconfirmed: bigint, lpAssets: bigint, insurance: bigint, beta: Ratio): bigint {
  const cap = (beta[0] * (lpAssets + insurance)) / beta[1];
  return cap > unconfirmed ? cap - unconfirmed : 0n;
}

/**
 * Largest batch value A that the whole active set could sign under R2/R3 (conservative):
 * with everyone signing, x_v ≈ A·s_v/S, so A ≤ (kd·s_v − kn·e_v)·S / (kn·s_v) for every v.
 * One unit per validator is subtracted to absorb the ceil in x_v.
 */
export function fastCapacity(validators: ReadonlyArray<{ stake: bigint; exposure: bigint }>, k: Ratio): bigint {
  const [kn, kd] = k;
  const live = validators.filter((v) => v.stake > 0n);
  if (!live.length) return 0n;
  const s = live.reduce((a, v) => a + v.stake, 0n);
  let cap = (kd * s) / kn; // R2
  for (const v of live) {
    const room = kd * v.stake - kn * v.exposure;
    if (room <= 0n) return 0n;
    const a = (room * s) / (kn * v.stake);
    if (a < cap) cap = a;
  }
  const slack = BigInt(live.length);
  return cap > slack ? cap - slack : 0n;
}
