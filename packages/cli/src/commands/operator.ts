/**
 * lp add|remove, validator register|bond|allocate|unbond|withdraw|claim (Ethereum, EOA-signed).
 */
import type { Command } from 'commander';
import { getAddress, isAddress } from 'viem';
import { abi, chainIdFor } from '@xpool/sdk';
import type { Ctx } from '../context.js';
import { getEoaAccount } from '../eoa.js';
import { CliError, fmtUsdc, out, parseUsdc } from '../io.js';
import { ensureAllowance, sendTx } from '../ops/chaintx.js';
import { ctxFrom } from './common.js';

/** Parse "base=100,arb=50" into chain ids and USDC amounts. */
export function parseAllocations(ctx: Ctx, spec: string): { chainIds: bigint[]; amounts: bigint[] } {
  const chainIds: bigint[] = [];
  const amounts: bigint[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-zA-Z0-9]+)=([0-9.]+)$/.exec(part);
    if (!m) throw new CliError(`bad allocation "${part}" (expected chain=amount)`);
    const id = BigInt(chainIdFor(ctx.env(), m[1]!));
    if (chainIds.includes(id)) throw new CliError(`duplicate chain ${m[1]}`);
    chainIds.push(id);
    amounts.push(m[2] === '0' ? 0n : parseUsdc(m[2]!));
  }
  if (chainIds.length === 0) throw new CliError('no allocations given');
  return { chainIds, amounts };
}

export function registerOperatorCommands(program: Command): void {
  const lp = program.command('lp').description('liquidity provider actions (Ethereum)');
  lp.command('add')
    .requiredOption('--amount <usdc>', 'USDC to add')
    .action(async (o: { amount: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const env = ctx.env();
      const a = parseUsdc(o.amount);
      const account = await getEoaAccount();
      const lm = env.hub.contracts.LiquidityManager;
      await ensureAllowance(ctx, account, env.hub.chainId, env.hub.usdc, lm, a);
      await sendTx(ctx, account, env.hub.chainId, lm, abi.liquidityManagerAbi, 'addLiquidity', [a, account.address]);
      out(`added ${fmtUsdc(a)} of liquidity`);
    });
  lp.command('remove')
    .option('--amount <shares>', 'LP shares to redeem (6 decimals)')
    .option('--all', 'redeem all shares')
    .action(async (o: { amount?: string; all?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const env = ctx.env();
      const account = await getEoaAccount();
      const lm = env.hub.contracts.LiquidityManager;
      const hub = (await ctx.clients()).hub;
      let shares: bigint;
      if (o.all) shares = await hub.run((c) => c.readContract({ address: lm, abi: abi.liquidityManagerAbi, functionName: 'balanceOf', args: [account.address] }));
      else if (o.amount) shares = parseUsdc(o.amount);
      else throw new CliError('pass --amount <shares> or --all');
      if (shares === 0n) throw new CliError('no shares to redeem');
      const preview = await hub.run((c) => c.readContract({ address: lm, abi: abi.liquidityManagerAbi, functionName: 'previewRemove', args: [shares] }));
      await sendTx(ctx, account, env.hub.chainId, lm, abi.liquidityManagerAbi, 'removeLiquidity', [shares, account.address]);
      out(`redeemed shares for ~${fmtUsdc(preview)}`);
    });

  const v = program.command('validator').description('validator operator actions (Ethereum StakeManager)');
  const sm = (ctx: Ctx) => ctx.env().hub.contracts.StakeManager;
  v.command('register')
    .requiredOption('--signer <0x...>', 'attestation signing address (separate from the operator key)')
    .action(async (o: { signer: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      if (!isAddress(o.signer, { strict: false })) throw new CliError('bad --signer');
      const account = await getEoaAccount();
      if (getAddress(o.signer) === account.address) throw new CliError('signer must differ from the operator key');
      await sendTx(ctx, account, ctx.env().hub.chainId, sm(ctx), abi.stakeManagerAbi, 'register', [getAddress(o.signer)]);
      out('registered');
    });
  v.command('bond')
    .requiredOption('--amount <usdc>', 'USDC to bond')
    .action(async (o: { amount: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const env = ctx.env();
      const a = parseUsdc(o.amount);
      const account = await getEoaAccount();
      await ensureAllowance(ctx, account, env.hub.chainId, env.hub.usdc, sm(ctx), a);
      await sendTx(ctx, account, env.hub.chainId, sm(ctx), abi.stakeManagerAbi, 'bond', [a]);
      out(`bonded ${fmtUsdc(a)} (effective next epoch)`);
    });
  v.command('allocate')
    .requiredOption('--alloc <spec>', 'per-chain allocations, e.g. base=100,arb=50')
    .action(async (o: { alloc: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const { chainIds, amounts } = parseAllocations(ctx, o.alloc);
      const account = await getEoaAccount();
      await sendTx(ctx, account, ctx.env().hub.chainId, sm(ctx), abi.stakeManagerAbi, 'setAllocations', [chainIds, amounts]);
      out('allocations set (effective next epoch)');
    });
  v.command('unbond')
    .requiredOption('--amount <usdc>', 'USDC to unbond')
    .action(async (o: { amount: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const account = await getEoaAccount();
      await sendTx(ctx, account, ctx.env().hub.chainId, sm(ctx), abi.stakeManagerAbi, 'requestUnbond', [parseUsdc(o.amount)]);
      out('unbond requested');
    });
  v.command('withdraw').action(async (_o: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const account = await getEoaAccount();
    await sendTx(ctx, account, ctx.env().hub.chainId, sm(ctx), abi.stakeManagerAbi, 'withdrawUnbonded', []);
    out('unbonded stake withdrawn');
  });
  v.command('claim').action(async (_o: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const account = await getEoaAccount();
    await sendTx(ctx, account, ctx.env().hub.chainId, sm(ctx), abi.stakeManagerAbi, 'claimRewards', []);
    out('rewards claimed');
  });
}
