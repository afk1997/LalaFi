/**
 * init, address, sync, balance, notes.
 */
import type { Command } from 'commander';
import { chainName, generateMnemonic, HRP_BY_ENV, isValidMnemonic, normalizeMnemonic } from '@xpool/sdk';
import { CliError, fmtUsdc, getPassword, info, out, promptSecret } from '../io.js';
import { syncWallet } from '../ops/sync.js';
import { Wallet } from '../wallet.js';
import { ctxFrom, withWallet } from './common.js';

export function registerWalletCommands(program: Command): void {
  program
    .command('init')
    .description('create a new wallet (new mnemonic) or --import an existing one; stored encrypted')
    .option('--import', 'import an existing 24-word mnemonic (read with echo off)')
    .option('--passphrase', 'use an optional BIP-39 passphrase (prompted)')
    .option('--account <n>', 'account number', '0')
    .action(async (o: { import?: boolean; passphrase?: boolean; account: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      if (Wallet.exists(ctx.walletDir)) throw new CliError(`a wallet already exists in ${ctx.walletDir}`);
      const account = Number(o.account);
      if (!Number.isInteger(account) || account < 0 || account > 0xffffffff) throw new CliError('bad --account');
      let mnemonic: string;
      if (o.import) {
        mnemonic = normalizeMnemonic(await promptSecret('Mnemonic (24 words, input hidden): '));
        if (!isValidMnemonic(mnemonic)) throw new CliError('invalid mnemonic (expected 24 BIP-39 English words)');
      } else {
        mnemonic = generateMnemonic();
      }
      const passphrase = o.passphrase ? await promptSecret('BIP-39 passphrase: ') : '';
      const password = await getPassword(true);
      const w = Wallet.create(ctx.walletDir, password, ctx.envName, mnemonic, passphrase, account);
      try {
        if (!o.import) {
          // Shown exactly once, on the terminal channel; it is stored only inside wallet.vault.
          info('');
          info('================ RECOVERY PHRASE (shown once) ================');
          info(mnemonic);
          info('Write it down offline. Anyone with it can spend your notes.');
          info('==============================================================');
          info('');
        }
        out(w.address(HRP_BY_ENV[ctx.envName]));
      } finally {
        w.close();
      }
    });

  program
    .command('address')
    .description('print your shielded address')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await withWallet(ctx, async (w) => out(w.address(HRP_BY_ENV[ctx.envName])));
    });

  program
    .command('sync')
    .description('sync all chains (full event download at the finalized tag)')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await withWallet(ctx, async (w) => {
        const { stats, view } = await syncWallet(ctx, w);
        out(`synced: ${view.tree.size} leaves, ${stats.newNotes} new notes, ${stats.spentNotes} newly spent`);
        out(`balance: ${fmtUsdc(w.notes.balance())}`);
      });
    });

  program
    .command('balance')
    .description('shielded balance')
    .option('--sync', 'sync first')
    .action(async (o: { sync?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await withWallet(ctx, async (w) => {
        if (o.sync) await syncWallet(ctx, w, true);
        out(fmtUsdc(w.notes.balance()));
        const p = w.notes.pending();
        if (p.length) info(`${p.length} L2 deposit(s) awaiting insertion: ${fmtUsdc(p.reduce((s, x) => s + x.amount, 0n))}`);
      });
    });

  program
    .command('notes')
    .description('list your notes')
    .option('--all', 'include spent notes')
    .action(async (o: { all?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await withWallet(ctx, async (w) => {
        const env = ctx.env();
        const now = Math.floor(Date.now() / 1000);
        out('leaf\tamount\torigin\tage\tstate');
        for (const n of w.notes.list({ includeSpent: o.all })) {
          const age = `${((now - n.fundedAt) / 3600).toFixed(1)}h`;
          out(`${n.leafIndex}\t${fmtUsdc(n.amount)}\t${chainName(env, n.originChainId)}\t${age}\t${n.spent ? 'spent' : 'unspent'}`);
        }
        for (const p of w.notes.pending()) out(`-\t${fmtUsdc(p.amount)}\t${chainName(env, p.chainId)}\t-\tpending insertion`);
      });
    });
}
