/// <reference lib="webworker" />
/**
 * Groth16 proving off the main thread. Artifacts are fetched once, checked against the sha256 pins
 * from config (same pins the CLI uses), and kept in memory for later proofs.
 */
import * as snarkjs from 'snarkjs';

interface ProveRequest {
  id: number;
  witness: Record<string, unknown>;
  wasmUrl: string;
  zkeyUrl: string;
  pins: { wasm?: string; zkey?: string };
}

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

async function sha256Hex(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function artifact(url: string, pin: string | undefined, what: string): Promise<Uint8Array<ArrayBuffer>> {
  const hit = cache.get(url);
  if (hit) return hit;
  if (!pin) throw new Error(`no pinned hash for the circuit ${what}; refusing to prove`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load the circuit ${what} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256Hex(bytes)) !== pin.toLowerCase()) throw new Error(`the circuit ${what} does not match its pinned hash`);
  cache.set(url, bytes);
  return bytes;
}

self.onmessage = async (e: MessageEvent<ProveRequest>) => {
  const { id, witness, wasmUrl, zkeyUrl, pins } = e.data;
  try {
    const [wasm, zkey] = await Promise.all([artifact(wasmUrl, pins.wasm, 'program'), artifact(zkeyUrl, pins.zkey, 'proving key')]);
    const out = await snarkjs.groth16.fullProve(witness, { type: 'mem', data: wasm }, { type: 'mem', data: zkey });
    self.postMessage({ id, ok: true, proof: out.proof, publicSignals: out.publicSignals });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err as Error).message ?? String(err) });
  }
};
