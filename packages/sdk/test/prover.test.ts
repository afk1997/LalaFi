import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zeroAddress } from 'viem';
import {
  toSolidityProof, BN254_Q, ProverError, verifyArtifacts, ArtifactError, sha256File, readHashesFile,
  defaultArtifactPaths, artifactsPresent, prove, terminateProver, publicSignals,
} from '../src/prover/index.js';
import { MerkleTree } from '../src/tree/merkle.js';
import { buildFeeOnly } from '../src/tx/builder.js';
import { TEST_KEYS, ownedNoteInTree } from './helpers.js';

const CIRCUITS = resolve(__dirname, '../../../circuits');

describe('Solidity proof conversion', () => {
  it('swaps G2 coordinates like snarkjs soliditycalldata', () => {
    const p = toSolidityProof({
      pi_a: ['1', '2', '1'],
      pi_b: [['3', '4'], ['5', '6'], ['1', '0']],
      pi_c: ['7', '8', '1'],
    });
    expect(p).toEqual({ a: [1n, 2n], b: [[4n, 3n], [6n, 5n]], c: [7n, 8n] });
  });
  it('rejects malformed or out-of-field coordinates', () => {
    expect(() => toSolidityProof({ pi_a: ['x', '2'], pi_b: [['3', '4'], ['5', '6']], pi_c: ['7', '8'] })).toThrow(ProverError);
    expect(() => toSolidityProof({ pi_a: [BN254_Q.toString(), '2'], pi_b: [['3', '4'], ['5', '6']], pi_c: ['7', '8'] })).toThrow(/base field/);
    expect(() => toSolidityProof({ pi_a: ['1', '2'], pi_b: [['3', '4']], pi_c: ['7', '8'] })).toThrow(ProverError);
  });
  it('public signals are in snarkjs order', () => {
    expect(publicSignals({ root: 1n, publicAmount: 2n, extDataHash: 3n, inputNullifiers: [4n, 5n], outputCommitments: [6n, 7n] })).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  });
});

describe('artifact pinning', () => {
  it('refuses unpinned or mismatching artifacts', async () => {
    const d = mkdtempSync(join(tmpdir(), 'xpool-art-'));
    const paths = { wasm: join(d, 'a.wasm'), zkey: join(d, 'a.zkey'), vkey: join(d, 'vk.json') };
    for (const p of Object.values(paths)) writeFileSync(p, p);
    await expect(verifyArtifacts(paths, {})).rejects.toThrow(ArtifactError);
    const pins = { wasm: await sha256File(paths.wasm), zkey: await sha256File(paths.zkey), vkey: await sha256File(paths.vkey) };
    await expect(verifyArtifacts(paths, pins)).resolves.toBeUndefined();
    await expect(verifyArtifacts(paths, { ...pins, zkey: '00'.repeat(32) })).rejects.toThrow(/mismatch/);
    writeFileSync(join(d, 'hashes.json'), JSON.stringify({ 'transaction.wasm': `sha256:${pins.wasm}`, zkey: pins.zkey, artifacts: { vkey: { sha256: pins.vkey } } }));
    expect(readHashesFile(join(d, 'hashes.json'))).toEqual(pins);
    expect(readHashesFile(join(d, 'missing.json'))).toEqual({});
  });
});

const paths = defaultArtifactPaths(CIRCUITS);
const hashesPath = join(CIRCUITS, 'artifacts', 'hashes.json');
const haveArtifacts = artifactsPresent(paths);

describe.skipIf(!haveArtifacts)('groth16 proving with real circuit artifacts', () => {
  it('proves a fee-only spend and the proof self-verifies', async () => {
    const tree = new MerkleTree();
    const note = ownedNoteInTree(tree, 5_000_000n);
    const s = buildFeeOnly(
      { keys: TEST_KEYS, tree, hubChainId: 31337n, hub: '0x1111111111111111111111111111111111111111', phiBps: 10n, relayerFeeBucket: 10_000n, minWithdraw: 0n },
      note,
      { relayer: zeroAddress, relayerFee: 0n },
    );
    const r = await prove(s.witness, s.publicInputs, { paths, pins: readHashesFile(hashesPath) });
    expect(r.publicSignals).toHaveLength(7);
    expect(r.proof.b[0][0]).toBe(BigInt(r.raw.pi_b[0]![1]!));
    await terminateProver();
  }, 300_000);
});
