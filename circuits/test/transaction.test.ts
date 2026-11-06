// PRD 15.1: positive and negative cases for Transaction(24, 2, 2, 1).
//
// Negative cases assert the FIRST failing constraint (template + Transaction source line), so
// each one fails for the intended reason and not because of an unrelated inconsistency.
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Hasher,
  type InputNote,
  type TxPlan,
  MAX_AMOUNT,
  MAX_LEAF_INDEX,
  P,
  SparseMerkleTree,
  deriveNote,
  dummyInput,
  freshOutput,
  getHasher,
  nullifierOf,
  planTx,
  publicSignalsOf,
  randomField,
  rootFromPath,
  toCircuitInput,
} from "../lib/xpool.js";
import { calculateWitness, failureAt, patchWitness, witnessError, witnessSatisfies, witnessValues } from "../lib/witness.js";

const USDC = 1_000_000n;
const PHI_BPS = 10n; // protocol fee 0.10 %
const RELAYER_FEE = 500_000n; // 0.5 USDC
const protocolFee = (w: bigint): bigint => (w * PHI_BPS + 9_999n) / 10_000n;

// Where each guard lives in transaction.circom.
const AT = {
  nullifier: "inNullifier[j].out === inputNullifier[j];",
  inRange: "inAmountBits[j].in <== inAmount[j];",
  indexRange: "inIndexBits[j].in <== inLeafIndex[j];",
  root: "inRootCheck[j].enabled <== inAmount[j];",
  outCommit: "outCommit[k].out === outputCommitment[k];",
  outRange: "outAmountBits[k].in <== outAmount[k];",
  distinct: "sameNullifier[idx].out === 0;",
  balance: "sumIns + publicAmount === sumOuts;",
};

let h: Hasher;

beforeAll(async () => {
  h = await getHasher();
});

function newNote(amount: bigint, index: bigint, sk = randomField()): InputNote {
  return { amount, sk, blinding: randomField(), index };
}

function place(tree: SparseMerkleTree, n: InputNote): InputNote {
  tree.insert(n.index, deriveNote(h, n).commitment);
  return n;
}

/** Tree with some unrelated leaves so paths are not all-zero. */
function populatedTree(): SparseMerkleTree {
  const tree = new SparseMerkleTree(h);
  for (const i of [0n, 1n, 2n, 3n, 10n, 11n, 1000n, 1001n]) tree.insert(i, randomField());
  return tree;
}

async function expectValid(plan: TxPlan): Promise<void> {
  const err = await witnessError(toCircuitInput(plan));
  expect(err).toBeNull();
  const w = await witnessValues(toCircuitInput(plan));
  // wire 0 is the constant 1; wires 1..7 are the public signals in PRD 6.2 order
  expect(w.slice(1, 8).map(String)).toEqual(publicSignalsOf(plan));
}

async function expectFailure(plan: TxPlan, at: string, template?: string): Promise<void> {
  const err = await witnessError(toCircuitInput(plan));
  expect(err, "witness generation must fail").not.toBeNull();
  expect(err).toMatch(failureAt(at, template));
}

describe("tree helper sanity", () => {
  it("empty root is Z24 and paths reproduce the root", () => {
    const tree = new SparseMerkleTree(h);
    expect(tree.root).toBe(tree.zeros[24]);
    const leaves = new Map<bigint, bigint>([0n, 1n, 2n, 1000n, 1001n, 77777n, MAX_LEAF_INDEX].map((i) => [i, randomField()]));
    for (const [i, leaf] of leaves) tree.insert(i, leaf);
    for (const [i, leaf] of leaves) expect(rootFromPath(h, leaf, i, tree.path(i))).toBe(tree.root);
    expect(rootFromPath(h, tree.zeros[0]!, 5n, tree.path(5n))).toBe(tree.root); // empty leaf
  });
});

