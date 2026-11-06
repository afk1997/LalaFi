import type { Address, Hex } from 'viem';
import { itemHash, parseBig, stringifyBig, transaction, type Database, type DepositBatch } from '@xpool/service-common';
import type { Attestation } from './wire.js';

/**
 * Verified attestations seen from peers, ourselves and on-chain batches. Every stored attestation
 * has already had its signature checked. Also detects equivocation: the same signer signing two
 * different contents for one (chain, index) — evidence for proveEquivocation (PRD 7.5).
 */

export interface StoredAttestation extends Attestation {
  digest: Hex;
}

export interface Equivocation {
  signer: Address;
  chainId: bigint;
  index: bigint;
  digestA: Hex;
  digestB: Hex;
}

export class GossipStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attestations (
        digest TEXT NOT NULL, signer TEXT NOT NULL, chain TEXT NOT NULL, epoch TEXT NOT NULL,
        min_idx INTEGER NOT NULL, max_idx INTEGER NOT NULL, batch TEXT NOT NULL, signature TEXT NOT NULL,
        received_at INTEGER NOT NULL, PRIMARY KEY (digest, signer)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS att_chain ON attestations (chain, max_idx);
      CREATE TABLE IF NOT EXISTS att_items (
        signer TEXT NOT NULL, chain TEXT NOT NULL, idx INTEGER NOT NULL, item_hash TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY (signer, chain, idx, item_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS equivocations (
        signer TEXT NOT NULL, chain TEXT NOT NULL, idx INTEGER NOT NULL, digest_a TEXT NOT NULL, digest_b TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (signer, chain, idx)
      ) WITHOUT ROWID;
    `);
  }

  has(digest: Hex, signer: Address): boolean {
    return !!this.db.prepare('SELECT 1 FROM attestations WHERE digest = ? AND signer = ?').get(digest.toLowerCase(), signer.toLowerCase());
  }

  /** Stores a VERIFIED attestation. Returns whether it was new and any equivocation it reveals. */
  add(a: Attestation, digest: Hex, now = Date.now()): { isNew: boolean; equivocations: Equivocation[] } {
    const d = digest.toLowerCase() as Hex;
    const signer = a.signer.toLowerCase();
    const chain = a.batch.srcChainId.toString();
    return transaction(this.db, () => {
      if (this.has(d, a.signer)) return { isNew: false, equivocations: [] };
      const idx = a.batch.deposits.map((x) => Number(x.index));
      this.db
        .prepare('INSERT INTO attestations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(d, signer, chain, a.batch.epoch.toString(), Math.min(...idx), Math.max(...idx), stringifyBig(a.batch), a.signature, now);
      const found: Equivocation[] = [];
      const conflict = this.db.prepare('SELECT digest FROM att_items WHERE signer = ? AND chain = ? AND idx = ? AND item_hash != ? LIMIT 1');
      const ins = this.db.prepare('INSERT OR IGNORE INTO att_items VALUES (?, ?, ?, ?, ?)');
      const eq = this.db.prepare('INSERT OR IGNORE INTO equivocations (signer, chain, idx, digest_a, digest_b) VALUES (?, ?, ?, ?, ?)');
      for (const dep of a.batch.deposits) {
        const h = itemHash(dep);
        const other = conflict.get(signer, chain, Number(dep.index), h) as { digest: Hex } | undefined;
        if (other) {
          eq.run(signer, chain, Number(dep.index), other.digest, d);
          found.push({ signer: a.signer, chainId: a.batch.srcChainId, index: dep.index, digestA: other.digest, digestB: d });
        }
        ins.run(signer, chain, Number(dep.index), h, d);
      }
      return { isNew: true, equivocations: found };
    });
  }

  private rowToAtt(r: AttRow): StoredAttestation {
    return { digest: r.digest, signer: r.signer as Address, signature: r.signature, batch: parseBig<DepositBatch>(r.batch) };
  }

  get(digest: Hex, signer: Address): StoredAttestation | undefined {
    const r = this.db.prepare('SELECT * FROM attestations WHERE digest = ? AND signer = ?').get(digest.toLowerCase(), signer.toLowerCase()) as
      | AttRow
      | undefined;
    return r ? this.rowToAtt(r) : undefined;
  }

  /** Attestations for `chain` covering an index ≥ from (newest first). */
  list(chain: bigint, from: bigint, limit = 256): StoredAttestation[] {
    const rows = this.db
      .prepare('SELECT * FROM attestations WHERE chain = ? AND max_idx >= ? ORDER BY received_at DESC LIMIT ?')
      .all(chain.toString(), Number(from), limit) as unknown as AttRow[];
    return rows.map((r) => this.rowToAtt(r));
  }

  /** Signatures grouped by digest for the given chain and epochs. */
  groups(chain: bigint, epochs: bigint[]): Array<{ digest: Hex; batch: DepositBatch; sigs: Array<{ signer: Address; signature: Hex }> }> {
    if (!epochs.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM attestations WHERE chain = ? AND epoch IN (${epochs.map(() => '?').join(',')}) ORDER BY min_idx, digest`)
      .all(chain.toString(), ...epochs.map((e) => e.toString())) as unknown as AttRow[];
    const out = new Map<string, { digest: Hex; batch: DepositBatch; sigs: Array<{ signer: Address; signature: Hex }> }>();
    for (const r of rows) {
      const g = out.get(r.digest) ?? { digest: r.digest, batch: parseBig<DepositBatch>(r.batch), sigs: [] };
      g.sigs.push({ signer: r.signer as Address, signature: r.signature });
      out.set(r.digest, g);
    }
    return [...out.values()];
  }

  pendingEquivocations(): Equivocation[] {
    const rows = this.db.prepare("SELECT * FROM equivocations WHERE status = 'pending'").all() as unknown as Array<{
      signer: string;
      chain: string;
      idx: number;
      digest_a: Hex;
      digest_b: Hex;
    }>;
    return rows.map((r) => ({ signer: r.signer as Address, chainId: BigInt(r.chain), index: BigInt(r.idx), digestA: r.digest_a, digestB: r.digest_b }));
  }

  setEquivocationStatus(e: Equivocation, status: 'proven' | 'moot' | 'failed'): void {
    this.db
      .prepare('UPDATE equivocations SET status = ? WHERE signer = ? AND chain = ? AND idx = ?')
      .run(status, e.signer.toLowerCase(), e.chainId.toString(), Number(e.index));
  }

  /** Drops attestations of old epochs, keeping any that are equivocation evidence. */
  prune(chain: bigint, beforeEpoch: bigint): number {
    const res = this.db
      .prepare(
        `DELETE FROM attestations WHERE chain = ? AND CAST(epoch AS INTEGER) < ?
         AND digest NOT IN (SELECT digest_a FROM equivocations UNION SELECT digest_b FROM equivocations)`,
      )
      .run(chain.toString(), Number(beforeEpoch));
    return Number(res.changes);
  }
}

interface AttRow {
  digest: Hex;
  signer: string;
  batch: string;
  signature: Hex;
}
