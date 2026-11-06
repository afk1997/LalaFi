import { describe, expect, it } from 'vitest';
import {
  checkDelay, checkAnonymity, checkAmountHygiene, checkRecipient, depositsAfter, kFeasible, kEffective,
  isRoundAmount, suggestRoundAmounts, withinOnePercent, splitWithdrawal, evaluateWithdrawal, evaluateInternalSpend,
  OVERRIDE_FLAGS, secondsUntilRecommended,
} from '../src/privacy/index.js';
import type { DepositRecord } from '../src/sync/state.js';
import type { OwnedNote } from '../src/notes/store.js';

const U = 1_000_000n;
const now = 1_800_000_000;

describe('W3 delay', () => {
  it('blocks < 1h, warns < 24h, ok after', () => {
    expect(checkDelay(now - 59 * 60, now)?.level).toBe('block');
    expect(checkDelay(now - 59 * 60, now)?.overrideFlag).toBe('--ignore-delay');
    expect(checkDelay(now - 59 * 60, now, true)?.level).toBe('warn');
    expect(checkDelay(now - 3600, now)?.level).toBe('warn');
    expect(checkDelay(now - 23 * 3600, now)?.level).toBe('warn');
    expect(checkDelay(now - 24 * 3600, now)).toBeUndefined();
    expect(secondsUntilRecommended(now - 3600, now)).toBe(23 * 3600);
  });
});

describe('W4 anonymity', () => {
  const deps: DepositRecord[] = Array.from({ length: 30 }, (_, i) => ({ leafIndex: i * 2, chainId: 1, amount: BigInt(i + 1) * 100n * U, time: now - 1000 + i }));
  it('counts deposits after the funding leaf', () => {
    expect(depositsAfter(deps, 0)).toBe(29);
    expect(depositsAfter(deps, 50)).toBe(4);
  });
  it('blocks < 5, warns < 20', () => {
    expect(checkAnonymity(4)?.level).toBe('block');
    expect(checkAnonymity(4, true)?.level).toBe('warn');
    expect(checkAnonymity(5)?.level).toBe('warn');
    expect(checkAnonymity(19)?.level).toBe('warn');
    expect(checkAnonymity(20)).toBeUndefined();
  });
  it('k_feas filters by amount and time; k_eff from entropy', () => {
    expect(kFeasible(deps, 2_500n * U)).toBe(6);
    expect(kFeasible(deps, 0n, now - 1000)).toBe(1);
    expect(kEffective([1, 1, 1, 1])).toBeCloseTo(4);
    expect(kEffective([1, 0, 0])).toBeCloseTo(1);
    expect(kEffective([])).toBe(0);
  });
});

describe('W5 amount hygiene', () => {
  it('round amounts and 1% proximity', () => {
    expect(isRoundAmount(500n * U)).toBe(true);
    expect(isRoundAmount(123n * U)).toBe(false);
    expect(suggestRoundAmounts(123n * U)).toContain(120n * U);
    expect(withinOnePercent(995n * U, 1000n * U)).toBe(true);
    expect(withinOnePercent(989n * U, 1000n * U)).toBe(false);
    expect(withinOnePercent(1010n * U, 1000n * U)).toBe(true);
    const f = checkAmountHygiene(1000n * U, [1003n * U]);
    expect(f.map((x) => x.level)).toEqual(['warn']);
    expect(checkAmountHygiene(123n * U, [])[0]?.level).toBe('info');
  });
});

describe('W2 recipient freshness', () => {
  const hist = { usedRecipients: ['0x3333333333333333333333333333333333333333'], linkedAddresses: ['0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'] };
  it('blocks reused and linked recipients (case-insensitive)', () => {
    expect(checkRecipient('0x3333333333333333333333333333333333333333', hist)?.level).toBe('block');
    expect(checkRecipient('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', hist)?.level).toBe('block');
    expect(checkRecipient('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', hist, true)?.level).toBe('warn');
    expect(checkRecipient('0x4444444444444444444444444444444444444444', hist)).toBeUndefined();
    expect(OVERRIDE_FLAGS.W1).toBe('--self-relay --i-understand-linkability');
  });
});

describe('scheduler', () => {
  it('splits into N parts summing to the total, with increasing random times', () => {
    for (let k = 0; k < 20; k++) {
      const parts = splitWithdrawal(1_000n * U, 4, { nowSec: now, minPart: U });
      expect(parts).toHaveLength(4);
      expect(parts.reduce((s, p) => s + p.amount, 0n)).toBe(1_000n * U);
      expect(parts.every((p) => p.amount >= U)).toBe(true);
      for (let i = 1; i < 4; i++) expect(parts[i]!.at).toBeGreaterThanOrEqual(parts[i - 1]!.at + 3600);
      expect(parts[0]!.at).toBeGreaterThan(now);
      expect(parts.filter((p) => p.amount % (10n * U) === 0n).length).toBeGreaterThanOrEqual(3);
    }
  });
  it('rejects bad parameters', () => {
    expect(() => splitWithdrawal(10n, 0)).toThrow();
    expect(() => splitWithdrawal(3n, 4, { minPart: 1n })).toThrow();
    expect(splitWithdrawal(4n, 4, { minPart: 1n }).reduce((s, p) => s + p.amount, 0n)).toBe(4n);
  });
});

describe('policy', () => {
  const note = (o: Partial<OwnedNote>): OwnedNote => ({
    amount: 1000n * U, pk: 1n, blinding: 1n, commitment: 1n, leafIndex: 0, nullifier: 1n, source: 'l1-deposit',
    originChainId: 1, fundedAt: now - 48 * 3600, fundingLeaf: 0, fundingAmounts: [1000n * U], spent: false, ...o,
  });
  const deps: DepositRecord[] = Array.from({ length: 25 }, (_, i) => ({ leafIndex: i * 2, chainId: 1, amount: 1000n * U, time: now - 10 }));
  const hist = { usedRecipients: [], linkedAddresses: [] };

  it('passes a well-behaved withdrawal', () => {
    const r = evaluateWithdrawal({ inputs: [note({})], w: 500n * U, recipient: '0x4444444444444444444444444444444444444444', deposits: deps, history: hist, unspentNotes: 1, nowSec: now });
    expect(r.blocked).toBe(false);
    expect(r.depositsAfterFunding).toBe(24);
  });
  it('blocks a fresh deposit withdrawn immediately, overrides downgrade to warnings', () => {
    const n = note({ fundedAt: now - 60, fundingLeaf: 46 });
    const r = evaluateWithdrawal({ inputs: [n], w: 1000n * U, deposits: deps, history: hist, unspentNotes: 3, nowSec: now });
    expect(r.blocked).toBe(true);
    expect(r.findings.map((f) => f.rule).sort()).toEqual(['W3', 'W4', 'W5', 'W6']);
    const o = evaluateWithdrawal({ inputs: [n], w: 1000n * U, deposits: deps, history: hist, unspentNotes: 1, nowSec: now, overrides: { ignoreDelay: true, ignoreAnonymity: true } });
    expect(o.blocked).toBe(false);
    expect(evaluateInternalSpend([n], deps, now).every((f) => f.level !== 'block')).toBe(true);
  });
});