describe("positive cases (PRD 15.1, 6.4)", () => {
  it("full withdrawal: note(w + fees) + dummy -> 0 + 0", async () => {
    const tree = populatedTree();
    const w = 1000n * USDC;
    const v = w + RELAYER_FEE + protocolFee(w);
    const note = place(tree, newNote(v, 6n));
    await expectValid(planTx(h, tree, [note, dummyInput()], [freshOutput(0n), freshOutput(0n)], v));
  });

  it("partial withdrawal: 100 from 1000 with change", async () => {
    const tree = populatedTree();
    const w = 100n * USDC;
    const v = w + RELAYER_FEE + protocolFee(w);
    const note = place(tree, newNote(1000n * USDC, 7n));
    const ownPk = deriveNote(h, note).pk;
    await expectValid(planTx(h, tree, [dummyInput(), note], [freshOutput(1000n * USDC - v, ownPk), freshOutput(0n)], v));
  });

  it("private transfer of 300 (relayer fee, and without any fee)", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1000n * USDC, 12n));
    const bobPk = h.H1(randomField());
    const ownPk = deriveNote(h, note).pk;
    await expectValid(
      planTx(h, tree, [note, dummyInput()], [freshOutput(300n * USDC, bobPk), freshOutput(700n * USDC - RELAYER_FEE, ownPk)], RELAYER_FEE),
    );
    await expectValid(
      planTx(h, tree, [note, dummyInput()], [freshOutput(300n * USDC, bobPk), freshOutput(700n * USDC, ownPk)], 0n),
    );
  });

  it("merge: note(400) + note(600) -> note(1000 - f_rel) + 0", async () => {
    const tree = populatedTree();
    const sk = randomField();
    const a = place(tree, newNote(400n * USDC, 20n, sk));
    const b = place(tree, newNote(600n * USDC, 33n, sk));
    await expectValid(planTx(h, tree, [a, b], [freshOutput(1000n * USDC - RELAYER_FEE, h.H1(sk)), freshOutput(0n)], RELAYER_FEE));
  });

  it("fee-only: note(x) + dummy -> note(x - f_rel) + 0", async () => {
    const tree = populatedTree();
    const x = 123n * USDC + 456n;
    const note = place(tree, newNote(x, 1002n));
    await expectValid(planTx(h, tree, [note, dummyInput()], [freshOutput(x - RELAYER_FEE), freshOutput(0n)], RELAYER_FEE));
  });

  it("dummy inputs skip the Merkle check (any path, any index, any root)", async () => {
    const tree = populatedTree();
    const d0 = { ...dummyInput(), index: 12345n };
    const d1 = { ...dummyInput(), index: MAX_LEAF_INDEX };
    const plan = planTx(h, tree, [d0, d1], [freshOutput(0n), freshOutput(0n)], 0n);
    plan.paths = [plan.paths[0].map(() => randomField()), plan.paths[1].map(() => randomField())];
    plan.root = randomField();
    await expectValid(plan);
  });

  it("both inputs real (sibling leaves), two non-zero outputs", async () => {
    const tree = populatedTree();
    const a = place(tree, newNote(250n * USDC, 40n));
    const b = place(tree, newNote(750n * USDC + 1n, 41n));
    await expectValid(planTx(h, tree, [a, b], [freshOutput(600n * USDC), freshOutput(400n * USDC + 1n - RELAYER_FEE)], RELAYER_FEE));
  });

  it("maximum amounts: 2^248 - 1 on inputs and outputs", async () => {
    const tree = populatedTree();
    const a = place(tree, newNote(MAX_AMOUNT, 50n));
    const b = place(tree, newNote(MAX_AMOUNT, 51n));
    await expectValid(planTx(h, tree, [a, b], [freshOutput(MAX_AMOUNT), freshOutput(MAX_AMOUNT)], 0n));
    await expectValid(planTx(h, tree, [a, dummyInput()], [freshOutput(0n), freshOutput(MAX_AMOUNT)], 0n));
  });

  it("deepest leaf index 2^24 - 1 (and leaf 0)", async () => {
    const tree = new SparseMerkleTree(h);
    const deep = place(tree, newNote(10n * USDC, MAX_LEAF_INDEX));
    const first = place(tree, newNote(5n * USDC, 0n));
    await expectValid(planTx(h, tree, [deep, first], [freshOutput(15n * USDC), freshOutput(0n)], 0n));
  });
});

