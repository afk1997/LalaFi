import { mnemonicToSeed } from '../src/keys/mnemonic.js';
import { deriveKeys } from '../src/keys/derive.js';
import { commitment, nullifier, createNote } from '../src/notes/note.js';
import type { OwnedNote } from '../src/notes/store.js';
import type { MerkleTree } from '../src/tree/merkle.js';

/** TEST mnemonic (BIP-39 test vector). NEVER use with real funds. */
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

export const TEST_SEED = mnemonicToSeed(TEST_MNEMONIC);
export const TEST_KEYS = deriveKeys(TEST_SEED, 0);

/** Insert a note for TEST_KEYS into the tree (paired with a random-ish filler) and return it as owned. */
export function ownedNoteInTree(tree: MerkleTree, amount: bigint, fundedAt = 0): OwnedNote {
  const n = createNote(amount, TEST_KEYS.pk);
  const c = commitment(n);
  const leafIndex = tree.insertPair(c, 12345n);
  return {
    ...n,
    commitment: c,
    leafIndex,
    nullifier: nullifier(TEST_KEYS.sk, c, leafIndex),
    source: 'l1-deposit',
    originChainId: 31337,
    fundedAt,
    fundingLeaf: leafIndex,
    fundingAmounts: [amount],
    spent: false,
  };
}
