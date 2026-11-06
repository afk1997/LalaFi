/**
 * Wallet files under <home>/<env>/, all password-encrypted (AES-256-GCM, scrypt):
 *   wallet.vault  mnemonic, account, fresh-address counter, local history, spends, schedules
 *   notes.vault   NoteStore (owned notes)
 *   chain.vault   SyncState (public chain data cache)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChainView, deriveKeys, emptySyncState, encodeAddress, EncryptedStore, freshWithdrawalAddress, mnemonicToSeed, NoteStore,
  type Env, type ScryptParams, type SpendingKeys, type SyncState,
} from '@xpool/sdk';
import { CliError } from './io.js';

export interface SpendRecordLocal {
  spendId: string;
  kind: string;
  dstChainId: number;
  w: string;
  recipient?: string;
  relayer?: string;
  requestId?: string;
  txHash?: string;
  createdAt: number;
}

export interface SchedulePart {
  amount: string;
  at: number;
  done: boolean;
  spendId?: string;
}

export interface WithdrawSchedule {
  id: string;
  dstChainId: number;
  parts: SchedulePart[];
}

export interface WalletData {
  version: 1;
  env: Env;
  mnemonic: string;
  passphrase: string;
  account: number;
  createdAt: number;
  /** Next unused index on m/44'/60'/7331'/0/n. */
  freshIndex: number;
  usedRecipients: string[];
  /** Depositor EOAs and other addresses linked to this wallet (W2). */
  linkedAddresses: string[];
  spends: SpendRecordLocal[];
  schedules: WithdrawSchedule[];
}

const WALLET_FILE = 'wallet.vault';
const CHAIN_FILE = 'chain.vault';

export class Wallet {
  private constructor(
    readonly dir: string,
    private readonly store: EncryptedStore<WalletData>,
    readonly notes: NoteStore,
    readonly chain: EncryptedStore<SyncState>,
    readonly seed: Uint8Array,
    readonly keys: SpendingKeys,
  ) {}

  static exists(dir: string): boolean {
    return existsSync(join(dir, WALLET_FILE));
  }

  static create(dir: string, password: string, env: Env, mnemonic: string, passphrase = '', account = 0, params?: ScryptParams): Wallet {
    if (Wallet.exists(dir)) throw new CliError(`a wallet already exists in ${dir}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seed = mnemonicToSeed(mnemonic, passphrase);
    const data: WalletData = {
      version: 1, env, mnemonic, passphrase, account, createdAt: Math.floor(Date.now() / 1000),
      freshIndex: 0, usedRecipients: [], linkedAddresses: [], spends: [], schedules: [],
    };
    const store = EncryptedStore.create(join(dir, WALLET_FILE), password, data, params);
    const notes = NoteStore.create(dir, password, account, params);
    const chain = EncryptedStore.create<SyncState>(join(dir, CHAIN_FILE), password, emptySyncState(), params);
    return new Wallet(dir, store, notes, chain, seed, deriveKeys(seed, account));
  }

  static open(dir: string, password: string): Wallet {
    if (!Wallet.exists(dir)) throw new CliError(`no wallet in ${dir}; run \`xpool init\``);
    const store = EncryptedStore.open<WalletData>(join(dir, WALLET_FILE), password);
    if (store.data.version !== 1) throw new CliError('unsupported wallet version');
    const seed = mnemonicToSeed(store.data.mnemonic, store.data.passphrase);
    const notes = NoteStore.open(dir, password);
    const chain = EncryptedStore.open<SyncState>(join(dir, CHAIN_FILE), password);
    return new Wallet(dir, store, notes, chain, seed, deriveKeys(seed, store.data.account));
  }

  get data(): WalletData {
    return this.store.data;
  }

  view(): ChainView {
    return new ChainView(this.chain.data);
  }

  address(hrp: string): string {
    return encodeAddress(hrp, this.keys.pk, this.keys.encPk);
  }

  /** Reserve the next fresh withdrawal address (never reused, W2). Saved immediately. */
  reserveFreshRecipient(): { address: `0x${string}`; index: number } {
    const index = this.data.freshIndex;
    const address = freshWithdrawalAddress(this.seed, index);
    this.data.freshIndex = index + 1;
    this.save();
    return { address, index };
  }

  addLinkedAddress(a: string): void {
    if (!this.data.linkedAddresses.some((x) => x.toLowerCase() === a.toLowerCase())) this.data.linkedAddresses.push(a);
  }

  markRecipientUsed(a: string): void {
    if (!this.data.usedRecipients.some((x) => x.toLowerCase() === a.toLowerCase())) this.data.usedRecipients.push(a);
  }

  save(): void {
    this.store.save();
    this.notes.save();
    this.chain.save();
  }

  close(): void {
    this.store.close();
    this.notes.close();
    this.chain.close();
    this.seed.fill(0);
  }
}
