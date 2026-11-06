/**
 * Groth16 proving via snarkjs (WASM) with an optional rapidsnark binary.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifyArtifacts, type ArtifactPaths } from './artifacts.js';
import { loadSnarkjs } from './snarkjs.js';
import { publicSignals, type PublicInputs, type SnarkjsProof, type SolidityProof, type WitnessInput } from './types.js';
import type { ArtifactPins } from '../chains/config.js';

/** BN254 base field modulus (proof coordinates live here). */
export const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export class ProverError extends Error {
  override name = 'ProverError';
}

function coord(s: string | undefined, what: string): bigint {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new ProverError(`bad proof coordinate ${what}`);
  const v = BigInt(s);
  if (v >= BN254_Q) throw new ProverError(`proof coordinate ${what} not in base field`);
  return v;
}

/**
 * snarkjs proof -> Types.sol Proof. G2 coordinates are swapped exactly like
 * `snarkjs zkey export soliditycalldata`: b = [[b01, b00], [b11, b10]].
 */
export function toSolidityProof(p: SnarkjsProof): SolidityProof {
  const a = p.pi_a;
  const b = p.pi_b;
  const c = p.pi_c;
  if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(c) || b.length < 2) throw new ProverError('malformed proof');
  return {
    a: [coord(a[0], 'a0'), coord(a[1], 'a1')],
    b: [
      [coord(b[0]?.[1], 'b01'), coord(b[0]?.[0], 'b00')],
      [coord(b[1]?.[1], 'b11'), coord(b[1]?.[0], 'b10')],
    ],
    c: [coord(c[0], 'c0'), coord(c[1], 'c1')],
  };
}

export interface ProveOptions {
  paths: ArtifactPaths;
  pins: ArtifactPins;
  /** Optional rapidsnark `prover` binary path. */
  rapidsnark?: string;
  /** Verify the proof against the vkey before returning (default true). */
  selfVerify?: boolean;
}

export interface ProveResult {
  proof: SolidityProof;
  raw: SnarkjsProof;
  publicSignals: string[];
}

function checkSignals(got: string[], pi: PublicInputs): void {
  const want = publicSignals(pi).map((x) => x.toString(10));
  if (got.length !== 7 || got.some((s, i) => s !== want[i])) {
    throw new ProverError('circuit public signals do not match the prepared public inputs');
  }
}

const execFileP = promisify(execFile);

async function proveRapidsnark(bin: string, input: WitnessInput, paths: ArtifactPaths): Promise<{ proof: SnarkjsProof; publicSignals: string[] }> {
  const snarkjs = await loadSnarkjs();
  const dir = mkdtempSync(join(tmpdir(), 'xpool-prove-'));
  try {
    const wtns = join(dir, 'witness.wtns');
    await snarkjs.wtns.calculate(input as unknown as Record<string, unknown>, paths.wasm, wtns);
    const proofPath = join(dir, 'proof.json');
    const pubPath = join(dir, 'public.json');
    await execFileP(bin, [paths.zkey, wtns, proofPath, pubPath], { timeout: 120_000 });
    return {
      proof: JSON.parse(readFileSync(proofPath, 'utf8')) as SnarkjsProof,
      publicSignals: JSON.parse(readFileSync(pubPath, 'utf8')) as string[],
    };
  } finally {
    // The witness contains secrets (sk, blindings): always remove it.
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Verify artifacts against pins, prove, check public signals, optionally self-verify. */
export async function prove(input: WitnessInput, expected: PublicInputs, opts: ProveOptions): Promise<ProveResult> {
  await verifyArtifacts(opts.paths, opts.pins);
  const snarkjs = await loadSnarkjs();
  const out = opts.rapidsnark
    ? await proveRapidsnark(opts.rapidsnark, input, opts.paths)
    : await snarkjs.groth16.fullProve(input as unknown as Record<string, unknown>, opts.paths.wasm, opts.paths.zkey);
  checkSignals(out.publicSignals, expected);
  if (opts.selfVerify !== false) {
    const vkey = JSON.parse(readFileSync(opts.paths.vkey, 'utf8')) as unknown;
    const ok = await snarkjs.groth16.verify(vkey, out.publicSignals, out.proof);
    if (!ok) throw new ProverError('generated proof does not verify');
  }
  return { proof: toSolidityProof(out.proof), raw: out.proof, publicSignals: out.publicSignals };
}

/** Release snarkjs/ffjavascript worker threads so the process can exit. */
export async function terminateProver(): Promise<void> {
  const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } };
  await g.curve_bn128?.terminate?.();
}
