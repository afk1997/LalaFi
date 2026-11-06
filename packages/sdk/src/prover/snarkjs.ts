/**
 * Typed view of the parts of snarkjs we use (snarkjs ships no types).
 */
import type { SnarkjsProof } from './types.js';

export interface SnarkjsModule {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{ proof: SnarkjsProof; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: SnarkjsProof): Promise<boolean>;
  };
  wtns: {
    calculate(input: Record<string, unknown>, wasmFile: string, wtnsFile: string): Promise<void>;
  };
}

const MODULE = 'snarkjs';

/** Lazy-load snarkjs (heavy; only needed when proving). */
export async function loadSnarkjs(): Promise<SnarkjsModule> {
  return (await import(MODULE)) as SnarkjsModule;
}
