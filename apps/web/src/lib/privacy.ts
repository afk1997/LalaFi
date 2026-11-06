/**
 * The CLI's privacy defaults (PRD 12.3 W2–W4) phrased for the web. Withdrawals that trip one are
 * allowed only after the person explicitly confirms they understand the risk.
 */
import { depositsAfter, type OwnedNote } from '@xpool/sdk/browser';
import type { Address } from 'viem';
import type { ScanResult } from './scan';

export interface Hint {
  id: 'delay' | 'crowd' | 'linked' | 'exact';
  text: string;
}

export function withdrawalHints(opts: {
  scanned: ScanResult;
  recipient?: Address;
  connected?: Address;
  amount?: bigint;
  nowSec?: number;
}): Hint[] {
  const { scanned, recipient, connected, amount } = opts;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const live: OwnedNote[] = scanned.notes.filter((n) => !n.spent);
  if (live.length === 0) return [];
  const hints: Hint[] = [];
  const newest = Math.max(...live.map((n) => n.fundedAt));
  const mins = Math.max(0, Math.round((now - newest) / 60));
  if (now - newest < 24 * 3600) {
    hints.push({
      id: 'delay',
      text:
        mins < 2
          ? 'You deposited a moment ago. Withdrawing this soon makes the two easy to match.'
          : mins < 60
            ? `You deposited ${mins} minutes ago. Withdrawing this soon makes the two easy to match.`
            : `You deposited ${Math.round(mins / 60)} ${Math.round(mins / 60) === 1 ? 'hour' : 'hours'} ago. Waiting a day makes the two harder to match.`,
    });
  }
  const after = Math.min(...live.map((n) => depositsAfter(scanned.view.state.deposits, n.fundingLeaf)));
  if (after < 20) {
    hints.push({
      id: 'crowd',
      text:
        after === 0
          ? 'No one has deposited since you did, so your withdrawal has no crowd to blend into.'
          : `Only ${after} ${after === 1 ? 'deposit has' : 'deposits have'} come in since yours, so your withdrawal blends into a small crowd.`,
    });
  }
  if (recipient && connected && recipient.toLowerCase() === connected.toLowerCase()) {
    hints.push({ id: 'linked', text: 'This is the wallet you have connected. Sending to it links the withdrawal to you.' });
  }
  if (amount && live.some((n) => n.fundingAmounts.some((d) => d > 0n && (amount * 100n >= d * 99n && amount * 100n <= d * 101n)))) {
    hints.push({ id: 'exact', text: 'This is almost exactly what you deposited. A different or rounder amount is harder to trace.' });
  }
  return hints;
}
