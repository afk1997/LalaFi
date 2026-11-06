/**
 * Combined pre-spend privacy evaluation (W2-W6).
 */
import type { Address } from 'viem';
import type { OwnedNote } from '../notes/store.js';
import type { DepositRecord } from '../sync/state.js';
import { checkAmountHygiene } from './amount.js';
import { checkAnonymity, depositsAfter, kFeasible } from './anonymity.js';
import { checkDelay } from './delay.js';
import { checkRecipient, type AddressHistory } from './recipient.js';
import type { Finding, Overrides } from './types.js';

export interface WithdrawalPolicyInput {
  inputs: readonly OwnedNote[];
  w: bigint;
  recipient?: Address;
  deposits: readonly DepositRecord[];
  history: AddressHistory;
  /** Number of unspent notes in the wallet (W6). */
  unspentNotes: number;
  nowSec: number;
  overrides?: Overrides;
}

export interface PolicyResult {
  findings: Finding[];
  blocked: boolean;
  depositsAfterFunding: number;
  kFeas: number;
}

export function evaluateWithdrawal(i: WithdrawalPolicyInput): PolicyResult {
  const ov = i.overrides ?? {};
  const findings: Finding[] = [];
  const fundedAt = Math.max(...i.inputs.map((n) => n.fundedAt));
  const fundingLeaf = Math.max(...i.inputs.map((n) => n.fundingLeaf));
  const after = depositsAfter(i.deposits, fundingLeaf);

  const d = checkDelay(fundedAt, i.nowSec, ov.ignoreDelay);
  if (d) findings.push(d);
  const a = checkAnonymity(after, ov.ignoreAnonymity);
  if (a) findings.push(a);
  if (i.recipient) {
    const r = checkRecipient(i.recipient, i.history, ov.allowLinkedRecipient);
    if (r) findings.push(r);
  }
  findings.push(...checkAmountHygiene(i.w, i.inputs.flatMap((n) => n.fundingAmounts)));
  if (i.unspentNotes > 2) {
    findings.push({ rule: 'W6', level: 'info', message: `you hold ${i.unspentNotes} notes; consider \`xpool merge\` before withdrawing` });
  }
  return {
    findings,
    blocked: findings.some((f) => f.level === 'block'),
    depositsAfterFunding: after,
    kFeas: kFeasible(i.deposits, i.w, i.nowSec),
  };
}

/** For transfers/merges there is no public recipient or amount; only W3/W4 timing advice applies (warn-only). */
export function evaluateInternalSpend(inputs: readonly OwnedNote[], deposits: readonly DepositRecord[], nowSec: number): Finding[] {
  const out: Finding[] = [];
  const d = checkDelay(Math.max(...inputs.map((n) => n.fundedAt)), nowSec, true);
  if (d) out.push({ ...d, level: 'warn' });
  const a = checkAnonymity(depositsAfter(deposits, Math.max(...inputs.map((n) => n.fundingLeaf))), true);
  if (a) out.push({ ...a, level: 'info' });
  return out;
}
