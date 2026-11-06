/**
 * Zero subtrees (PRD 5.6): Z0 = keccak256("xpool.v1.zero") mod p, Z[l+1] = H2(Z[l], Z[l]).
 * Empty root = Z[24].
 */
import { keccak256, toBytes } from 'viem';
import { TREE_DEPTH, ZERO_LEAF_SEED } from '../constants.js';
import { mod, type Field } from '../crypto/field.js';
import { H2 } from '../crypto/poseidon.js';

let cache: readonly Field[] | undefined;

export function zeroLeaf(): Field {
  return mod(BigInt(keccak256(toBytes(ZERO_LEAF_SEED))));
}

/** Z[0..24] (25 values). */
export function zeroHashes(): readonly Field[] {
  if (cache) return cache;
  const z: Field[] = [zeroLeaf()];
  for (let l = 0; l < TREE_DEPTH; l++) z.push(H2(z[l]!, z[l]!));
  cache = Object.freeze(z);
  return cache;
}

export function emptyRoot(): Field {
  return zeroHashes()[TREE_DEPTH]!;
}
