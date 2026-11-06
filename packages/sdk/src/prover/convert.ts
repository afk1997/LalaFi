/** Pure (browser-safe) conversion of snarkjs proofs to the Solidity Proof struct. */
import type { SnarkjsProof, SolidityProof } from './types.js';

export const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export class ProverError extends Error {
  override name = 'ProverError';
}

function coord(s: string | undefined, what: string): bigint {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new ProverError(`bad proof coordinate ${what}`);
  const v = BigInt(s);
  if (v >= BN254_Q) throw new ProverError(`proof coordinate ${what} not in base field`);
  return v;
}

/**
 * snarkjs proof -> Types.sol Proof. G2 coordinates are swapped exactly like
 * `snarkjs zkey export soliditycalldata`: b = [[b01, b00], [b11, b10]].
 */
export function toSolidityProof(p: SnarkjsProof): SolidityProof {
  const a = p.pi_a;
  const b = p.pi_b;
  const c = p.pi_c;
  if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(c) || b.length < 2) throw new ProverError('malformed proof');
  return {
    a: [coord(a[0], 'a0'), coord(a[1], 'a1')],
    b: [
      [coord(b[0]?.[1], 'b01'), coord(b[0]?.[0], 'b00')],
      [coord(b[1]?.[1], 'b11'), coord(b[1]?.[0], 'b10')],
    ],
    c: [coord(c[0], 'c0'), coord(c[1], 'c1')],
  };
}
