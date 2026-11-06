/**
 * status <spendId>, privacy.
 */
import type { Command } from 'commander';
import {
  ANON_WARN, chainName, checkDelay, depositsAfter, kFeasible, secondsUntilRecommended,
} from '@xpool/sdk';
import { CliError, fmtUsdc, info, out } from '../io.js';
import { syncWallet } from '../ops/sync.js';
import { ctxFrom, withWallet } from './common.js';

export function registerInfoCommands(program: Command): void {
  program
    .command('status <spendId>')
    .description('spend, release and delivery status across chains')
    .option('--no-sync', 'use the local cache only')
    .action(async (spendId: string, o: { sync: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      if (!/^0x[0-9a-fA-F]{64}$/.test(spendId)) throw new CliError('spendId must be 32-byte hex');
      const id = spendId.toLowerCase();
      await withWallet(ctx, async (w) => {
        if (o.sync) await syncWallet(ctx, w, true);
        const env = ctx.env();
        const st = w.chain.data;
        const local = w.data.spends.find((s) => s.spendId.toLowerCase() === id);
        if (local) {
          out(`local: ${local.kind}, created ${new Date(local.createdAt * 1000).toISOString()}${local.txHash ? `, tx ${local.txHash}` : ''}`);
          if (local.requestId && !local.txHash) {
            try {
              const r = await (await ctx.relayer()).status(local.requestId);
              out(`relayer: ${r.state}${r.txHash ? ` tx ${r.txHash}` : ''}`);
            } catch (e) {
              info(`relayer status unavailable: ${(e as Error).message}`);
            }
          }
        }
        const spend = Object.values(st.spends).find((s) => s.spendId.toLowerCase() === id);
        if (!spend) {
          out('hub: not seen at the finalized head yet');
          return;
        }
        out(`hub: spent in ${spend.txHash}, v = ${fmtUsdc(spend.v)}, destination ${spend.dstChainId === 0 ? 'none (internal)' : chainName(env, spend.dstChainId)}`);
        if (spend.dstChainId === env.hub.chainId) out('release: paid on Ethereum in the same transaction');
        for (const r of Object.values(st.releases)) {
          if (r.spendId.toLowerCase() !== id) continue;
          out(`release: ${chainName(env, r.dstChainId)} #${r.index} ${fmtUsdc(r.amount)} to ${r.recipient}: ${r.status}`);
        }
      });
    });

  program
    .command('privacy')
    .description('anonymity estimates for your current notes')
    .option('--no-sync', 'use the local cache only')
    .action(async (o: { sync: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await withWallet(ctx, async (w) => {
        if (o.sync) await syncWallet(ctx, w, true);
        const deps = w.chain.data.deposits;
        const now = Math.floor(Date.now() / 1000);
        out(`pool: ${deps.length} deposits, ${w.chain.data.leaves.length} leaves`);
        out('leaf\tamount\tdeposits-since\tk_feas\tadvice');
        for (const n of w.notes.list()) {
          const after = depositsAfter(deps, n.fundingLeaf);
          const k = kFeasible(deps, n.amount, now);
          const d = checkDelay(n.fundedAt, now);
          const wait = secondsUntilRecommended(n.fundedAt, now);
          const advice = [
            d ? `wait ${(wait / 3600).toFixed(1)}h more` : 'delay ok',
            after < ANON_WARN ? `only ${after} deposits since` : 'anonymity ok',
          ].join('; ');
          out(`${n.leafIndex}\t${fmtUsdc(n.amount)}\t${after}\t${k}\t${advice}`);
        }
      });
    });
}
