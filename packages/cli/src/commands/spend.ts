/**
 * transfer / withdraw / merge. Every spend goes through a relayer over Tor by default (W1, W8),
 * to a fresh recipient (W2), after privacy checks (W3-W6), with deadline jitter + random delay (W10).
 */
import type { Command } from 'commander';
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import {
  buildMerge, buildTransfer, buildWithdraw, chainIdFor, decodeAddress, evaluateInternalSpend, evaluateWithdrawal,
  HRP_BY_ENV, pickMergePair, protocolFee, selectInputs, SelectionError, splitWithdrawal, type Overrides,
} from '@xpool/sdk';
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import { CliError, confirmYes, fmtUsdc, info, out, parseUsdc, printFindings, sleep } from '../io.js';
import { checkLiquidity, checkRelayFlags, getFees, proveAndSubmit, recipientOrFresh, spendContextFor, type RelayFlags } from '../ops/spend.js';
import { syncWallet } from '../ops/sync.js';
import type { Wallet, WithdrawSchedule } from '../wallet.js';
import { ctxFrom, withWallet } from './common.js';

interface CommonFlags extends RelayFlags {
  yes?: boolean;
}

function addRelayOptions(c: Command): Command {
  return c
    .option('--self-relay', 'W1 override: submit from your own EOA (requires --i-understand-linkability)')
    .option('--i-understand-linkability', 'confirm that self-relaying links this spend to your address')
    .option('-y, --yes', 'do not ask for confirmation');
}

interface WithdrawFlags extends CommonFlags {
  toChain: string;
  amount: string;
  recipient?: string;
  fresh?: boolean;
  split?: string;
  resume?: boolean;
  ignoreDelay?: boolean;
  ignoreAnonymity?: boolean;
  allowLinkedRecipient?: boolean;
}

async function withdrawOnce(ctx: Ctx, w: Wallet, dst: number, amount: bigint, recipientFlag: string | undefined, f: WithdrawFlags): Promise<string> {
  const env = ctx.env();
  const { view } = await syncWallet(ctx, w, true);
  const fees = await getFees(ctx, f, BigInt(dst), amount);
  const need = amount + fees.relayerFee + protocolFee(amount, env.params.phiBps);
  let inputs;
  try {
    inputs = selectInputs(w.notes.list(), need);
  } catch (e) {
    if (e instanceof SelectionError && e.needsMerge) throw new CliError(`${e.message} (W6)`);
    throw e;
  }
  const overrides: Overrides = { ignoreDelay: f.ignoreDelay, ignoreAnonymity: f.ignoreAnonymity, allowLinkedRecipient: f.allowLinkedRecipient };
  // Evaluate the policy against the candidate recipient before reserving a fresh one.
  const candidate = recipientFlag;
  if (candidate !== undefined && (!isAddress(candidate, { strict: false }) || getAddress(candidate) === zeroAddress)) {
    throw new CliError('--recipient must be a non-zero address');
  }
  const policy = evaluateWithdrawal({
    inputs, w: amount, recipient: candidate ? (getAddress(candidate) as Address) : undefined, deposits: view.state.deposits,
    history: { usedRecipients: w.data.usedRecipients, linkedAddresses: w.data.linkedAddresses },
    unspentNotes: w.notes.list().length, nowSec: Math.floor(Date.now() / 1000), overrides,
  });
  info(`anonymity: ${policy.depositsAfterFunding} deposits since funding; k_feas ~ ${policy.kFeas}`);
  if (printFindings(policy.findings)) throw new CliError('withdrawal blocked by privacy defaults (see above)');
  await checkLiquidity(ctx, BigInt(dst), amount);
  const recipient = recipientOrFresh(w, candidate ? getAddress(candidate) : undefined);
  const s = buildWithdraw(spendContextFor(ctx, w, view), {
    notes: w.notes.list(), dstChainId: BigInt(dst), recipient: recipient.address, amount, inputs, fees,
  });
  info(`${s.kind}: ${fmtUsdc(amount)} to ${recipient.address} on chain ${dst}; total out ${fmtUsdc(s.v)}`);
  if (!(await confirmYes('Proceed?', f.yes === true))) throw new CliError('aborted');
  w.markRecipientUsed(recipient.address);
  w.save();
  return (await proveAndSubmit(ctx, w, s, fees, f)).spendId;
}

async function runSchedule(ctx: Ctx, w: Wallet, sched: WithdrawSchedule, f: WithdrawFlags): Promise<void> {
  for (const part of sched.parts) {
    if (part.done) continue;
    const wait = part.at * 1000 - Date.now();
    if (wait > 0) {
      info(`next part ${fmtUsdc(BigInt(part.amount))} at ${new Date(part.at * 1000).toISOString()} (keep this process running, or resume with --resume)`);
      await sleep(wait);
    }
    part.spendId = await withdrawOnce(ctx, w, sched.dstChainId, BigInt(part.amount), undefined, f);
    part.done = true;
    w.save();
  }
  w.data.schedules = w.data.schedules.filter((x) => x.id !== sched.id);
  w.save();
}

