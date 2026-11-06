import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { depositBatchTypedData, itemHash, openDatabase, type DepositBatch, type L2Deposit } from '@xpool/service-common';
import { AttestationSigner } from '../src/attestation-signer.js';
import { LocalSigner, type Signer } from '../src/signer.js';
import { EquivocationRefused, InvalidBatch, SlashingProtectionDb } from '../src/slashing-db.js';

const KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const ctx = { hubChainId: 31337n, depositManager: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const };
const SPOKE = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const DOMAIN = '31337:0x5fbdb2315678afecb367f032d93f642f64180aa3';

const dep = (index: bigint, amount = 1_000_000n, over: Partial<L2Deposit> = {}): L2Deposit => ({
  index,
  ownerDigest: 1000n + index,
  amount,
  fee: 0n,
  l2Block: 100n + index,
  ...over,
});
const batch = (deposits: L2Deposit[], epoch = 1n, srcChainId = 31338n): DepositBatch => ({ srcChainId, spoke: SPOKE, epoch, deposits });

const open: SlashingProtectionDb[] = [];
function tmpDb(path = join(mkdtempSync(join(tmpdir(), 'xpool-sp-')), 'sp.sqlite'), domain = DOMAIN) {
  const db = new SlashingProtectionDb(path, domain, { busyTimeoutMs: 50 });
  open.push(db);
  return { db, path };
}
afterEach(() => {
  for (const d of open.splice(0)) {
    try {
      d.close();
    } catch {
      /* already closed */
    }
  }
});

describe('SlashingProtectionDb', () => {
  it('records and allows re-signing identical content', () => {
    const { db } = tmpDb();
    db.authorize(31338n, [dep(0n), dep(1n)]);
    expect(db.signedHash(31338n, 0n)).toBe(itemHash(dep(0n)));
    expect(() => db.authorize(31338n, [dep(0n), dep(1n)])).not.toThrow();
    expect(() => db.authorize(31338n, [dep(1n), dep(2n)])).not.toThrow();
  });

  it('refuses different content for an already-signed index, for every field', () => {
    const { db } = tmpDb();
    db.authorize(31338n, [dep(5n)]);
    for (const over of [{ amount: 2n }, { ownerDigest: 9n }, { fee: 1n }, { l2Block: 999n }] as Partial<L2Deposit>[]) {
      expect(() => db.authorize(31338n, [dep(5n, undefined, over)])).toThrow(EquivocationRefused);
    }
  });

  it('is all-or-nothing: a conflicting batch records none of its new items', () => {
    const { db } = tmpDb();
    db.authorize(31338n, [dep(3n)]);
    expect(() => db.authorize(31338n, [dep(1n), dep(2n), dep(3n, 7n)])).toThrow(EquivocationRefused);
    expect(db.signedHash(31338n, 1n)).toBeUndefined();
    expect(db.signedHash(31338n, 2n)).toBeUndefined();
    // the new items can later be signed with any content, the conflicting one never
    db.authorize(31338n, [dep(1n, 5n)]);
    expect(() => db.authorize(31338n, [dep(1n)])).toThrow(EquivocationRefused);
  });

  it('separates chains and domains, but not epochs', () => {
    const { db, path } = tmpDb();
    db.authorize(31338n, [dep(0n)]);
    expect(() => db.authorize(31339n, [dep(0n, 2n)])).not.toThrow();
    db.close();
    const other = tmpDb(path, '31337:0x0000000000000000000000000000000000000001').db;
    expect(() => other.authorize(31338n, [dep(0n, 2n)])).not.toThrow();
  });

  it('rejects empty batches and duplicate indices within one batch', () => {
    const { db } = tmpDb();
    expect(() => db.authorize(31338n, [])).toThrow(InvalidBatch);
    expect(() => db.authorize(31338n, [dep(0n), dep(0n, 2n)])).toThrow(InvalidBatch);
    expect(db.signedHash(31338n, 0n)).toBeUndefined();
  });

  it('persists across restart', () => {
    const { db, path } = tmpDb();
    db.authorize(31338n, [dep(10n)]);
    db.recordSignature('0xabc0', '0x1234');
    db.close();
    const reopened = tmpDb(path).db;
    expect(reopened.signedHash(31338n, 10n)).toBe(itemHash(dep(10n)));
    expect(reopened.signatureFor('0xABC0')).toBe('0x1234');
    expect(() => reopened.authorize(31338n, [dep(10n, 2n)])).toThrow(EquivocationRefused);
  });

  it('cannot be opened by a second process/connection while in use', () => {
    const { path } = tmpDb();
    expect(() => new SlashingProtectionDb(path, DOMAIN, { busyTimeoutMs: 50 })).toThrow();
  });

  it('signed items are append-only even through raw SQL', () => {
    const { db, path } = tmpDb();
    db.authorize(31338n, [dep(0n)]);
    db.close();
    const raw = openDatabase(path);
    expect(() => raw.exec("UPDATE signed_items SET item_hash = '0x00'")).toThrow(/append-only/);
    expect(() => raw.exec('DELETE FROM signed_items')).toThrow(/append-only/);
    raw.close();
  });
});

