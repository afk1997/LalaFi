import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as SqliteModule from 'node:sqlite';

/**
 * `node:sqlite` is loaded through `process.getBuiltinModule` instead of a static import:
 * bundlers used by the test runner (vite) strip the `node:` prefix of builtins they don't know,
 * and `sqlite` only exists as `node:sqlite`.
 */
const sqlite = process.getBuiltinModule('node:sqlite') as typeof SqliteModule;

export type Database = SqliteModule.DatabaseSync;

export interface OpenDatabaseOptions {
  /** Take an exclusive lock on the file so a second process can't use the same database. */
  exclusive?: boolean;
}

/** Opens (creating if needed) a durable SQLite database: WAL, synchronous=FULL, busy timeout. */
export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new sqlite.DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (opts.exclusive) db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back on any error. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
