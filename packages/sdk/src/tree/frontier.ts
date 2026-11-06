/**
 * Line-for-line port of the PRD 5.6 pair-insertion frontier algorithm (as in HubCore /
 * Tornado Nova MerkleTreeWithHistory). Used as the reference the local tree is checked against.
 */
import { MAX_LEAVES, ROOT_HISTORY, TREE_DEPTH } from '../constants.js';
import type { Field } from '../crypto/field.js';
import { H2 } from '../crypto/poseidon.js';
import { zeroHashes } from './zeros.js';

export class FrontierTree {
  nextIndex = 0;
  private readonly F: Field[] = new Array<Field>(TREE_DEPTH).fill(0n);
  private readonly roots: Field[] = [];

  constructor() {
    this.roots.push(zeroHashes()[TREE_DEPTH]!);
  }

  insertPair(l: Field, r: Field): number {
    if (this.nextIndex + 2 > MAX_LEAVES) throw new Error('TreeFull');
    const Z = zeroHashes();
    let idx = this.nextIndex / 2;
    let cur = H2(l, r);
    for (let lvl = 1; lvl < TREE_DEPTH; lvl++) {
      if (idx % 2 === 0) {
        this.F[lvl] = cur;
        cur = H2(cur, Z[lvl]!);
      } else {
        cur = H2(this.F[lvl]!, cur);
      }
      idx = Math.floor(idx / 2);
    }
    this.roots.push(cur);
    if (this.roots.length > ROOT_HISTORY) this.roots.shift();
    this.nextIndex += 2;
    return this.nextIndex - 2;
  }

  root(): Field {
    return this.roots[this.roots.length - 1]!;
  }

  isKnownRoot(root: Field): boolean {
    return this.roots.includes(root);
  }
}
