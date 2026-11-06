// Generates the cross-implementation fixtures (PRD 5.2, 15.1) with circomlibjs Poseidon:
//   fixtures/circuit-poseidon-vectors.json  H1/H2/H3: 1000 random inputs each + edge cases
//   fixtures/circuit-note-vectors.json      sk -> pk, P, C, sigma, N
//   fixtures/circuit-zero-hashes.json       Z0..Z24
// Random values come from the OS CSPRNG. `pnpm test` re-checks every vector against circomlibjs
// and a subset against the compiled circom circuits.
import fs from "node:fs";
import path from "node:path";
import {
  type Hasher,
  LEVELS,
  MAX_AMOUNT,
  MAX_LEAF_INDEX,
  P,
  REPO_DIR,
  TOKEN,
  deriveNote,
  getHasher,
  nullifierOf,
  randomBits,
  randomField,
  zeroHashes,
} from "../lib/xpool.js";

const FIXTURES = path.join(REPO_DIR, "fixtures");
const RANDOM_PER_ARITY = 1000;
const EDGES = [0n, 1n, P - 1n, MAX_AMOUNT];

const str = (x: bigint): string => x.toString();

function cartesian(n: number): bigint[][] {
  if (n === 0) return [[]];
  return cartesian(n - 1).flatMap((rest) => EDGES.map((e) => [e, ...rest]));
}

function poseidonVectors(h: Hasher) {
  const out: Record<string, { inputs: string[]; output: string; kind: "edge" | "random" }[]> = {};
  for (const n of [1, 2, 3]) {
    const rows: { inputs: string[]; output: string; kind: "edge" | "random" }[] = [];
    for (const inputs of cartesian(n)) rows.push({ inputs: inputs.map(str), output: str(h.hash(inputs)), kind: "edge" });
    for (let i = 0; i < RANDOM_PER_ARITY; i++) {
      const inputs = Array.from({ length: n }, () => randomField());
      rows.push({ inputs: inputs.map(str), output: str(h.hash(inputs)), kind: "random" });
    }
    out[`H${n}`] = rows;
  }
  return {
    description:
      "xpool v1 Poseidon vectors (circomlib Poseidon(n), PRD 5.2). H_n(inputs) = output. Decimal field elements, BN254 scalar field.",
    generator: "circuits/scripts/fixtures.ts (circomlibjs buildPoseidon)",
    field: str(P),
    edgeValues: EDGES.map(str),
    ...out,
  };
}

function noteVectors(h: Hasher) {
  const cases: { sk: bigint; amount: bigint; blinding: bigint; leafIndex: bigint; label: string }[] = [
    { label: "sk=1, a=0, i=0", sk: 1n, amount: 0n, blinding: 0n, leafIndex: 0n },
    { label: "sk=p-1, a=max, i=max", sk: P - 1n, amount: MAX_AMOUNT, blinding: P - 1n, leafIndex: MAX_LEAF_INDEX },
    { label: "1 USDC at leaf 0", sk: randomField(), amount: 1_000_000n, blinding: randomField(), leafIndex: 0n },
    { label: "1000 USDC at leaf 1", sk: randomField(), amount: 1_000_000_000n, blinding: randomField(), leafIndex: 1n },
    { label: "a = 2^248 - 1", sk: randomField(), amount: MAX_AMOUNT, blinding: randomField(), leafIndex: 123_456n },
    { label: "deepest leaf", sk: randomField(), amount: 42n, blinding: randomField(), leafIndex: MAX_LEAF_INDEX },
    { label: "dummy (a = 0)", sk: randomField(), amount: 0n, blinding: randomField(), leafIndex: 0n },
  ];
  while (cases.length < 20) {
    cases.push({
      label: "random",
      sk: randomField(),
      amount: randomBits(64),
      blinding: randomField(),
      leafIndex: randomBits(LEVELS),
    });
  }
  return {
    description:
      "xpool v1 note vectors (PRD 5.3-5.5): pk = H1(sk), P = H2(pk, b), C = H3(a, t, P), sigma = H3(sk, C, i), N = H3(C, i, sigma), t = 1.",
    generator: "circuits/scripts/fixtures.ts (circomlibjs buildPoseidon)",
    cases: cases.map((c) => {
      const d = deriveNote(h, c);
      const { sigma, nullifier } = nullifierOf(h, c.sk, d.commitment, c.leafIndex);
      return {
        label: c.label,
        sk: str(c.sk),
        amount: str(c.amount),
        token: str(TOKEN),
        blinding: str(c.blinding),
        leafIndex: str(c.leafIndex),
        pk: str(d.pk),
        ownerDigest: str(d.ownerDigest),
        commitment: str(d.commitment),
        sigma: str(sigma),
        nullifier: str(nullifier),
      };
    }),
  };
}

function zeroHashFixture(h: Hasher) {
  return {
    description: 'xpool v1 zero subtrees (PRD 5.6): Z[0] = keccak256("xpool.v1.zero") mod p, Z[l+1] = H2(Z[l], Z[l]); Z[24] = empty root.',
    generator: "circuits/scripts/fixtures.ts",
    seed: "xpool.v1.zero",
    levels: LEVELS,
    zeros: zeroHashes(h).map(str),
  };
}

const h = await getHasher();
fs.mkdirSync(FIXTURES, { recursive: true });
const write = (name: string, data: unknown): void => {
  fs.writeFileSync(path.join(FIXTURES, name), JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote fixtures/${name}`);
};
write("circuit-poseidon-vectors.json", poseidonVectors(h));
write("circuit-note-vectors.json", noteVectors(h));
write("circuit-zero-hashes.json", zeroHashFixture(h));
process.exit(0);
