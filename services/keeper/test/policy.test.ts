import { describe, expect, it } from 'vitest';
import { defaultIrisBase, parseIrisResponse } from '../src/iris.js';
import { computeTargets, isAllowed, planRebalance, type LiquidityState } from '../src/policy.js';

const ETH = 1n;
const BASE = 8453n;
const ARB = 42161n;
const M = 1_000_000n; // 1 USDC
const bps = new Map([[ETH, 3000n], [BASE, 3500n], [ARB, 3500n]]);

function state(eth: bigint, base: bigint, arb: bigint, minRebalance = 50n * M): LiquidityState {
  const available = new Map([[ETH, eth], [BASE, base], [ARB, arb]]);
  return { available, target: computeTargets(available, bps), minRebalance };
}

describe('targets', () => {
  it('target[c] = targetBps[c] · ΣL / 10^4 (floor)', () => {
    const t = computeTargets(new Map([[ETH, 1000n], [BASE, 0n], [ARB, 1n]]), bps);
    expect(t.get(ETH)).toBe(300n); // 3000 * 1001 / 10000 = 300.3
    expect(t.get(BASE)).toBe(350n);
  });
});

describe('PRD 11.3 rules', () => {
  // Σ = 1000 → targets ETH 300, BASE 350, ARB 350
  const s = state(600n * M, 100n * M, 300n * M);

  it('allows only surplus → deficit within bounds', () => {
    expect(isAllowed(s, ETH, BASE, 250n * M)).toBe(true);
    expect(isAllowed(s, ETH, BASE, 251n * M)).toBe(false); // m > target[dst] - L[dst]
    expect(isAllowed(s, ETH, BASE, 49n * M)).toBe(false); // m < minRebalance
    expect(isAllowed(s, BASE, ETH, 50n * M)).toBe(false); // dst not in deficit / src not surplus
    expect(isAllowed(s, ARB, BASE, 50n * M)).toBe(false); // src would drop below its target (300 - 50 < 350)
    expect(isAllowed(s, ETH, ETH, 50n * M)).toBe(false);
  });

  it('src may not go below target', () => {
    const t = state(400n * M, 200n * M, 400n * M); // targets 300/350/350
    expect(isAllowed(t, ETH, BASE, 100n * M)).toBe(true);
    expect(isAllowed(t, ETH, BASE, 101n * M)).toBe(false);
  });
});

describe('planRebalance', () => {
  it('fills the largest deficit from the largest surplus with the max allowed amount', () => {
    const move = planRebalance(state(600n * M, 100n * M, 300n * M));
    expect(move).toEqual({ src: ETH, dst: BASE, amount: 250n * M });
  });

  it('limits m by the source surplus', () => {
    // Σ = 1000: surpluses ETH 100 / ARB 150, BASE deficit 250 → largest surplus ARB, m = 150
    expect(planRebalance(state(400n * M, 100n * M, 500n * M))).toEqual({ src: ARB, dst: BASE, amount: 150n * M });
  });

  it('tries the next source when the best one is too small', () => {
    // Σ = 1000; ARB surplus 10 (below min), ETH surplus 60 → ETH
    const move = planRebalance(state(360n * M, 280n * M, 360n * M));
    expect(move).toEqual({ src: ETH, dst: BASE, amount: 60n * M });
  });

  it('does nothing when balanced or every move is below minRebalance', () => {
    expect(planRebalance(state(300n * M, 350n * M, 350n * M))).toBeNull();
    expect(planRebalance(state(320n * M, 330n * M, 350n * M))).toBeNull();
  });

  it('every planned move satisfies the rules (property sweep)', () => {
    for (let e = 0n; e <= 1000n; e += 50n) {
      for (let b = 0n; b <= 1000n - e; b += 50n) {
        const s = state(e * M, b * M, (1000n - e - b) * M);
        const m = planRebalance(s);
        if (m) expect(isAllowed(s, m.src, m.dst, m.amount)).toBe(true);
      }
    }
  });
});

describe('Iris parsing', () => {
  it('returns complete messages and counts pending ones', () => {
    const r = parseIrisResponse({
      messages: [
        { message: '0xabcd', attestation: '0x1234', status: 'complete', eventNonce: '1' },
        { message: '0xabcd', attestation: 'PENDING', status: 'pending_confirmations' },
      ],
    });
    expect(r.complete).toEqual([{ message: '0xabcd', attestation: '0x1234' }]);
    expect(r.pending).toBe(1);
    expect(parseIrisResponse({})).toEqual({ complete: [], pending: 0 });
    expect(parseIrisResponse({ messages: [{ status: 'complete', message: 'zz', attestation: '0x12' }] }).pending).toBe(1);
  });

  it('defaults to the sandbox on testnet and production on mainnet', () => {
    expect(defaultIrisBase('testnet')).toBe('https://iris-api-sandbox.circle.com');
    expect(defaultIrisBase('mainnet')).toBe('https://iris-api.circle.com');
  });
});
