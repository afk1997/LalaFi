/**
 * PRD 5.2 [P0]: circuit, SDK and Solidity Poseidon outputs must be identical.
 * Checks the SDK against vectors computed by the circuit workstream (circomlibjs + circom witnesses),
 * and the SDK zero hashes against the circuit's. Solidity is checked in contracts/test/integration.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { H1, H2, H3 } from '../src/crypto/poseidon.js';
import { zeroHashes } from '../src/tree/index.js';

const root = join(__dirname, '..', '..', '..');
const load = (f: string) => JSON.parse(readFileSync(join(root, 'fixtures', f), 'utf8'));

type Vec = { inputs: string[]; output: string };

describe('cross-implementation vectors (circuit fixtures)', () => {
  const v = load('circuit-poseidon-vectors.json') as Record<'H1' | 'H2' | 'H3', Vec[]>;

  it('H1 matches circuit vectors', () => {
    for (const { inputs, output } of v.H1) expect(H1(BigInt(inputs[0]!))).toBe(BigInt(output));
  });
  it('H2 matches circuit vectors', () => {
    for (const { inputs, output } of v.H2) expect(H2(BigInt(inputs[0]!), BigInt(inputs[1]!))).toBe(BigInt(output));
  });
  it('H3 matches circuit vectors', () => {
    for (const { inputs, output } of v.H3)
      expect(H3(BigInt(inputs[0]!), BigInt(inputs[1]!), BigInt(inputs[2]!))).toBe(BigInt(output));
  });
  it('zero hashes match circuit', () => {
    const z = (load('circuit-zero-hashes.json') as { zeros: string[] }).zeros.map(BigInt);
    expect(zeroHashes().map((x: bigint) => x)).toEqual(z);
  });

  it('fixtures/poseidon-columns.json is an exact flattening of the circuit vectors', () => {
    const cols = load('poseidon-columns.json') as Record<string, Record<string, string[]>>;
    for (const h of ['H1', 'H2', 'H3'] as const) {
      expect(cols[h]!.output).toEqual(v[h].map((e) => e.output));
      v[h][0]!.inputs.forEach((_, i) => expect(cols[h]![`in${i}`]).toEqual(v[h].map((e) => e.inputs[i])));
    }
  });
});
