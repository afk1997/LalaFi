/**
 * W2: recipients are never reused, and never the depositor's address or any address it has
 * interacted with (checked against local history only, never a remote query).
 */
import { getAddress, isAddress, type Address } from 'viem';
import { OVERRIDE_FLAGS, type Finding } from './types.js';

export interface AddressHistory {
  /** Recipients already used for withdrawals. */
  usedRecipients: readonly string[];
  /** Depositor EOAs, LP/validator EOAs, and any address they interacted with. */
  linkedAddresses: readonly string[];
}

const norm = (a: string): string => a.toLowerCase();

export function checkRecipient(recipient: Address, history: AddressHistory, override = false): Finding | undefined {
  if (!isAddress(recipient, { strict: false })) return { rule: 'W2', level: 'block', message: 'recipient is not a valid address' };
  const r = norm(getAddress(recipient));
  const reused = history.usedRecipients.some((a) => norm(a) === r);
  const linked = history.linkedAddresses.some((a) => norm(a) === r);
  if (!reused && !linked) return undefined;
  const why = reused ? 'was already used as a withdrawal recipient' : 'is linked to your deposits (depositor or counterparty)';
  return {
    rule: 'W2',
    level: override ? 'warn' : 'block',
    message: `recipient ${recipient} ${why}; use --fresh`,
    overrideFlag: OVERRIDE_FLAGS.W2,
  };
}
