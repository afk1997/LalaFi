declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | { type: 'mem'; data: Uint8Array },
      zkey: string | { type: 'mem'; data: Uint8Array },
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
  };
}
