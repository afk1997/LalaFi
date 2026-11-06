/**
 * Generates fixtures/sdk-vectors.json and fixtures/zero-hashes.json.
 * Inputs come from a deterministic keccak counter PRNG so the files are reproducible.
 * This is TEST DATA ONLY: wallet code never derives randomness this way (PRD 5.10).
 *
 *   pnpm --filter @xpool/sdk fixtures
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeAbiParameters, keccak256, toBytes, toHex, zeroAddress, type Hex } from 'viem';
import { P } from '../src/constants.js';
import { H1, H2, H3 } from '../src/crypto/poseidon.js';
import { sealNoteWith, x25519PublicKey, clampX25519 } from '../src/crypto/box.js';
import { mnemonicToSeed } from '../src/keys/mnemonic.js';
import { deriveKeys } from '../src/keys/derive.js';
import { encodeAddress } from '../src/keys/address.js';
import { freshPath, freshWithdrawalAddress } from '../src/keys/fresh.js';
import { commitment, nullifier, ownerDigest, signature } from '../src/notes/note.js';
import { encodeExtData, extDataHash, makeExtData, type ExtData } from '../src/tx/extdata.js';
import { protocolFee, publicAmount, roundUpToBucket } from '../src/tx/fees.js';
import { spendIdOf } from '../src/tx/builder.js';
import { MerkleTree, zeroHashes } from '../src/tree/index.js';

const OUT = resolve(import.meta.dirname, '../../../fixtures');

/** TEST mnemonic (BIP-39 test vector). NEVER use with real funds. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

let ctr = 0;
function prngBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 32) {
    const h = toBytes(keccak256(toBytes(`xpool.sdk.fixtures/${ctr++}`)));
    out.set(h.subarray(0, Math.min(32, n - off)), off);
  }
  return out;
}
const prngField = (): bigint => BigInt(toHex(prngBytes(64))) % P;
const s = (x: bigint | number): string => x.toString(10);
const hex = (b: Uint8Array): Hex => toHex(b);

// ------------------------------------------------------------------ poseidon
const EDGES = [0n, 1n, P - 1n, (1n << 248n) - 1n];
const h1: { inputs: string[]; output: string }[] = [];
const h2: { inputs: string[]; output: string }[] = [];
const h3: { inputs: string[]; output: string }[] = [];
for (const a of EDGES) {
  h1.push({ inputs: [s(a)], output: s(H1(a)) });
  for (const b of EDGES) {
    h2.push({ inputs: [s(a), s(b)], output: s(H2(a, b)) });
    for (const c of EDGES) h3.push({ inputs: [s(a), s(b), s(c)], output: s(H3(a, b, c)) });
  }
}
for (let i = 0; i < 1000; i++) {
  const [a, b, c] = [prngField(), prngField(), prngField()];
  h1.push({ inputs: [s(a)], output: s(H1(a)) });
  h2.push({ inputs: [s(a), s(b)], output: s(H2(a, b)) });
  h3.push({ inputs: [s(a), s(b), s(c)], output: s(H3(a, b, c)) });
}

// ------------------------------------------------------------------ keys
const seed = mnemonicToSeed(TEST_MNEMONIC);
const accounts = [0, 1, 7].map((acct) => {
  const k = deriveKeys(seed, acct);
  return {
    account: acct,
    sk: s(k.sk),
    pk: s(k.pk),
    encSk: hex(k.encSk),
    encPk: hex(k.encPk),
    address: {
      xpool: encodeAddress('xpool', k.pk, k.encPk),
      txpool: encodeAddress('txpool', k.pk, k.encPk),
      lxpool: encodeAddress('lxpool', k.pk, k.encPk),
    },
  };
});
const fresh = [0, 1, 2].map((n) => ({ n, path: freshPath(n), address: freshWithdrawalAddress(seed, n) }));
const keys0 = deriveKeys(seed, 0);

// ------------------------------------------------------------------ notes
const noteVectors = [
  { amount: 0n, leafIndex: 0 },
  { amount: 1n, leafIndex: 1 },
  { amount: 1_000_000n, leafIndex: 2 },
  { amount: 1_000_000_000n, leafIndex: 1234 },
  { amount: (1n << 248n) - 1n, leafIndex: 2 ** 24 - 1 },
].map(({ amount, leafIndex }) => {
  const blinding = prngField();
  const n = { amount, pk: keys0.pk, blinding };
  const C = commitment(n);
  return {
    sk: s(keys0.sk),
    pk: s(keys0.pk),
    amount: s(amount),
    tokenId: '1',
    blinding: s(blinding),
    ownerDigest: s(ownerDigest(keys0.pk, blinding)),
    commitment: s(C),
    leafIndex,
    signature: s(signature(keys0.sk, C, leafIndex)),
    nullifier: s(nullifier(keys0.sk, C, leafIndex)),
  };
});

// ------------------------------------------------------------------ encryption
const encryption = [0n, 5_000_000n, (1n << 248n) - 1n].map((amount) => {
  const blinding = prngField();
  const esk = clampX25519(prngBytes(32));
  const nonce = prngBytes(24);
  const ct = sealNoteWith(keys0.encPk, { amount, blinding }, esk, nonce);
  return {
    recipientEncSk: hex(keys0.encSk),
    recipientEncPk: hex(keys0.encPk),
    amount: s(amount),
    blinding: s(blinding),
    ephemeralSecret: hex(esk),
    ephemeralPublic: hex(x25519PublicKey(esk)),
    nonce: hex(nonce),
    ciphertext: hex(ct),
  };
});

// ------------------------------------------------------------------ extData
const HUB = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const REL = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RCP = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const blob = (n: number): Hex => hex(prngBytes(n));
const extCases: { name: string; ext: ExtData }[] = [
  {
    name: 'empty encOuts, transfer shape',
    ext: makeExtData({ hubChainId: 31337n, hub: HUB, dstChainId: 0n, recipient: zeroAddress, withdrawAmount: 0n, relayer: zeroAddress, relayerFee: 0n, protocolFee: 0n, deadline: 0n, encOut0: '0x', encOut1: '0x' }),
  },
  {
    name: 'transfer with 137-byte encOuts',
    ext: makeExtData({ hubChainId: 11155111n, hub: HUB, dstChainId: 0n, recipient: zeroAddress, withdrawAmount: 0n, relayer: REL, relayerFee: 10_000n, protocolFee: 0n, deadline: 1_800_000_000n, encOut0: blob(137), encOut1: blob(137) }),
  },
  {
    name: 'withdraw to base',
    ext: makeExtData({ hubChainId: 31337n, hub: HUB, dstChainId: 31338n, recipient: RCP, withdrawAmount: 100_000_000n, relayer: REL, relayerFee: 250_000n, protocolFee: protocolFee(100_000_000n, 10n), deadline: 1_800_003_600n, encOut0: blob(137), encOut1: blob(137) }),
  },
  {
    name: '256-byte encOuts, max values',
    ext: makeExtData({ hubChainId: (1n << 64n) - 1n, hub: HUB, dstChainId: (1n << 64n) - 1n, recipient: RCP, withdrawAmount: (1n << 247n), relayer: REL, relayerFee: 10n ** 30n, protocolFee: 1n, deadline: (1n << 64n) - 1n, encOut0: blob(256), encOut1: blob(256) }),
  },
  {
    name: 'uneven encOut lengths (1 and 33 bytes)',
    ext: makeExtData({ hubChainId: 1n, hub: HUB, dstChainId: 8453n, recipient: RCP, withdrawAmount: 1n, relayer: REL, relayerFee: 0n, protocolFee: 1n, deadline: 5n, encOut0: blob(1), encOut1: blob(33) }),
  },
];
const extDataVectors = extCases.map(({ name, ext }) => {
  const enc = encodeExtData(ext);
  return {
    name,
    ext: {
      version: ext.version, hubChainId: s(ext.hubChainId), hub: ext.hub, dstChainId: s(ext.dstChainId), recipient: ext.recipient,
      withdrawAmount: s(ext.withdrawAmount), relayer: ext.relayer, relayerFee: s(ext.relayerFee), protocolFee: s(ext.protocolFee),
      deadline: s(ext.deadline), encOut0: ext.encOut0, encOut1: ext.encOut1,
    },
    abiEncoded: enc,
    keccak256: keccak256(enc),
    extDataHash: s(extDataHash(ext)),
  };
});

// ------------------------------------------------------------------ fees / public amount / spend id / tree
const fees = [
  [0n, 10n], [1n, 10n], [999n, 10n], [1000n, 10n], [1001n, 10n], [1_000_000_000n, 10n], [123_456_789n, 25n],
].map(([w, phi]) => ({ w: s(w!), phiBps: s(phi!), protocolFee: s(protocolFee(w!, phi!)) }));
const publicAmounts = [0n, 1n, 1_000_000n, (1n << 248n) - 1n].map((v) => ({ v: s(v), publicAmount: s(publicAmount(v)) }));
const buckets = [[0n, 10_000n], [1n, 10_000n], [10_000n, 10_000n], [10_001n, 250_000n]].map(([f, b]) => ({ fee: s(f!), bucket: s(b!), rounded: s(roundUpToBucket(f!, b!)) }));
const spendIds = [[1n, 2n], [P - 1n, 0n]].map(([a, b]) => ({ n0: s(a!), n1: s(b!), spendId: spendIdOf(a!, b!), check: keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [a!, b!])) }));
const tree = new MerkleTree();
const treeSteps: { pair: [string, string]; leafIndex: number; root: string }[] = [];
for (let i = 0; i < 4; i++) {
  const l = prngField();
  const r = i === 3 ? zeroHashes()[0]! : prngField();
  const idx = tree.insertPair(l, r);
  treeSteps.push({ pair: [s(l), s(r)], leafIndex: idx, root: s(tree.root()) });
}

const vectors = {
  description: 'xpool v1 SDK cross-implementation vectors. TEST mnemonic: never use with real funds.',
  generator: 'packages/sdk/scripts/gen-fixtures.ts',
  p: s(P),
  poseidon: { H1: h1, H2: h2, H3: h3 },
  keys: {
    mnemonic: TEST_MNEMONIC,
    passphrase: '',
    seed: hex(seed),
    derivation: 'sk = OS2IP(HKDF-SHA256(seed, salt="xpool/v1", info="spend/"||u32be(acct), 64)) mod p; encSk = clamp(HKDF(seed, "xpool/v1", "enc/"||u32be(acct), 32))',
    accounts,
    fresh,
  },
  notes: noteVectors,
  encryption,
  extData: extDataVectors,
  fees,
  publicAmounts,
  relayerFeeBuckets: buckets,
  spendIds,
  tree: { emptyRoot: s(zeroHashes()[24]!), insertPairs: treeSteps },
};

writeFileSync(resolve(OUT, 'sdk-vectors.json'), `${JSON.stringify(vectors, null, 2)}\n`);
writeFileSync(
  resolve(OUT, 'zero-hashes.json'),
  `${JSON.stringify({ description: 'Z[0] = keccak256("xpool.v1.zero") mod p; Z[l+1] = H2(Z[l], Z[l]); empty root = Z[24]', depth: 24, zeroHashes: zeroHashes().map(s) }, null, 2)}\n`,
);
console.log(`wrote ${OUT}/sdk-vectors.json and zero-hashes.json`);
