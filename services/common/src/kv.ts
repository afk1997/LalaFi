import { parseBig, stringifyBig } from './json.js';
import { openDatabase, type Database } from './sqlite.js';

/**
 * Tiny persistent key/value store on node:sqlite. Values are JSON (bigint-safe).
 * Used for cursors and small service state. Never store IPs or request bodies here.
 */
export class KvStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database | string, private readonly namespace = 'default') {
    this.ownsDb = typeof dbOrPath === 'string';
    this.db = typeof dbOrPath === 'string' ? openDatabase(dbOrPath) : dbOrPath;
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, k))',
    );
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE ns = ? AND k = ?').get(this.namespace, key) as
      | { v: string }
      | undefined;
    return row ? parseBig<T>(row.v) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
      )
      .run(this.namespace, key, stringifyBig(value), Date.now());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE ns = ? AND k = ?').run(this.namespace, key);
  }

  /** Entries whose key starts with `prefix`, in key order. */
  list<T>(prefix = ''): Array<[string, T]> {
    const rows = this.db
      .prepare("SELECT k, v FROM kv WHERE ns = ? AND substr(k, 1, ?) = ? ORDER BY k")
      .all(this.namespace, prefix.length, prefix) as Array<{ k: string; v: string }>;
    return rows.map((r) => [r.k, parseBig<T>(r.v)]);
  }

  /** Deletes entries under `prefix` last updated before `olderThanMs` (epoch ms). */
  prune(prefix: string, olderThanMs: number): number {
    const res = this.db
      .prepare('DELETE FROM kv WHERE ns = ? AND substr(k, 1, ?) = ? AND updated_at < ?')
      .run(this.namespace, prefix.length, prefix, olderThanMs);
    return Number(res.changes);
  }

  scoped(namespace: string): KvStore {
    return new KvStore(this.db, namespace);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
