import type { Field } from '../crypto/field.js';

/** Types.sol `Proof`, with G2 `b` already in verifier order (coordinates swapped). */
export interface SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
}

/** Types.sol `PublicInputs`. */
export interface PublicInputs {
  root: Field;
  publicAmount: Field;
  extDataHash: Field;
  inputNullifiers: [Field, Field];
  outputCommitments: [Field, Field];
}

/** Circuit witness input; names are exactly the PRD 6.2 signal names. Values are decimal strings. */
export interface WitnessInput {
  root: string;
  publicAmount: string;
  extDataHash: string;
  inputNullifier: [string, string];
  outputCommitment: [string, string];
  inAmount: [string, string];
  inSk: [string, string];
  inBlinding: [string, string];
  inLeafIndex: [string, string];
  inPathElements: [string[], string[]];
  outAmount: [string, string];
  outPk: [string, string];
  outBlinding: [string, string];
}

/** snarkjs groth16 proof JSON. */
export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}

/** Public signals in snarkjs order. */
export function publicSignals(pi: PublicInputs): bigint[] {
  return [pi.root, pi.publicAmount, pi.extDataHash, ...pi.inputNullifiers, ...pi.outputCommitments];
}
