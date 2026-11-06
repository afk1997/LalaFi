/**
 * Note model (PRD 5.4, 5.5):
 *   note = (a, t = 1, pk, b)
 *   P = H2(pk, b)        C = H3(a, 1, P)
 *   sigma = H3(sk, C, i) N = H3(C, i, sigma)
 */
import { MAX_LEAVES, TOKEN_ID } from '../constants.js';
import { assertAmount, assertField, randomField, type Field } from '../crypto/field.js';
import { H2, H3 } from '../crypto/poseidon.js';

export interface Note {
  amount: bigint;
  pk: Field;
  blinding: Field;
}

export function ownerDigest(pk: Field, blinding: Field): Field {
  return H2(pk, blinding);
}

export function commitment(note: Note): Field {
  assertAmount(note.amount);
  return H3(note.amount, TOKEN_ID, ownerDigest(note.pk, note.blinding));
}

export function commitmentFromDigest(amount: bigint, digest: Field): Field {
  return H3(assertAmount(amount), TOKEN_ID, digest);
}

function assertLeafIndex(i: number): bigint {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_LEAVES) throw new RangeError('leaf index out of range');
  return BigInt(i);
}

export function signature(sk: Field, c: Field, leafIndex: number): Field {
  return H3(assertField(sk, 'sk'), c, assertLeafIndex(leafIndex));
}

export function nullifier(sk: Field, c: Field, leafIndex: number): Field {
  const i = assertLeafIndex(leafIndex);
  return H3(c, i, signature(sk, c, leafIndex));
}

/** New note for `pk` with fresh CSPRNG blinding. */
export function createNote(amount: bigint, pk: Field, blinding: Field = randomField()): Note {
  return { amount: assertAmount(amount), pk: assertField(pk, 'pk'), blinding: assertField(blinding, 'blinding') };
}
