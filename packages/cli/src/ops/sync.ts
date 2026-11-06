import { chainName, ChainView, syncAll, type SyncStats } from '@xpool/sdk';
import type { Ctx } from '../context.js';
import { info } from '../io.js';
import type { Wallet } from '../wallet.js';

/** Full sync of all chains into the wallet; checkpoints are persisted after every page. */
export async function syncWallet(ctx: Ctx, wallet: Wallet, quiet = false): Promise<{ view: ChainView; stats: SyncStats }> {
  const env = ctx.env();
  const clients = await ctx.clients();
  const view = wallet.view();
  let last = '';
  const stats = await syncAll({
    env,
    clients,
    keys: wallet.keys,
    view,
    notes: wallet.notes,
    onProgress: (p) => {
      if (quiet) return;
      const span = p.toBlock - p.fromBlock + 1n;
      const done = p.at - p.fromBlock + 1n;
      const pct = span > 0n ? Number((done * 100n) / span) : 100;
      const line = `sync ${chainName(env, p.chainId)}: block ${p.at} / ${p.toBlock} (${pct}%)`;
      if (line !== last) info(line);
      last = line;
    },
    onCheckpoint: () => {
      wallet.notes.save();
      wallet.chain.save();
    },
  });
  wallet.save();
  return { view, stats };
}