export function registerSpendCommands(program: Command): void {
  addRelayOptions(
    program
      .command('transfer')
      .description('private transfer to a shielded address')
      .requiredOption('--to <address>', 'recipient shielded address')
      .requiredOption('--amount <usdc>', 'amount in USDC'),
  ).action(async (o: CommonFlags & { to: string; amount: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    checkRelayFlags(o);
    const to = decodeAddress(o.to, HRP_BY_ENV[ctx.envName]);
    const amount = parseUsdc(o.amount);
    await withWallet(ctx, async (w) => {
      const { view } = await syncWallet(ctx, w, true);
      const fees = await getFees(ctx, o, 0n, 0n);
      const s = buildTransfer(spendContextFor(ctx, w, view), { notes: w.notes.list(), to, amount, fees });
      printFindings(evaluateInternalSpend(s.spentNotes, view.state.deposits, Math.floor(Date.now() / 1000)));
      info(`transfer ${fmtUsdc(amount)} (relayer fee ${fmtUsdc(fees.relayerFee)})`);
      if (!(await confirmYes('Proceed?', o.yes === true))) throw new CliError('aborted');
      await proveAndSubmit(ctx, w, s, fees, o);
    });
  });

  addRelayOptions(
    program
      .command('withdraw')
      .description('withdraw to a fresh address on eth|base|arb')
      .requiredOption('--to-chain <chain>', 'eth | base | arb')
      .option('--amount <usdc>', 'amount in USDC (total when --split)')
      .option('--recipient <0x...>', 'explicit recipient (checked against local history, W2)')
      .option('--fresh', 'derive a fresh recipient (default)')
      .option('--split <n>', 'split into N withdrawals at random delays (W5)')
      .option('--resume', 'resume a saved split schedule')
      .option('--ignore-delay', 'W3 override: allow < 1 h since the funding deposit')
      .option('--ignore-anonymity', 'W4 override: allow < 5 deposits since the funding deposit')
      .option('--allow-linked-recipient', 'W2 override: allow a reused or linked recipient'),
  ).action(async (o: WithdrawFlags, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    checkRelayFlags(o);
    if (o.recipient && o.fresh) throw new CliError('use either --recipient or --fresh');
    const dst = chainIdFor(ctx.env(), o.toChain);
    await withWallet(ctx, async (w) => {
      if (o.resume) {
        const sched = w.data.schedules.find((x) => x.dstChainId === dst) ?? w.data.schedules[0];
        if (!sched) throw new CliError('no saved schedule');
        await runSchedule(ctx, w, sched, o);
        return;
      }
      if (!o.amount) throw new CliError('--amount is required');
      const amount = parseUsdc(o.amount);
      if (o.split) {
        const n = Number(o.split);
        if (!Number.isInteger(n) || n < 2 || n > 32) throw new CliError('--split must be 2..32');
        if (o.recipient) throw new CliError('--split always uses fresh recipients');
        const parts = splitWithdrawal(amount, n, { minPart: ctx.env().params.minWithdraw });
        const sched: WithdrawSchedule = {
          id: randomBytes(8).toString('hex'), dstChainId: dst,
          parts: parts.map((p) => ({ amount: p.amount.toString(), at: p.at, done: false })),
        };
        for (const p of parts) info(`  ${fmtUsdc(p.amount)} at ${new Date(p.at * 1000).toISOString()}`);
        if (!(await confirmYes(`Schedule ${n} withdrawals?`, o.yes === true))) throw new CliError('aborted');
        w.data.schedules.push(sched);
        w.save();
        await runSchedule(ctx, w, sched, { ...o, yes: true });
        return;
      }
      await withdrawOnce(ctx, w, dst, amount, o.recipient, o);
    });
  });

  addRelayOptions(program.command('merge').description('merge your two smallest notes into one (W6)')).action(
    async (o: CommonFlags, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      checkRelayFlags(o);
      await withWallet(ctx, async (w) => {
        const { view } = await syncWallet(ctx, w, true);
        const pair = pickMergePair(w.notes.list());
        if (!pair) {
          out('nothing to merge (fewer than two unspent notes)');
          return;
        }
        const fees = await getFees(ctx, o, 0n, 0n);
        const s = buildMerge(spendContextFor(ctx, w, view), pair, fees);
        printFindings(evaluateInternalSpend(pair, view.state.deposits, Math.floor(Date.now() / 1000)));
        info(`merge ${fmtUsdc(pair[0].amount)} + ${fmtUsdc(pair[1].amount)} (relayer fee ${fmtUsdc(fees.relayerFee)})`);
        if (!(await confirmYes('Proceed?', o.yes === true))) throw new CliError('aborted');
        await proveAndSubmit(ctx, w, s, fees, o);
      });
    },
  );
}
