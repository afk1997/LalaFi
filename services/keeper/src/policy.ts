/**
 * Rebalancing policy, exactly PRD 11.3:
 *   target[c] = targetBps[c] · Σ_c' L[c'] / 10^4
 *   rebalance(src, dst, m) is allowed iff
 *     m ≥ minRebalance,  L[src] − m ≥ target[src],  L[dst] < target[dst],  m ≤ target[dst] − L[dst]
 * Computed off-chain before sending; the contract enforces the same rules (RebalancePolicy).
 */

export interface LiquidityState {
  /** L[c] = LiquidityManager.available(c) */
  available: ReadonlyMap<bigint, bigint>;
  /** target[c] (on-chain LiquidityManager.target(c), or computeTargets) */
  target: ReadonlyMap<bigint, bigint>;
  minRebalance: bigint;
}

export interface RebalanceMove {
  src: bigint;
  dst: bigint;
  amount: bigint;
}

export function computeTargets(available: ReadonlyMap<bigint, bigint>, targetBps: ReadonlyMap<bigint, bigint>): Map<bigint, bigint> {
  const total = [...available.values()].reduce((a, b) => a + b, 0n);
  return new Map([...available.keys()].map((c) => [c, ((targetBps.get(c) ?? 0n) * total) / 10_000n]));
}

const get = (m: ReadonlyMap<bigint, bigint>, c: bigint) => m.get(c) ?? 0n;

export function isAllowed(s: LiquidityState, src: bigint, dst: bigint, m: bigint): boolean {
  if (src === dst) return false;
  const Ls = get(s.available, src);
  const Ld = get(s.available, dst);
  const Ts = get(s.target, src);
  const Td = get(s.target, dst);
  return m >= s.minRebalance && Ls - m >= Ts && Ld < Td && m <= Td - Ld;
}

/**
 * The single best allowed move: the largest deficit is filled from the largest surplus, with the
 * maximum amount the rules permit (min of the surplus and the deficit). Null when none allowed.
 */
export function planRebalance(s: LiquidityState): RebalanceMove | null {
  const chains = [...s.available.keys()];
  const deficit = (c: bigint) => get(s.target, c) - get(s.available, c);
  const surplus = (c: bigint) => get(s.available, c) - get(s.target, c);
  const dsts = chains.filter((c) => deficit(c) > 0n).sort((a, b) => (deficit(b) > deficit(a) ? 1 : deficit(b) < deficit(a) ? -1 : 0));
  const srcs = chains.filter((c) => surplus(c) > 0n).sort((a, b) => (surplus(b) > surplus(a) ? 1 : surplus(b) < surplus(a) ? -1 : 0));
  for (const dst of dsts) {
    for (const src of srcs) {
      const m = surplus(src) < deficit(dst) ? surplus(src) : deficit(dst);
      if (isAllowed(s, src, dst, m)) return { src, dst, amount: m };
    }
  }
  return null;
}
