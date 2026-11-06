/**
 * Local depth-24 Merkle tree with full node storage (for path extraction), pair insertion
 * identical to PRD 5.6, and a 100-root history mirroring HubCore.
 */
import { MAX_LEAVES, ROOT_HISTORY, TREE_DEPTH } from '../constants.js';
import { assertField, type Field } from '../crypto/field.js';
import { H2 } from '../crypto/poseidon.js';
import { zeroHashes } from './zeros.js';

export interface MerklePath {
  leafIndex: number;
  /** Sibling at each level 0..23. */
  pathElements: Field[];
  /** bit_l(leafIndex) for l = 0..23. */
  pathIndices: number[];
  root: Field;
}

export class MerkleTree {
  /** layers[0] = leaves, layers[24] = [root]. Missing entries are zero subtrees. */
  private readonly layers: Field[][];
  private readonly history: Field[] = [];
  private readonly historySet = new Map<Field, number>();

  constructor() {
    this.layers = Array.from({ length: TREE_DEPTH + 1 }, () => [] as Field[]);
    this.pushRoot(zeroHashes()[TREE_DEPTH]!);
  }

  /** Bulk build from an even-length list of leaves (n hashes total). Root history = [final root]. */
  static fromLeaves(leaves: readonly Field[]): MerkleTree {
    if (leaves.length % 2 !== 0) throw new Error('leaf count must be even (pair insertion)');
    if (leaves.length > MAX_LEAVES) throw new Error('TreeFull');
    const t = new MerkleTree();
    const Z = zeroHashes();
    t.layers[0] = leaves.map((x) => assertField(x, 'leaf'));
    for (let l = 0; l < TREE_DEPTH; l++) {
      const cur = t.layers[l]!;
      const next: Field[] = new Array<Field>(Math.ceil(cur.length / 2));
      for (let j = 0; j < next.length; j++) {
        next[j] = H2(cur[2 * j]!, cur[2 * j + 1] ?? Z[l]!);
      }
      t.layers[l + 1] = next;
    }
    t.history.length = 0;
    t.historySet.clear();
    t.pushRoot(t.layers[TREE_DEPTH]![0] ?? Z[TREE_DEPTH]!);
    return t;
  }

  get size(): number {
    return this.layers[0]!.length;
  }

  leaves(): readonly Field[] {
    return this.layers[0]!;
  }

  leaf(i: number): Field | undefined {
    return this.layers[0]![i];
  }

  root(): Field {
    return this.history[this.history.length - 1]!;
  }

  /** Insert (l, r) at nextIndex; returns the leaf index of l. */
  insertPair(l: Field, r: Field): number {
    assertField(l, 'leaf');
    assertField(r, 'leaf');
    const n = this.size;
    if (n + 2 > MAX_LEAVES) throw new Error('TreeFull');
    const Z = zeroHashes();
    this.layers[0]!.push(l, r);
    let idx = n / 2;
    let cur = H2(l, r);
    this.layers[1]![idx] = cur;
    for (let lvl = 1; lvl < TREE_DEPTH; lvl++) {
      const layer = this.layers[lvl]!;
      cur = idx % 2 === 0 ? H2(cur, layer[idx + 1] ?? Z[lvl]!) : H2(layer[idx - 1]!, cur);
      idx = Math.floor(idx / 2);
      this.layers[lvl + 1]![idx] = cur;
    }
    this.pushRoot(cur);
    return n;
  }

  /** Insert an arbitrary batch, padding an odd count with Z0 (as insertDepositLeaves). */
  insertBatch(leaves: readonly Field[]): number {
    if (leaves.length === 0) throw new Error('empty batch');
    const first = this.size;
    const padded = leaves.length % 2 === 0 ? leaves : [...leaves, zeroHashes()[0]!];
    for (let k = 0; k < padded.length; k += 2) this.insertPair(padded[k]!, padded[k + 1]!);
    return first;
  }

  isKnownRoot(root: Field): boolean {
    return this.historySet.has(root);
  }

  /** Recent roots (oldest first), at most ROOT_HISTORY. */
  recentRoots(): readonly Field[] {
    return [...this.history];
  }

  path(leafIndex: number): MerklePath {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.size) throw new RangeError('leaf not in tree');
    const Z = zeroHashes();
    const pathElements: Field[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let l = 0; l < TREE_DEPTH; l++) {
      pathElements.push(this.layers[l]![idx ^ 1] ?? Z[l]!);
      pathIndices.push(idx & 1);
      idx >>= 1;
    }
    return { leafIndex, pathElements, pathIndices, root: this.root() };
  }

  private pushRoot(r: Field): void {
    this.history.push(r);
    this.historySet.set(r, (this.historySet.get(r) ?? 0) + 1);
    if (this.history.length > ROOT_HISTORY) {
      const old = this.history.shift()!;
      const c = this.historySet.get(old)! - 1;
      if (c === 0) this.historySet.delete(old);
      else this.historySet.set(old, c);
    }
  }
}

/** Bottom-up membership check from PRD 5.6. */
export function computeRootFromPath(leaf: Field, leafIndex: number, pathElements: readonly Field[]): Field {
  if (pathElements.length !== TREE_DEPTH) throw new RangeError('path must have 24 elements');
  let h = leaf;
  for (let l = 0; l < TREE_DEPTH; l++) {
    const s = pathElements[l]!;
    h = ((leafIndex >> l) & 1) === 0 ? H2(h, s) : H2(s, h);
  }
  return h;
}

export function verifyPath(leaf: Field, p: MerklePath, root: Field = p.root): boolean {
  return computeRootFromPath(leaf, p.leafIndex, p.pathElements) === root;
}
