// xpool v1 TEST trusted setup (local + testnet only). NOT FOR MAINNET (PRD 6.7, 16.2).
//
//   phase 1: public Powers of Tau (2^16), hash-checked
//   phase 2: groth16 setup -> one contribution (OS CSPRNG entropy) -> random beacon
//   outputs: build/transaction_final.zkey, build/verification_key.json,
//            contracts/src/verifier/Groth16Verifier.sol (generated, never hand-edited),
//            artifacts/{transaction.wasm, transaction_final.zkey, verification_key.json,
//                       hashes.json, setup-transcript.json}
//
// Run via `pnpm --filter @xpool/circuits setup` (compiles first).
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { ARTIFACTS_DIR, BUILD_DIR, ROOT_DIR, VERIFIER_HEADER, VERIFIER_SOL, verifierTemplates } from "../lib/xpool.js";

const PTAU_DIR = path.join(ROOT_DIR, "ptau");
const R1CS = path.join(BUILD_DIR, "transaction.r1cs");
const WASM = path.join(BUILD_DIR, "transaction.wasm");
const ZKEY0 = path.join(BUILD_DIR, "transaction_0000.zkey");
const ZKEY1 = path.join(BUILD_DIR, "transaction_0001.zkey");
const ZKEY_FINAL = path.join(BUILD_DIR, "transaction_final.zkey");
const VKEY = path.join(BUILD_DIR, "verification_key.json");

// Preferred phase-1 file (PRD 6.7): Hermez powersOfTau28_hez_final_16, hash from the snarkjs README.
const HERMEZ = {
  name: "powersOfTau28_hez_final_16.ptau",
  url: "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau",
};
// Fallback when the Hermez bucket is unreachable (it returns 403 AccessDenied as of 2026-11-06):
// PSE Perpetual Powers of Tau, contribution 0080 + public beacon (randao, slot 7,325,000),
// truncated to 2^16. PSE publishes no per-file hash for the prepared files, so the blake2b-512
// below was pinned at first download AND the file is fully re-verified with
// `snarkjs powersoftau verify` before use.
const PPOT = {
  name: "ppot_0080_16.ptau",
  url: "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_16.ptau",
  blake2b:
    "9532c6c04a21335577713724b6d46c266a93aa621b78882b8b64b26f3080a8f0d974aded00c4d781adbdf493a45c51db455108f7aeedb49971569d57a56971c3",
};

const logger = {
  debug: () => {},
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

function fileHash(algo: "sha256" | "blake2b512", file: string): string {
  const h = createHash(algo);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest("hex");
}

function hermezReadmeHash(): string {
  const readme = fs.readFileSync(path.join(ROOT_DIR, "node_modules", "snarkjs", "README.md"), "utf8");
  const row = readme.split("\n").find((l) => l.includes(`[${HERMEZ.name}]`));
  const hash = row?.match(/\|\s*([0-9a-f]{128})\s*\|/)?.[1];
  if (!hash) throw new Error(`no hash for ${HERMEZ.name} in snarkjs README`);
  return hash;
}

async function download(url: string, dest: string): Promise<boolean> {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.warn(`  -> HTTP ${res.status}`);
    return false;
  }
  const tmp = dest + ".part";
  const out = fs.createWriteStream(tmp);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) out.write(chunk);
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, dest);
  return true;
}

interface Ptau {
  file: string;
  name: string;
  blake2b: string;
  source: string;
  pinnedBy: string;
}

async function obtainPtau(): Promise<Ptau> {
  fs.mkdirSync(PTAU_DIR, { recursive: true });
  const want = process.env.XPOOL_PTAU; // "hermez" | "ppot" | undefined (= try hermez, then ppot)

  if (want !== "ppot") {
    const file = path.join(PTAU_DIR, HERMEZ.name);
    if (fs.existsSync(file) || (await download(HERMEZ.url, file))) {
      const expected = hermezReadmeHash();
      const got = fileHash("blake2b512", file);
      if (got !== expected) throw new Error(`${HERMEZ.name}: blake2b mismatch\n  got      ${got}\n  expected ${expected}`);
      console.log(`${HERMEZ.name}: blake2b-512 matches snarkjs README`);
      return { file, name: HERMEZ.name, blake2b: got, source: HERMEZ.url, pinnedBy: "snarkjs README.md table" };
    }
    if (want === "hermez") throw new Error("Hermez ptau unavailable");
    console.warn(`Hermez ptau unavailable; falling back to ${PPOT.name}`);
  }

  const file = path.join(PTAU_DIR, PPOT.name);
  if (!fs.existsSync(file) && !(await download(PPOT.url, file))) throw new Error("PPoT ptau unavailable");
  const got = fileHash("blake2b512", file);
  if (got !== PPOT.blake2b) throw new Error(`${PPOT.name}: blake2b mismatch\n  got      ${got}\n  expected ${PPOT.blake2b}`);
  console.log(`${PPOT.name}: blake2b-512 matches pinned value`);
  // `powersoftau verify` takes ~10+ min; its success is cached per file hash in ptau/ (gitignored).
  const marker = file + ".verified";
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === got) {
    console.log(`${PPOT.name}: powersoftau verify already passed for this hash`);
  } else {
    console.log(`${PPOT.name}: running full powersoftau verify ...`);
    if (!(await snarkjs.powersOfTau.verify(file, logger))) throw new Error(`${PPOT.name}: powersoftau verify FAILED`);
    fs.writeFileSync(marker, got + "\n");
  }
  return { file, name: PPOT.name, blake2b: got, source: PPOT.url, pinnedBy: "pinned blake2b + snarkjs powersoftau verify" };
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

