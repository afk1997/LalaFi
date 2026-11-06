// Witness helpers over the compiled circuit wasm (snarkjs / circom_runtime).
import fs from "node:fs";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { BUILD_DIR, ROOT_DIR, type CircuitInput } from "./xpool.js";

export const TX_WASM = path.join(BUILD_DIR, "transaction.wasm");
export const TX_R1CS = path.join(BUILD_DIR, "transaction.r1cs");
const TX_SOURCE = path.join(ROOT_DIR, "src", "transaction.circom");

export interface MemFile {
  type: "mem";
  data?: Uint8Array;
}

/** Runs the witness generator; throws the circom assert error on an unsatisfied constraint. */
export async function calculateWitness(input: CircuitInput, wasm = TX_WASM): Promise<MemFile> {
  const out: MemFile = { type: "mem" };
  const { log, error } = console;
  console.log = console.error = () => {}; // circom_runtime prints asserts before throwing
  try {
    await snarkjs.wtns.calculate(input, wasm, out);
  } finally {
    console.log = log;
    console.error = error;
  }
  return out;
}

/** Witness as field elements: [1, outputs..., public inputs..., private inputs..., internals...]. */
export async function witnessValues(input: CircuitInput, wasm = TX_WASM): Promise<bigint[]> {
  const w = await calculateWitness(input, wasm);
  return (await snarkjs.wtns.exportJson(w)) as bigint[];
}

/** The error message of a failing witness computation, or null if it succeeds. */
export async function witnessError(input: CircuitInput, wasm = TX_WASM): Promise<string | null> {
  try {
    await calculateWitness(input, wasm);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 1-based line of the unique line in transaction.circom containing `snippet`. */
export function txLine(snippet: string): number {
  const lines = fs.readFileSync(TX_SOURCE, "utf8").split("\n");
  const hits = lines.flatMap((l, i) => (l.includes(snippet) ? [i + 1] : []));
  if (hits.length !== 1) throw new Error(`snippet must occur exactly once in transaction.circom: ${snippet}`);
  return hits[0]!;
}

/**
 * Regex for the FIRST failing assertion: optionally inside sub-template `template`, reached from
 * the Transaction statement containing `snippet`.
 */
export function failureAt(snippet: string, template?: string): RegExp {
  const line = txLine(snippet);
  const inner = template ? `Error in template ${template}_\\d+ line: \\d+\\n` : "";
  return new RegExp(`Assert Failed\\. ${inner}Error in template Transaction_\\d+ line: ${line}\\n`);
}

/** Overwrites witness wire `index` (in a copy of a wtns mem file) with `value`. */
export function patchWitness(w: MemFile, index: number, value: bigint): MemFile {
  // wtns v2: magic(4) version(4) nSections(4) | section 1 header: id(4) len(8) n8(4) q(n8) nWit(4)
  // | section 2 header: id(4) len(8) | wires (n8 bytes LE each)
  const data = new Uint8Array(w.data!);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n8 = view.getUint32(12 + 12, true);
  const sec2 = 12 + 12 + 4 + n8 + 4;
  if (view.getUint32(sec2, true) !== 2) throw new Error("unexpected wtns layout");
  const base = sec2 + 12 + index * n8;
  let v = value;
  for (let i = 0; i < n8; i++) {
    data[base + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return { type: "mem", data };
}

/** r1cs satisfiability of a (possibly patched) witness. */
export async function witnessSatisfies(w: MemFile, r1cs = TX_R1CS): Promise<boolean> {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  return (await snarkjs.wtns.check(r1cs, w, quiet)) as boolean;
}
