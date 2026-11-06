/**
 * xpool deposit --chain eth|base|arb --amount 1000
 * Note prep (PRD 8.1/8.2): fresh b, P = H2(pk, b), encNote to own encPk; approve; deposit(a, P, encNote).
 */
import type { Command } from 'commander';
import { toHex } from 'viem';
import { abi, chainIdFor, createNote, encryptNote, ownerDigest } from '@xpool/sdk';
import { getEoaAccount } from '../eoa.js';
import { CliError, fmtUsdc, info, out, parseUsdc } from '../io.js';
import { ensureAllowance, sendTx } from '../ops/chaintx.js';
import { ctxFrom, withWallet } from './common.js';

export function registerDeposit(program: Command): void {
  program
    .command('deposit')
    .description('deposit USDC into the pool from an EOA (XPOOL_EOA_KEY or prompt)')
    .requiredOption('--chain <chain>', 'eth | base | arb')
    .requiredOption('--amount <usdc>', 'amount in USDC')
    .action(async (o: { chain: string; amount: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const env = ctx.env();
      const chainId = chainIdFor(env, o.chain);
      const a = parseUsdc(o.amount);
      await withWallet(ctx, async (w) => {
        const account = await getEoaAccount();
        const note = createNote(a, w.keys.pk);
        const P = ownerDigest(note.pk, note.blinding);
        const encNote = toHex(encryptNote(w.keys.encPk, { amount: a, blinding: note.blinding }));
        const clients = await ctx.clients();
        // W2 history: the depositor address must never become a withdrawal recipient.
        w.addLinkedAddress(account.address);
        w.save();

        if (chainId === env.hub.chainId) {
          const dm = env.hub.contracts.DepositManager;
          const [min, max] = await Promise.all([
            clients.hub.run((c) => c.readContract({ address: dm, abi: abi.depositManagerAbi, functionName: 'minDeposit' })),
            clients.hub.run((c) => c.readContract({ address: dm, abi: abi.depositManagerAbi, functionName: 'maxDeposit' })),
          ]);
          if (a < min || a > max) throw new CliError(`amount must be between ${fmtUsdc(min)} and ${fmtUsdc(max)}`);
          await ensureAllowance(ctx, account, chainId, env.hub.usdc, dm, a);
          await sendTx(ctx, account, chainId, dm, abi.depositManagerAbi, 'deposit', [a, P, encNote]);
        } else {
          const s = env.spokes.find((x) => x.chainId === chainId)!;
          const pool = clients.pool(chainId);
          const read = <F extends 'minDeposit' | 'maxDeposit' | 'settleFeeInsert' | 'settleFeeFinal'>(fn: F) =>
            pool.run((c) => c.readContract({ address: s.spoke, abi: abi.spokeAbi, functionName: fn }));
          const [min, max, fi, ff] = await Promise.all([read('minDeposit'), read('maxDeposit'), read('settleFeeInsert'), read('settleFeeFinal')]);
          if (a < min || a > max) throw new CliError(`amount must be between ${fmtUsdc(min)} and ${fmtUsdc(max)}`);
          const total = a + fi + ff;
          info(`settlement fee ${fmtUsdc(fi + ff)}; approving ${fmtUsdc(total)}`);
          await ensureAllowance(ctx, account, chainId, s.usdc, s.spoke, total);
          await sendTx(ctx, account, chainId, s.spoke, abi.spokeAbi, 'deposit', [a, P, encNote]);
        }
        out(`deposited ${fmtUsdc(a)}; the note becomes spendable once inserted on the hub (run \`xpool sync\`)`);
      });
    });
}
