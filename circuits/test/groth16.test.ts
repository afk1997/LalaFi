// Full groth16 round trip with the COMMITTED artifacts (circuits/artifacts/), plus checks that
// the committed wasm/zkey/vkey/verifier are mutually consistent and match the current source.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Hasher,
  ARTIFACTS_DIR,
  BUILD_DIR,
  P,
  SparseMerkleTree,
  VERIFIER_HEADER,
  VERIFIER_SOL,
  deriveNote,
  dummyInput,
  freshOutput,
  getHasher,
  planTx,
  publicSignalsOf,
  randomField,
  toCircuitInput,
  verifierTemplates,
} from "../lib/xpool.js";

const WASM = path.join(ARTIFACTS_DIR, "transaction.wasm");
const ZKEY = path.join(ARTIFACTS_DIR, "transaction_final.zkey");
const VKEY = path.join(ARTIFACTS_DIR, "verification_key.json");
const sha256 = (f: string): string => "sha256:" + createHash("sha256").update(fs.readFileSync(f)).digest("hex");

let h: Hasher;
let vkey: unknown;

beforeAll(async () => {
  h = await getHasher();
  vkey = JSON.parse(fs.readFileSync(VKEY, "utf8"));
});

afterAll(async () => {
  // ffjavascript keeps worker threads alive for the curve
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

describe("groth16 prove + verify (committed zkey)", () => {
  it("partial withdrawal proof verifies; any tampered public signal (incl. extDataHash) is rejected", async () => {
    const tree = new SparseMerkleTree(h);
    for (const i of [0n, 1n, 2n, 3n]) tree.insert(i, randomField());
    const note = { amount: 1000_000_000n, sk: randomField(), blinding: randomField(), index: 4n };
    tree.insert(note.index, deriveNote(h, note).commitment);
    const v = 100_500_000n;
    const plan = planTx(h, tree, [note, dummyInput()], [freshOutput(1000_000_000n - v), freshOutput(0n)], v);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(toCircuitInput(plan), WASM, ZKEY);
    expect(publicSignals).toEqual(publicSignalsOf(plan));
    expect(publicSignals).toHaveLength(7);
    expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);

    const names = ["root", "publicAmount", "extDataHash", "inputNullifier[0]", "inputNullifier[1]", "outputCommitment[0]", "outputCommitment[1]"];
    for (let i = 0; i < 7; i++) {
      const tampered = [...publicSignals];
      tampered[i] = ((BigInt(tampered[i]!) + 1n) % P).toString();
      expect(await snarkjs.groth16.verify(vkey, tampered, proof), `tampered ${names[i]}`).toBe(false);
    }
    // a fresh extDataHash (different recipient/fees) is rejected too
    const otherExt = [...publicSignals];
    otherExt[2] = randomField().toString();
    expect(await snarkjs.groth16.verify(vkey, otherExt, proof)).toBe(false);

    // tampered proof
    const bad = structuredClone(proof);
    bad.pi_a[0] = ((BigInt(bad.pi_a[0]) + 1n) % P).toString();
    expect(await snarkjs.groth16.verify(vkey, publicSignals, bad)).toBe(false);

    // Solidity calldata shape (uint256[2], uint256[2][2], uint256[2], uint256[7])
    const calldata: string = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [a, b, c, pub] = JSON.parse(`[${calldata}]`);
    expect([a.length, b.length, b[0].length, c.length, pub.length]).toEqual([2, 2, 2, 2, 7]);
  });
});

describe("committed artifacts", () => {
  it("hashes.json matches the committed files", () => {
    const hashes = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "hashes.json"), "utf8"));
    expect(hashes.wasm).toBe(sha256(WASM));
    expect(hashes.zkey).toBe(sha256(ZKEY));
    expect(hashes.vkey).toBe(sha256(VKEY));
    expect(hashes.verifierSol).toBe(sha256(VERIFIER_SOL));
  });

  it("committed wasm and zkey correspond to the current circuit source (fresh compile)", () => {
    const hashes = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "hashes.json"), "utf8"));
    expect(sha256(path.join(BUILD_DIR, "transaction.wasm"))).toBe(hashes.wasm);
    expect(sha256(path.join(BUILD_DIR, "transaction.r1cs"))).toBe(hashes.r1cs);
  });

  it("verification_key.json is exported from the committed zkey", async () => {
    expect(await snarkjs.zKey.exportVerificationKey(ZKEY)).toEqual(vkey);
  });

  it("Groth16Verifier.sol is exactly the snarkjs export of the committed zkey (plus header)", async () => {
    const generated: string = await snarkjs.zKey.exportSolidityVerifier(ZKEY, verifierTemplates());
    const committed = fs.readFileSync(VERIFIER_SOL, "utf8");
    expect(committed.startsWith(VERIFIER_HEADER)).toBe(true);
    expect(committed.slice(VERIFIER_HEADER.length)).toBe(generated);
    expect(committed).toContain("contract Groth16Verifier");
    expect(committed).toContain("NOT FOR MAINNET");
  });
});