describe("negative cases (PRD 15.1)", () => {
  it("wrong root", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(100n * USDC, 6n));
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(100n * USDC), freshOutput(0n)], 0n);
    plan.root = populatedTree().root; // a well-formed root of another tree
    await expectFailure(plan, AT.root, "ForceEqualIfEnabled");
  });

  it("wrong path: siblings of another leaf, or a wrong leaf index", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(100n * USDC, 6n));
    const outs = [freshOutput(100n * USDC), freshOutput(0n)] as [ReturnType<typeof freshOutput>, ReturnType<typeof freshOutput>];

    const p1 = planTx(h, tree, [note, dummyInput()], outs, 0n);
    p1.paths[0] = tree.path(10n);
    await expectFailure(p1, AT.root, "ForceEqualIfEnabled");

    // claim leaf 7 (sibling) with the right siblings for 6: the nullifier is computed for index 7
    const moved = { ...note, index: 7n };
    const p2 = planTx(h, tree, [moved, dummyInput()], outs, 0n);
    p2.paths[0] = tree.path(6n);
    await expectFailure(p2, AT.root, "ForceEqualIfEnabled");
  });

  it("non-zero amount with a bad path (while the same garbage passes for a = 0)", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1n, 6n));
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(1n), freshOutput(0n)], 0n);
    const garbage = plan.paths[0].map(() => randomField());
    plan.paths[0] = garbage;
    await expectFailure(plan, AT.root, "ForceEqualIfEnabled");

    const zero = place(tree, newNote(0n, 8n));
    const ok = planTx(h, tree, [zero, dummyInput()], [freshOutput(0n), freshOutput(0n)], 0n);
    ok.paths[0] = garbage;
    await expectValid(ok);
  });

  it("wrong sk: the note's (a, pk, b, i) are known but sk is not", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(100n * USDC, 6n));
    // same amount/blinding/index, different sk => pk' != pk => C' is not in the tree
    const thief = { ...note, sk: randomField() };
    const plan = planTx(h, tree, [thief, dummyInput()], [freshOutput(100n * USDC), freshOutput(0n)], 0n);
    await expectFailure(plan, AT.root, "ForceEqualIfEnabled");

    // right note, but a nullifier derived from another sk
    const p2 = planTx(h, tree, [note, dummyInput()], [freshOutput(100n * USDC), freshOutput(0n)], 0n);
    p2.inputNullifier[0] = nullifierOf(h, randomField(), deriveNote(h, note).commitment, note.index).nullifier;
    await expectFailure(p2, AT.nullifier);
  });

  it("duplicate nullifiers (same note twice in one spend)", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(100n * USDC, 6n));
    const plan = planTx(h, tree, [note, note], [freshOutput(200n * USDC), freshOutput(0n)], 0n);
    expect(plan.inputNullifier[0]).toBe(plan.inputNullifier[1]);
    await expectFailure(plan, AT.distinct);
  });

  it("output amount >= 2^248 (balance made to hold via publicAmount)", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1000n, 6n));
    for (const big of [1n << 248n, (1n << 248n) + 12345n, (1n << 253n) + 7n]) {
      const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(1000n), freshOutput(big)], 0n);
      plan.publicAmount = big; // 1000 + big = 1000 + big
      await expectFailure(plan, AT.outRange, "Num2Bits");
    }
  });

  it("input amount >= 2^248 (note is in the tree, everything else consistent)", async () => {
    const tree = populatedTree();
    const big = 1n << 248n;
    const note = place(tree, newNote(big, 6n));
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(0n), freshOutput(0n)], 0n);
    plan.publicAmount = P - big;
    await expectFailure(plan, AT.inRange, "Num2Bits");
  });

  it("leaf index >= 2^24 (aliasing a stored leaf to mint a second nullifier)", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(100n * USDC, 6n));
    for (const alias of [6n + (1n << 24n), 6n + (5n << 24n), P - 1n]) {
      const fake = { ...note, index: alias };
      const plan = planTx(h, tree, [fake, dummyInput()], [freshOutput(100n * USDC), freshOutput(0n)], 0n);
      plan.paths[0] = tree.path(6n);
      await expectFailure(plan, AT.indexRange, "Num2Bits");
    }
  });

  it("unbalanced: outputs exceed inputs + publicAmount", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1000n, 6n));
    await expectFailure(planTx(h, tree, [note, dummyInput()], [freshOutput(1001n), freshOutput(0n)], 0n), AT.balance);
    // withdrawing v = 10 but keeping 995 as change
    await expectFailure(planTx(h, tree, [note, dummyInput()], [freshOutput(995n), freshOutput(0n)], 10n), AT.balance);
  });

  it("unbalanced: outputs below inputs + publicAmount", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1000n, 6n));
    await expectFailure(planTx(h, tree, [note, dummyInput()], [freshOutput(999n), freshOutput(0n)], 0n), AT.balance);
    await expectFailure(planTx(h, tree, [note, dummyInput()], [freshOutput(980n), freshOutput(0n)], 10n), AT.balance);
  });

  it("wrapped amount: output p - x posing as -x", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1000n, 6n));
    // 1000 = (p - 1) + 1001 (mod p): would mint 1 unit if outputs were not range-checked
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(P - 1n), freshOutput(1001n)], 0n);
    await expectFailure(plan, AT.outRange, "Num2Bits");
  });

  it("wrapped amount: input p - x (stored in the tree) posing as -x", async () => {
    const tree = populatedTree();
    const neg = place(tree, newNote(P - 1n, 6n));
    const real = place(tree, newNote(1001n, 7n));
    const plan = planTx(h, tree, [neg, real], [freshOutput(1000n), freshOutput(0n)], 0n);
    await expectFailure(plan, AT.inRange, "Num2Bits");
  });

  it("wrong output commitment", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(1000n, 6n));
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(1000n), freshOutput(0n)], 0n);
    plan.outputCommitment[1] = randomField();
    await expectFailure(plan, AT.outCommit);
  });

  it("publicAmount is NOT range-checked in-circuit: the hub must derive it from ExtData (PRD 5.7)", async () => {
    // Documents the trust boundary: a 'positive' publicAmount balances in the circuit, so HubCore
    // MUST compute publicAmount = p - v (v < 2^248) itself and never accept it from the caller.
    const tree = populatedTree();
    const note = place(tree, newNote(1000n, 6n));
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(1005n), freshOutput(0n)], 0n);
    plan.publicAmount = 5n;
    await expectValid(plan);
  });
});

describe("r1cs-level checks (malicious prover, not just the witness generator)", () => {
  it("altering any single public signal in a valid witness breaks the r1cs", async () => {
    const tree = populatedTree();
    const note = place(tree, newNote(100n * USDC, 6n));
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(50n * USDC), freshOutput(49n * USDC)], USDC);
    const w = await calculateWitness(toCircuitInput(plan));
    expect(await witnessSatisfies(w)).toBe(true);
    const values = (await witnessValues(toCircuitInput(plan))) as bigint[];
    for (let i = 1; i <= 7; i++) {
      const patched = patchWitness(w, i, (values[i]! + 1n) % P);
      expect(await witnessSatisfies(patched), `public signal ${i}`).toBe(false);
    }
  });
});
