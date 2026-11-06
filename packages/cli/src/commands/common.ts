import type { Command } from 'commander';
import { Ctx, type GlobalOptions } from '../context.js';
import { getPassword } from '../io.js';
import { Wallet } from '../wallet.js';

export type CtxFactory = (cmd: Command) => Ctx;

/** Build a context from the root program's global options. */
export const ctxFrom: CtxFactory = (cmd) => {
  let root = cmd;
  while (root.parent) root = root.parent;
  return new Ctx(root.opts<GlobalOptions>());
};

export async function openWallet(ctx: Ctx): Promise<Wallet> {
  return Wallet.open(ctx.walletDir, await getPassword());
}

/** Run `f` with an open wallet; always closes (wipes keys) afterwards. */
export async function withWallet<T>(ctx: Ctx, f: (w: Wallet) => Promise<T>): Promise<T> {
  const w = await openWallet(ctx);
  try {
    return await f(w);
  } finally {
    w.close();
  }
}
