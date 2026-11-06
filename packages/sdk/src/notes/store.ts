/**
 * Encrypted local stores (PRD 13.1): file-based under a configurable directory,
 * AES-256-GCM with a scrypt-derived key. Nothing is ever written in plaintext.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Field } from '../crypto/field.js';
import { DEFAULT_SCRYPT, readVaultFile, VaultError, VaultKey, writeFileAtomic, type ScryptParams } from './vault.js';

/** Generic encrypted JSON document (bigints and bytes round-trip). */
export class EncryptedStore<T> {
  private constructor(
    readonly path: string,
    private readonly key: VaultKey,
    public data: T,
  ) {}

  static exists(path: string): boolean {
    return existsSync(path);
  }

  static create<T>(path: string, password: string, initial: T, params: ScryptParams = DEFAULT_SCRYPT): EncryptedStore<T> {
    if (existsSync(path)) throw new VaultError(`refusing to overwrite existing store ${path}`);
    const s = new EncryptedStore<T>(path, VaultKey.derive(password, undefined, params), initial);
    s.save();
    return s;
  }

  static open<T>(path: string, password: string): EncryptedStore<T> {
    const raw = readVaultFile(path);
    const key = VaultKey.forEnvelope(raw, password);
    try {
      return new EncryptedStore<T>(path, key, key.decrypt<T>(raw));
    } catch (e) {
      key.destroy();
      throw e;
    }
  }

  save(): void {
    writeFileAtomic(this.path, this.key.encrypt(this.data));
  }

  close(): void {
    this.key.destroy();
  }
}

export type NoteSource = 'l1-deposit' | 'l2-deposit' | 'spend-output';

/** A note the wallet owns, after validate-before-accept. */
export interface OwnedNote {
  amount: bigint;
  pk: Field;
  blinding: Field;
  commitment: Field;
  /** Leaf index in the global tree. */
  leafIndex: number;
  nullifier: Field;
  source: NoteSource;
  /** Chain on which value entered the pool for this note (deposit chain; hub for spend outputs). */
  originChainId: number;
  /** Unix seconds of the (estimated) funding deposit; drives W3. */
  fundedAt: number;
  /** Leaf index of the funding deposit; drives W4 (deposits made after it). */
  fundingLeaf: number;
  /** Amounts of the funding deposits (W5 amount hygiene). */
  fundingAmounts: bigint[];
  spent: boolean;
  /** spendId (hex) that consumed it, if known locally. */
  spentBy?: string;
}

/** An L2 deposit decrypted and digest-checked, waiting for `L2DepositInserted`. */
export interface PendingDeposit {
  chainId: number;
  index: number;
  amount: bigint;
  blinding: Field;
  pk: Field;
  commitment: Field;
  fundedAt: number;
}

export interface NoteStoreData {
  version: 1;
  account: number;
  notes: OwnedNote[];
  pending: PendingDeposit[];
}

export const NOTES_FILE = 'notes.vault';

/** Encrypted note store under `dir`. */
export class NoteStore {
  private constructor(private readonly store: EncryptedStore<NoteStoreData>) {}

  static path(dir: string): string {
    return join(dir, NOTES_FILE);
  }

  static exists(dir: string): boolean {
    return existsSync(NoteStore.path(dir));
  }

  static create(dir: string, password: string, account = 0, params?: ScryptParams): NoteStore {
    return new NoteStore(
      EncryptedStore.create<NoteStoreData>(NoteStore.path(dir), password, { version: 1, account, notes: [], pending: [] }, params),
    );
  }

  static open(dir: string, password: string): NoteStore {
    const s = EncryptedStore.open<NoteStoreData>(NoteStore.path(dir), password);
    if (s.data?.version !== 1 || !Array.isArray(s.data.notes)) throw new VaultError('unsupported note store');
    return new NoteStore(s);
  }

  get account(): number {
    return this.store.data.account;
  }

  list(opts: { includeSpent?: boolean } = {}): OwnedNote[] {
    return this.store.data.notes.filter((n) => opts.includeSpent || !n.spent);
  }

  pending(): PendingDeposit[] {
    return [...this.store.data.pending];
  }

  balance(): bigint {
    return this.list().reduce((s, n) => s + n.amount, 0n);
  }

  /** Insert or replace by leafIndex. Returns true if new. */
  upsert(note: OwnedNote): boolean {
    const i = this.store.data.notes.findIndex((n) => n.leafIndex === note.leafIndex);
    if (i >= 0) {
      const prev = this.store.data.notes[i]!;
      this.store.data.notes[i] = { ...note, spent: prev.spent || note.spent, spentBy: prev.spentBy ?? note.spentBy };
      return false;
    }
    this.store.data.notes.push(note);
    this.store.data.notes.sort((a, b) => a.leafIndex - b.leafIndex);
    return true;
  }

  addPending(p: PendingDeposit): void {
    if (this.store.data.pending.some((x) => x.chainId === p.chainId && x.index === p.index)) return;
    this.store.data.pending.push(p);
  }

  takePending(chainId: number, index: number): PendingDeposit | undefined {
    const i = this.store.data.pending.findIndex((x) => x.chainId === chainId && x.index === index);
    if (i < 0) return undefined;
    return this.store.data.pending.splice(i, 1)[0];
  }

  /** Mark notes whose nullifier is in `spent` as spent. Returns how many changed. */
  applyNullifiers(isSpent: (n: Field) => boolean): number {
    let k = 0;
    for (const n of this.store.data.notes) {
      if (!n.spent && isSpent(n.nullifier)) {
        n.spent = true;
        k++;
      }
    }
    return k;
  }

  markSpent(nullifiers: Field[], spendId: string): void {
    for (const n of this.store.data.notes) {
      if (nullifiers.includes(n.nullifier)) {
        n.spent = true;
        n.spentBy = spendId;
      }
    }
  }

  save(): void {
    this.store.save();
  }

  close(): void {
    this.store.close();
  }
}
