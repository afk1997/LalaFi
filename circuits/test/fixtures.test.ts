// Cross-implementation consistency (PRD 5.2, 15.1): committed fixtures vs circomlibjs and vs the
// compiled circom circuits (Poseidon(1/2/3) test circuits and the real Transaction circuit).
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Hasher,
  BUILD_DIR,
  MAX_AMOUNT,
  P,
  REPO_DIR,
  SparseMerkleTree,
  dummyInput,
  freshOutput,
  getHasher,
  planTx,
  toCircuitInput,
  zeroHashes,
  zeroLeaf,
} from "../lib/xpool.js";
import { failureAt, witnessError, witnessValues } from "../lib/witness.js";

const read = (name: string) => JSON.parse(fs.readFileSync(path.join(REPO_DIR, "fixtures", name), "utf8"));
const poseidon = read("circuit-poseidon-vectors.json");
const notes = read("circuit-note-vectors.json");
const zeros = read("circuit-zero-hashes.json");

let h: Hasher;
beforeAll(async () => {
  h = await getHasher();
});

describe("circuit-poseidon-vectors.json", () => {
  for (const n of [1, 2, 3]) {
    const rows: { inputs: string[]; output: string; kind: string }[] = poseidon[`H${n}`];

    it(`H${n}: >= 1000 random vectors plus every edge-case combination`, () => {
      expect(rows.filter((r) => r.kind === "random").length).toBeGreaterThanOrEqual(1000);
      expect(rows.filter((r) => r.kind === "edge").length).toBe(4 ** n);
      const edges = new Set(rows.flatMap((r) => r.inputs));
      for (const e of ["0", "1", (P - 1n).toString(), MAX_AMOUNT.toString()]) expect(edges.has(e)).toBe(true);
      for (const r of rows) for (const x of [...r.inputs, r.output]) expect(BigInt(x) < P).toBe(true);
    });

    it(`H${n}: all vectors match circomlibjs`, () => {
      for (const r of rows) expect(h.hash(r.inputs.map(BigInt)).toString()).toBe(r.output);
    });

    it(`H${n}: edge cases + 100 random vectors match the circom Poseidon(${n}) circuit`, async () => {
      const wasm = path.join(BUILD_DIR, "test", `poseidon${n}.wasm`);
      const subset = [...rows.filter((r) => r.kind === "edge"), ...rows.filter((r) => r.kind === "random").slice(0, 100)];
      for (const r of subset) {
        const w = await witnessValues({ in: r.inputs }, wasm);
        expect(w[1]!.toString()).toBe(r.output); // wire 1 = the output signal
      }
    });
  }
});

describe("circuit-note-vectors.json", () => {
  const cases: Record<string, string>[] = notes.cases;

  it("has ~20 cases matching circomlibjs", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases) {
      const [sk, a, b, i] = [c.sk!, c.amount!, c.blinding!, c.leafIndex!].map(BigInt) as [bigint, bigint, bigint, bigint];
      const pk = h.H1(sk);
      const owner = h.H2(pk, b);
      const cm = h.H3(a, BigInt(c.token!), owner);
      const sigma = h.H3(sk, cm, i);
      expect([pk, owner, cm, sigma, h.H3(cm, i, sigma)].map(String)).toEqual([c.pk, c.ownerDigest, c.commitment, c.sigma, c.nullifier]);
    }
  });

  it("the Transaction circuit computes the same C (as input and as output) and N", async () => {
    for (const c of cases) {
      const note = { sk: BigInt(c.sk!), amount: BigInt(c.amount!), blinding: BigInt(c.blinding!), index: BigInt(c.leafIndex!) };
      const tree = new SparseMerkleTree(h);
      tree.insert(note.index, BigInt(c.commitment!));
      const out0 = { amount: note.amount, pk: BigInt(c.pk!), blinding: note.blinding };
      const plan = planTx(h, tree, [note, dummyInput()], [out0, freshOutput(0n)], 0n);
      plan.inputNullifier[0] = BigInt(c.nullifier!);
      plan.outputCommitment[0] = BigInt(c.commitment!);
      expect(await witnessError(toCircuitInput(plan)), c.label).toBeNull();

      plan.inputNullifier[0] = (BigInt(c.nullifier!) + 1n) % P;
      expect(await witnessError(toCircuitInput(plan))).toMatch(failureAt("inNullifier[j].out === inputNullifier[j];"));
    }
  });
});

describe("circuit-zero-hashes.json", () => {
  it("Z0 = keccak256('xpool.v1.zero') mod p and Z[l+1] = H2(Z[l], Z[l])", () => {
    expect(zeros.zeros.length).toBe(25);
    expect(zeros.zeros[0]).toBe(zeroLeaf().toString());
    expect(zeros.zeros[0]).toBe("21044366272227605824133009181634951323819071331824074968371439073906620472241");
    expect(zeroHashes(h).map(String)).toEqual(zeros.zeros);
    expect(new SparseMerkleTree(h).root.toString()).toBe(zeros.zeros[24]);
  });
});
