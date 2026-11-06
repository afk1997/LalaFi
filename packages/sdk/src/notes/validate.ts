/**
 * Validate-before-accept (PRD 5.8): after trial decryption, recompute the commitment and compare
 * with the on-chain value. Mismatches are ignored.
 */
import { decryptNote } from '../crypto/box.js';
import { isField, type Field } from '../crypto/field.js';
import { commitment, ownerDigest, type Note } from './note.js';

export interface DecryptContext {
  pk: Field;
  encSk: Uint8Array;
}

/** Decrypt and accept only if C = H3(a, 1, H2(pk, b)) equals `onChainCommitment`. */
export function tryAcceptForCommitment(ctx: DecryptContext, blob: Uint8Array, onChainCommitment: Field): Note | null {
  if (!isField(onChainCommitment)) return null;
  const pt = decryptNote(ctx.encSk, blob);
  if (!pt) return null;
  const note: Note = { amount: pt.amount, pk: ctx.pk, blinding: pt.blinding };
  return commitment(note) === onChainCommitment ? note : null;
}

/**
 * For L2 deposits (commitment not yet known): accept only if H2(pk, b) equals the public owner digest
 * and the decrypted amount equals the recorded deposit amount. The commitment is checked again once
 * `L2DepositInserted` arrives.
 */
export function tryAcceptForDeposit(
  ctx: DecryptContext,
  blob: Uint8Array,
  onChainDigest: Field,
  onChainAmount: bigint,
): Note | null {
  if (!isField(onChainDigest)) return null;
  const pt = decryptNote(ctx.encSk, blob);
  if (!pt) return null;
  if (pt.amount !== onChainAmount) return null;
  if (ownerDigest(ctx.pk, pt.blinding) !== onChainDigest) return null;
  return { amount: pt.amount, pk: ctx.pk, blinding: pt.blinding };
}
