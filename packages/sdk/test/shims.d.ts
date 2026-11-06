declare module 'circomlibjs' {
  export interface CircomPoseidon {
    (inputs: (bigint | number | string)[]): Uint8Array;
    F: { toObject(x: Uint8Array): bigint };
  }
  export function buildPoseidon(): Promise<CircomPoseidon>;
}
