import type { Hex } from 'viem';
import { itemHash, openDatabase, transaction, type Database, type L2Deposit } from '@xpool/service-common';

/**
 * Slashing-protection database (PRD 13.4): `(chain, index) → itemHash` for every deposit this
 * validator has ever signed. The node NEVER signs a different content for an index it already
 * signed, so it can't equivocate by accident (bug, restart, clock skew, reorg, bad peer data).
 *
 * Rules:
 *  - `authorize` is write-ahead: the records are durably committed (synchronous=FULL) BEFORE the
 *    caller is allowed to produce a signature. A crash after authorize but before signing only
 *    means we later sign the same content again, which is always safe.
 *  - The whole batch is checked and recorded in one IMMEDIATE transaction: either every item is
 *    consistent and recorded, or nothing is recorded and EquivocationRefused is thrown.
 *  - The database is opened in EXCLUSIVE locking mode so a second process can't share it.
 *  - Rows are namespaced by EIP-712 domain (hub chain id + DepositManager address); within one
 *    deployment the key is exactly (chain, index).
 *  - Nothing is ever deleted.
 */

export class EquivocationRefused extends Error {
  constructor(
    readonly chainId: bigint,
    readonly index: bigint,
    readonly signedHash: Hex,
    readonly attemptedHash: Hex,
  ) {
    super(`refusing to sign deposit ${chainId}:${index}: already signed different content`);
    this.name = 'EquivocationRefused';
  }
}

export class InvalidBatch extends Error {
  constructor(reason: string) {
    super(`invalid batch: ${reason}`);
    this.name = 'InvalidBatch';
  }
}

export interface SignedRecord {
  digest: Hex;
  signature: Hex;
}

export class SlashingProtectionDb {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly domain: string,
    opts: { busyTimeoutMs?: number } = {},
  ) {
    this.db = openDatabase(path, { exclusive: true, ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}) });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signed_items (
        domain TEXT NOT NULL, chain TEXT NOT NULL, idx TEXT NOT NULL,
        item_hash TEXT NOT NULL, first_signed_at INTEGER NOT NULL,
        PRIMARY KEY (domain, chain, idx)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS signatures (
        domain TEXT NOT NULL, digest TEXT NOT NULL, signature TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (domain, digest)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS signed_items_no_update BEFORE UPDATE ON signed_items
        BEGIN SELECT RAISE(ABORT, 'signed_items is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS signed_items_no_delete BEFORE DELETE ON signed_items
        BEGIN SELECT RAISE(ABORT, 'signed_items is append-only'); END;
    `);
    // Take the file lock now; in EXCLUSIVE locking mode it is held until close().
    this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
  }

  /** Hash this validator signed for (chain, index), if any. */
  signedHash(chainId: bigint, index: bigint): Hex | undefined {
    const row = this.db
      .prepare('SELECT item_hash FROM signed_items WHERE domain = ? AND chain = ? AND idx = ?')
      .get(this.domain, chainId.toString(), index.toString()) as { item_hash: Hex } | undefined;
    return row?.item_hash;
  }

  /**
   * Atomically checks that no deposit conflicts with anything previously signed and records all
   * of them. Throws EquivocationRefused (recording nothing) on any conflict.
   */
  authorize(chainId: bigint, deposits: readonly L2Deposit[]): void {
    if (deposits.length === 0) throw new InvalidBatch('empty');
    const seen = new Set<bigint>();
    for (const d of deposits) {
      if (seen.has(d.index)) throw new InvalidBatch(`duplicate index ${d.index}`);
      seen.add(d.index);
    }
    const chain = chainId.toString();
    transaction(this.db, () => {
      const sel = this.db.prepare('SELECT item_hash FROM signed_items WHERE domain = ? AND chain = ? AND idx = ?');
      const ins = this.db.prepare('INSERT INTO signed_items (domain, chain, idx, item_hash, first_signed_at) VALUES (?, ?, ?, ?, ?)');
      const now = Date.now();
      for (const d of deposits) {
        const h = itemHash(d);
        const row = sel.get(this.domain, chain, d.index.toString()) as { item_hash: Hex } | undefined;
        if (row) {
          if (row.item_hash.toLowerCase() !== h.toLowerCase()) throw new EquivocationRefused(chainId, d.index, row.item_hash, h);
          continue;
        }
        ins.run(this.domain, chain, d.index.toString(), h, now);
      }
    });
  }

  recordSignature(digest: Hex, signature: Hex): void {
    this.db
      .prepare('INSERT OR IGNORE INTO signatures (domain, digest, signature, created_at) VALUES (?, ?, ?, ?)')
      .run(this.domain, digest.toLowerCase(), signature, Date.now());
  }

  signatureFor(digest: Hex): Hex | undefined {
    const row = this.db
      .prepare('SELECT signature FROM signatures WHERE domain = ? AND digest = ?')
      .get(this.domain, digest.toLowerCase()) as { signature: Hex } | undefined;
    return row?.signature;
  }

  close(): void {
    this.db.close();
  }
}
