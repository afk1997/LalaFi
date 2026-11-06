import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { P, TREE_DEPTH } from '../src/constants.js';
import { H2 } from '../src/crypto/poseidon.js';
import { randomField, type Field } from '../src/crypto/field.js';
import { MerkleTree, FrontierTree, zeroHashes, zeroLeaf, emptyRoot, verifyPath, computeRootFromPath } from '../src/tree/index.js';

/** Naive reference: full recomputation over 2^24 leaves using zero subtrees. */
function naiveRoot(leaves: Field[]): Field {
  const Z = zeroHashes();
  let layer = [...leaves];
  for (let l = 0; l < TREE_DEPTH; l++) {
    const next: Field[] = [];
    for (let j = 0; j < Math.ceil(layer.length / 2); j++) next.push(H2(layer[2 * j]!, layer[2 * j + 1] ?? Z[l]!));
    layer = next;
  }
  return layer[0] ?? Z[TREE_DEPTH]!;
}

describe('zero hashes', () => {
  it('Z0 = keccak256("xpool.v1.zero") mod p and Z[l+1] = H2(Z[l], Z[l])', () => {
    expect(zeroLeaf()).toBe(BigInt(keccak256(toBytes('xpool.v1.zero'))) % P);
    const Z = zeroHashes();
    expect(Z).toHaveLength(25);
    for (let l = 0; l < 24; l++) expect(Z[l + 1]).toBe(H2(Z[l]!, Z[l]!));
    expect(new MerkleTree().root()).toBe(emptyRoot());
  });
});

describe('MerkleTree', () => {
  it('matches the PRD frontier algorithm and a naive reference after every pair', () => {
    const t = new MerkleTree();
    const f = new FrontierTree();
    const leaves: Field[] = [];
    for (let k = 0; k < 20; k++) {
      const a = randomField();
      const b = randomField();
      leaves.push(a, b);
      expect(t.insertPair(a, b)).toBe(2 * k);
      expect(f.insertPair(a, b)).toBe(2 * k);
      expect(t.root()).toBe(f.root());
      if (k % 5 === 4) expect(t.root()).toBe(naiveRoot(leaves));
    }
    expect(MerkleTree.fromLeaves(leaves).root()).toBe(t.root());
  });

  it('extracts valid paths for every leaf', () => {
    const t = new MerkleTree();
    for (let k = 0; k < 9; k++) t.insertPair(randomField(), randomField());
    for (let i = 0; i < t.size; i++) {
      const p = t.path(i);
      expect(p.pathElements).toHaveLength(24);
      expect(p.pathIndices[0]).toBe(i & 1);
      expect(verifyPath(t.leaf(i)!, p)).toBe(true);
      expect(computeRootFromPath(t.leaf(i)! + 1n, i, p.pathElements)).not.toBe(t.root());
    }
    expect(() => t.path(t.size)).toThrow();
  });

  it('pads odd batches with Z0 and keeps a 100-root history', () => {
    const t = new MerkleTree();
    const first = t.insertBatch([5n, 6n, 7n]);
    expect(first).toBe(0);
    expect(t.size).toBe(4);
    expect(t.leaf(3)).toBe(zeroLeaf());
    const r0 = t.root();
    for (let k = 0; k < 99; k++) t.insertPair(BigInt(k), 1n);
    expect(t.isKnownRoot(r0)).toBe(true);
    t.insertPair(1n, 2n);
    expect(t.isKnownRoot(r0)).toBe(false);
    expect(t.recentRoots()).toHaveLength(100);
  });

  it('rejects odd bulk loads and non-field leaves', () => {
    expect(() => MerkleTree.fromLeaves([1n])).toThrow();
    expect(() => new MerkleTree().insertPair(P, 0n)).toThrow();
  });
});
