/**
 * Input selection for the 2-in circuit, fresh dummy inputs (random sk, a = 0), and outputs
 * (change to self, recipient note, zero outputs encrypted to random throwaway keys, W12).
 */
import { TREE_DEPTH } from '../constants.js';
import { encryptNote, randomX25519KeyPair } from '../crypto/box.js';
import { randomField, randomNonZeroField, type Field } from '../crypto/field.js';
import { H1 } from '../crypto/poseidon.js';
import { commitment, nullifier } from '../notes/note.js';
import type { OwnedNote } from '../notes/store.js';
import type { MerkleTree } from '../tree/merkle.js';

export class SelectionError extends Error {
  override name = 'SelectionError';
  constructor(message: string, readonly needsMerge = false) {
    super(message);
  }
}

/**
 * Pick 1 or 2 unspent notes covering `target`: the smallest single note that covers it, otherwise
 * the pair with the smallest sufficient sum. Throws (needsMerge) if 3+ notes would be needed.
 */
export function selectInputs(notes: readonly OwnedNote[], target: bigint): OwnedNote[] {
  if (target <= 0n) throw new SelectionError('target must be > 0');
  const avail = notes.filter((n) => !n.spent && n.amount > 0n).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  const single = avail.find((n) => n.amount >= target);
  if (single) return [single];
  let best: [OwnedNote, OwnedNote] | undefined;
  let bestSum = 0n;
  for (let i = 0; i < avail.length; i++) {
    for (let j = i + 1; j < avail.length; j++) {
      const s = avail[i]!.amount + avail[j]!.amount;
      if (s >= target && (best === undefined || s < bestSum)) {
        best = [avail[i]!, avail[j]!];
        bestSum = s;
      }
    }
  }
  if (best) return best;
  const total = avail.reduce((s, n) => s + n.amount, 0n);
  if (total >= target) throw new SelectionError('balance is spread over too many notes; run `xpool merge` first', true);
  throw new SelectionError('insufficient shielded balance');
}

export interface SpendInput {
  dummy: boolean;
  sk: Field;
  amount: bigint;
  blinding: Field;
  leafIndex: number;
  pathElements: Field[];
  commitment: Field;
  nullifier: Field;
}

/** A dummy input with a fresh random key (PRD 5.11: never reuse dummy keys). */
export function dummyInput(): SpendInput {
  const sk = randomNonZeroField();
  const blinding = randomField();
  const c = commitment({ amount: 0n, pk: H1(sk), blinding });
  return {
    dummy: true,
    sk,
    amount: 0n,
    blinding,
    leafIndex: 0,
    pathElements: new Array<Field>(TREE_DEPTH).fill(0n),
    commitment: c,
    nullifier: nullifier(sk, c, 0),
  };
}

/** A real input: recompute C from the note and check it sits at its leaf in the local tree. */
export function realInput(note: OwnedNote, sk: Field, tree: MerkleTree): SpendInput {
  const c = commitment(note);
  if (c !== note.commitment) throw new SelectionError(`note at leaf ${note.leafIndex} is corrupt`);
  if (tree.leaf(note.leafIndex) !== c) throw new SelectionError(`note at leaf ${note.leafIndex} not in local tree (sync first)`);
  const path = tree.path(note.leafIndex);
  return {
    dummy: false,
    sk,
    amount: note.amount,
    blinding: note.blinding,
    leafIndex: note.leafIndex,
    pathElements: path.pathElements,
    commitment: c,
    nullifier: nullifier(sk, c, note.leafIndex),
  };
}

export type OutputRole = 'change' | 'recipient' | 'dummy';

export interface SpendOutput {
  role: OutputRole;
  amount: bigint;
  pk: Field;
  blinding: Field;
  commitment: Field;
  encrypted: Uint8Array;
}

/** A real output note for (pk, encPk), encrypted to encPk. */
export function noteOutput(role: 'change' | 'recipient', amount: bigint, pk: Field, encPk: Uint8Array): SpendOutput {
  const blinding = randomField();
  return { role, amount, pk, blinding, commitment: commitment({ amount, pk, blinding }), encrypted: encryptNote(encPk, { amount, blinding }) };
}

/** Zero-value output: random owner, encrypted to a random throwaway key (indistinguishable). */
export function dummyOutput(): SpendOutput {
  const pk = H1(randomNonZeroField());
  const blinding = randomField();
  const throwaway = randomX25519KeyPair();
  return {
    role: 'dummy',
    amount: 0n,
    pk,
    blinding,
    commitment: commitment({ amount: 0n, pk, blinding }),
    encrypted: encryptNote(throwaway.publicKey, { amount: 0n, blinding }),
  };
}