describe('AttestationSigner', () => {
  it('signs, recovers, and is idempotent per digest', async () => {
    const { db } = tmpDb();
    const s = new AttestationSigner(new LocalSigner(KEY), db, ctx);
    const b = batch([dep(0n), dep(1n)]);
    const a1 = await s.sign(b);
    const td = depositBatchTypedData(ctx, b);
    expect(await recoverTypedDataAddress({ ...td, signature: a1.signature })).toBe(s.address);
    const a2 = await s.sign(b);
    expect(a2.signature).toBe(a1.signature);
  });

  it('re-signs the same content under a new epoch (not equivocation)', async () => {
    const { db } = tmpDb();
    const s = new AttestationSigner(new LocalSigner(KEY), db, ctx);
    await s.sign(batch([dep(0n)], 1n));
    await expect(s.sign(batch([dep(0n)], 2n))).resolves.toBeTruthy();
  });

  it('never produces a signature for conflicting content — the key is not even touched', async () => {
    const { db } = tmpDb();
    let calls = 0;
    const inner = new LocalSigner(KEY);
    const counting: Signer = {
      address: inner.address,
      signTypedData: (td) => {
        calls++;
        return inner.signTypedData(td);
      },
    };
    const s = new AttestationSigner(counting, db, ctx);
    await s.sign(batch([dep(0n), dep(1n)]));
    expect(calls).toBe(1);
    await expect(s.sign(batch([dep(1n, 9n)], 1n))).rejects.toBeInstanceOf(EquivocationRefused);
    await expect(s.sign(batch([dep(1n, 9n)], 7n))).rejects.toBeInstanceOf(EquivocationRefused);
    await expect(s.sign(batch([dep(0n), dep(1n, undefined, { l2Block: 1n })]))).rejects.toBeInstanceOf(EquivocationRefused);
    expect(calls).toBe(1);
  });

  it('refuses after a restart too (fresh signer, same db file)', async () => {
    const { db, path } = tmpDb();
    await new AttestationSigner(new LocalSigner(KEY), db, ctx).sign(batch([dep(4n)]));
    db.close();
    const s2 = new AttestationSigner(new LocalSigner(KEY), tmpDb(path).db, ctx);
    await expect(s2.sign(batch([dep(4n, 3n)]))).rejects.toBeInstanceOf(EquivocationRefused);
  });

  it('records before signing: a crashing signer leaves the index locked to that content', async () => {
    const { db } = tmpDb();
    const failing: Signer = { address: new LocalSigner(KEY).address, signTypedData: async () => { throw new Error('hsm down'); } };
    await expect(new AttestationSigner(failing, db, ctx).sign(batch([dep(0n)]))).rejects.toThrow('hsm down');
    const s = new AttestationSigner(new LocalSigner(KEY), db, ctx);
    await expect(s.sign(batch([dep(0n, 2n)]))).rejects.toBeInstanceOf(EquivocationRefused);
    await expect(s.sign(batch([dep(0n)]))).resolves.toBeTruthy();
  });

  it('rejects a signer whose signature does not recover', async () => {
    const { db } = tmpDb();
    const other = new LocalSigner('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const lying: Signer = { address: new LocalSigner(KEY).address, signTypedData: (td) => other.signTypedData(td) };
    await expect(new AttestationSigner(lying, db, ctx).sign(batch([dep(0n)]))).rejects.toThrow(/recover/);
  });

  it('enforces batch shape (1..32, strictly ascending)', async () => {
    const { db } = tmpDb();
    const s = new AttestationSigner(new LocalSigner(KEY), db, ctx);
    await expect(s.sign(batch([]))).rejects.toBeInstanceOf(InvalidBatch);
    await expect(s.sign(batch([dep(2n), dep(1n)]))).rejects.toBeInstanceOf(InvalidBatch);
    await expect(s.sign(batch(Array.from({ length: 33 }, (_, i) => dep(BigInt(i)))))).rejects.toBeInstanceOf(InvalidBatch);
    await expect(s.sign(batch(Array.from({ length: 32 }, (_, i) => dep(BigInt(i)))))).resolves.toBeTruthy();
  });

  it('concurrent conflicting sign calls: at most one content per index wins', async () => {
    const { db } = tmpDb();
    const s = new AttestationSigner(new LocalSigner(KEY), db, ctx);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => s.sign(batch([dep(0n, BigInt(i + 1))]))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
