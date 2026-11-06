import type { Hex } from 'viem';
import { itemHash, transaction, type Database, type L2Deposit } from '@xpool/service-common';

/**
 * Deposits this node has verified at the L2 finalized tag (cross-checked across RPCs), plus
 * per-chain watcher cursors and a halt flag. A finalized deposit that later reads differently
 * means an RPC lied or finality broke: the chain is halted for signing.
 */
export class DepositConflict extends Error {
  constructor(
    readonly chainId: bigint,
    readonly index: bigint,
  ) {
    super(`verified deposit ${chainId}:${index} changed content`);
  }
}

export class DepositStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deposits (
        chain TEXT NOT NULL, idx INTEGER NOT NULL, owner_digest TEXT NOT NULL, amount TEXT NOT NULL,
        fee TEXT NOT NULL, l2_block TEXT NOT NULL, item_hash TEXT NOT NULL, block_number TEXT NOT NULL,
        PRIMARY KEY (chain, idx)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS watch_state (
        chain TEXT PRIMARY KEY, cursor_block TEXT, next_index INTEGER NOT NULL DEFAULT 0, halted TEXT
      ) WITHOUT ROWID;
    `);
  }

  private state(chain: bigint) {
    return this.db.prepare('SELECT cursor_block, next_index, halted FROM watch_state WHERE chain = ?').get(chain.toString()) as
      | { cursor_block: string | null; next_index: number; halted: string | null }
      | undefined;
  }

  cursor(chain: bigint): bigint | undefined {
    const c = this.state(chain)?.cursor_block;
    return c == null ? undefined : BigInt(c);
  }

  nextIndex(chain: bigint): bigint {
    return BigInt(this.state(chain)?.next_index ?? 0);
  }

  haltedReason(chain: bigint): string | null {
    return this.state(chain)?.halted ?? null;
  }

  halt(chain: bigint, reason: string): void {
    this.db
      .prepare('INSERT INTO watch_state (chain, halted) VALUES (?, ?) ON CONFLICT (chain) DO UPDATE SET halted = excluded.halted')
      .run(chain.toString(), reason);
  }

  /**
   * Appends verified deposits (which must continue the contiguous index sequence) and advances
   * the cursor to `toBlock`, atomically.
   */
  append(chain: bigint, deposits: ReadonlyArray<L2Deposit & { blockNumber: bigint }>, toBlock: bigint): void {
    const c = chain.toString();
    transaction(this.db, () => {
      let next = this.nextIndex(chain);
      const sel = this.db.prepare('SELECT item_hash FROM deposits WHERE chain = ? AND idx = ?');
      const ins = this.db.prepare(
        'INSERT INTO deposits (chain, idx, owner_digest, amount, fee, l2_block, item_hash, block_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const d of deposits) {
        const h = itemHash(d);
        const prior = sel.get(c, Number(d.index)) as { item_hash: Hex } | undefined;
        if (prior) {
          if (prior.item_hash !== h) throw new DepositConflict(chain, d.index);
          continue;
        }
        if (d.index !== next) throw new Error(`deposit index gap on ${chain}: expected ${next}, got ${d.index}`);
        ins.run(c, Number(d.index), d.ownerDigest.toString(), d.amount.toString(), d.fee.toString(), d.l2Block.toString(), h, d.blockNumber.toString());
        next++;
      }
      this.db
        .prepare(
          'INSERT INTO watch_state (chain, cursor_block, next_index) VALUES (?, ?, ?) ON CONFLICT (chain) DO UPDATE SET cursor_block = excluded.cursor_block, next_index = excluded.next_index',
        )
        .run(c, toBlock.toString(), Number(next));
    });
  }

  get(chain: bigint, index: bigint): L2Deposit | undefined {
    const r = this.db.prepare('SELECT * FROM deposits WHERE chain = ? AND idx = ?').get(chain.toString(), Number(index)) as Row | undefined;
    return r ? toDeposit(r) : undefined;
  }

  /** Verified deposits with index ≥ from, ascending. */
  range(chain: bigint, from: bigint, limit: number): L2Deposit[] {
    const rows = this.db
      .prepare('SELECT * FROM deposits WHERE chain = ? AND idx >= ? ORDER BY idx LIMIT ?')
      .all(chain.toString(), Number(from), limit) as unknown as Row[];
    return rows.map(toDeposit);
  }
}

interface Row {
  idx: number;
  owner_digest: string;
  amount: string;
  fee: string;
  l2_block: string;
}

const toDeposit = (r: Row): L2Deposit => ({
  index: BigInt(r.idx),
  ownerDigest: BigInt(r.owner_digest),
  amount: BigInt(r.amount),
  fee: BigInt(r.fee),
  l2Block: BigInt(r.l2_block),
});