async function main(): Promise<void> {
  for (const f of [R1CS, WASM]) if (!fs.existsSync(f)) throw new Error(`missing ${f}; run the compile step first`);

  const ptau = await obtainPtau();

  console.log("groth16 setup ...");
  const csHash = await snarkjs.zKey.newZKey(R1CS, ptau.file, ZKEY0, logger);
  if (csHash === -1) throw new Error("groth16 setup failed");

  // Entropy from the OS CSPRNG; snarkjs mixes in another 64 CSPRNG bytes (misc.getRandomRng).
  const entropy = randomBytes(64).toString("hex");
  const contribution = await snarkjs.zKey.contribute(
    ZKEY0,
    ZKEY1,
    "xpool team contribution #1 (NOT FOR MAINNET)",
    entropy,
    logger,
  );

  const beaconHash = randomBytes(32).toString("hex");
  const beaconIterationsExp = 10;
  const beacon = await snarkjs.zKey.beacon(
    ZKEY1,
    ZKEY_FINAL,
    "xpool final beacon (NOT FOR MAINNET)",
    beaconHash,
    beaconIterationsExp,
    logger,
  );
  if (!beacon) throw new Error("beacon failed");

  console.log("verifying final zkey against r1cs + ptau ...");
  if (!(await snarkjs.zKey.verifyFromR1cs(R1CS, ptau.file, ZKEY_FINAL, logger))) throw new Error("zkey verify FAILED");

  const vkey = await snarkjs.zKey.exportVerificationKey(ZKEY_FINAL, logger);
  fs.writeFileSync(VKEY, JSON.stringify(vkey, null, 1) + "\n");

  const solidity: string = await snarkjs.zKey.exportSolidityVerifier(ZKEY_FINAL, verifierTemplates(), logger);
  if (!solidity.includes("contract Groth16Verifier")) throw new Error("unexpected verifier contract name");
  fs.mkdirSync(path.dirname(VERIFIER_SOL), { recursive: true });
  fs.writeFileSync(VERIFIER_SOL, VERIFIER_HEADER + solidity);

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const copies: [string, string][] = [
    [WASM, "transaction.wasm"],
    [ZKEY_FINAL, "transaction_final.zkey"],
    [VKEY, "verification_key.json"],
  ];
  for (const [src, name] of copies) fs.copyFileSync(src, path.join(ARTIFACTS_DIR, name));

  const sha = (f: string): string => "sha256:" + fileHash("sha256", f);
  const hashes = {
    _note: "NOT FOR MAINNET. Test trusted setup for local/testnet. Copy wasm/zkey/vkey into config/<env>.json -> artifacts.",
    wasm: sha(path.join(ARTIFACTS_DIR, "transaction.wasm")),
    zkey: sha(path.join(ARTIFACTS_DIR, "transaction_final.zkey")),
    vkey: sha(path.join(ARTIFACTS_DIR, "verification_key.json")),
    r1cs: sha(R1CS),
    verifierSol: sha(VERIFIER_SOL),
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "hashes.json"), JSON.stringify(hashes, null, 2) + "\n");

  const transcript = {
    _warning: "NOT FOR MAINNET. Single team contribution + CSPRNG beacon; mainnet requires the MPC ceremony of PRD 6.7.",
    circuit: "Transaction(24, 2, 2, 1)",
    circom: process.env.XPOOL_CIRCOM_VERSION ?? "see build log",
    snarkjs: JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "node_modules", "snarkjs", "package.json"), "utf8")).version,
    ptau: { name: ptau.name, source: ptau.source, blake2b512: ptau.blake2b, pinnedBy: ptau.pinnedBy },
    circuitHash: hex(csHash as Uint8Array),
    contributions: [{ name: "xpool team contribution #1 (NOT FOR MAINNET)", hash: hex(contribution as Uint8Array) }],
    beacon: { hash: beaconHash, iterationsExp: beaconIterationsExp, contributionHash: hex(beacon as Uint8Array), source: "OS CSPRNG (test setup)" },
    hashes,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "setup-transcript.json"), JSON.stringify(transcript, null, 2) + "\n");

  for (const f of [ZKEY0, ZKEY1]) fs.rmSync(f, { force: true });
  console.log(JSON.stringify(hashes, null, 2));
  console.log("setup done (NOT FOR MAINNET)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
