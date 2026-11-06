import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hexToBytes, type Hex, type Address } from 'viem';
import { H1, H2, H3 } from '../src/crypto/poseidon.js';
import { decryptNote } from '../src/crypto/box.js';
import { mnemonicToSeed } from '../src/keys/mnemonic.js';
import { deriveKeys } from '../src/keys/derive.js';
import { encodeAddress } from '../src/keys/address.js';
import { freshWithdrawalAddress } from '../src/keys/fresh.js';
import { commitment, nullifier } from '../src/notes/note.js';
import { encodeExtData, extDataHash, type ExtData } from '../src/tx/extdata.js';
import { zeroHashes } from '../src/tree/zeros.js';

const FIX = resolve(__dirname, '../../../fixtures');
const V = JSON.parse(readFileSync(resolve(FIX, 'sdk-vectors.json'), 'utf8'));
const Z = JSON.parse(readFileSync(resolve(FIX, 'zero-hashes.json'), 'utf8'));
const b = (x: string): bigint => BigInt(x);

describe('committed fixtures match the SDK', () => {
  it('poseidon (>= 1000 random + edge cases per arity)', () => {
    expect(V.poseidon.H1.length).toBeGreaterThanOrEqual(1004);
    for (const v of V.poseidon.H1) expect(H1(b(v.inputs[0]))).toBe(b(v.output));
    for (const v of V.poseidon.H2) expect(H2(b(v.inputs[0]), b(v.inputs[1]))).toBe(b(v.output));
    for (const v of V.poseidon.H3) expect(H3(b(v.inputs[0]), b(v.inputs[1]), b(v.inputs[2]))).toBe(b(v.output));
  });

  it('keys from the TEST mnemonic', () => {
    const seed = mnemonicToSeed(V.keys.mnemonic);
    for (const a of V.keys.accounts) {
      const k = deriveKeys(seed, a.account);
      expect(k.sk).toBe(b(a.sk));
      expect(k.pk).toBe(b(a.pk));
      expect(encodeAddress('xpool', k.pk, k.encPk)).toBe(a.address.xpool);
    }
    for (const f of V.keys.fresh) expect(freshWithdrawalAddress(seed, f.n)).toBe(f.address);
  });

  it('notes, nullifiers and encryption', () => {
    for (const n of V.notes) {
      const C = commitment({ amount: b(n.amount), pk: b(n.pk), blinding: b(n.blinding) });
      expect(C).toBe(b(n.commitment));
      expect(nullifier(b(n.sk), C, n.leafIndex)).toBe(b(n.nullifier));
    }
    for (const e of V.encryption) {
      expect(decryptNote(hexToBytes(e.recipientEncSk), hexToBytes(e.ciphertext))).toEqual({ amount: b(e.amount), blinding: b(e.blinding) });
    }
  });

  it('extDataHash vectors', () => {
    for (const v of V.extData) {
      const e = v.ext;
      const ext: ExtData = {
        version: e.version, hubChainId: b(e.hubChainId), hub: e.hub as Address, dstChainId: b(e.dstChainId),
        recipient: e.recipient as Address, withdrawAmount: b(e.withdrawAmount), relayer: e.relayer as Address,
        relayerFee: b(e.relayerFee), protocolFee: b(e.protocolFee), deadline: b(e.deadline), encOut0: e.encOut0 as Hex, encOut1: e.encOut1 as Hex,
      };
      expect(encodeExtData(ext)).toBe(v.abiEncoded);
      expect(extDataHash(ext)).toBe(b(v.extDataHash));
    }
  });

  it('zero hashes Z0..Z24', () => {
    expect(Z.zeroHashes).toHaveLength(25);
    expect(Z.zeroHashes).toEqual(zeroHashes().map((x) => x.toString()));
  });
});
