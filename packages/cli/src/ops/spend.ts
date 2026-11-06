/**
 * Shared spend pipeline: fees (relayer quote) -> build -> prove -> random delay (W10) -> relay (W1).
 */
import { zeroAddress, type Address } from 'viem';
import {
  abi, defaultArtifactPaths, isBucketMultiple, prove, randomSubmissionDelayMs, readHashesFile, terminateProver,
  type ArtifactPins, type BridgeParams, type ChainView, type FeeTerms, type PreparedSpend, type RelayerClient, type SpendContext,
} from '@xpool/sdk';
import { join } from 'node:path';
import type { Ctx } from '../context.js';
import { getEoaAccount } from '../eoa.js';
import { CliError, fmtUsdc, info, out, sleep } from '../io.js';
import type { SpendRecordLocal, Wallet } from '../wallet.js';
import { sendTx } from './chaintx.js';

export interface RelayFlags {
  selfRelay?: boolean;
  iUnderstandLinkability?: boolean;
}

export interface SpendFees extends FeeTerms {
  ethValue: bigint;
  bridgeParams: BridgeParams;
  client?: RelayerClient;
}

const EMPTY_BP: BridgeParams = { maxSubmissionCost: 0n, gasLimit: 0n, maxFeePerGas: 0n, refundAddress: zeroAddress };

/** W1: self-relay needs both flags. */
export function checkRelayFlags(f: RelayFlags): void {
  if (f.selfRelay && !f.iUnderstandLinkability) {
    throw new CliError(
      'W1: --self-relay sends the spend from your own address, linking it to you publicly.\n' +
        '    Re-run with --self-relay --i-understand-linkability if you really want this.',
    );
  }
}

export function spendContextFor(ctx: Ctx, wallet: Wallet, view: ChainView): SpendContext {
  const env = ctx.env();
  return {
    keys: wallet.keys,
    tree: view.tree,
    hubChainId: BigInt(env.hub.chainId),
    hub: env.hub.contracts.HubCore,
    phiBps: env.params.phiBps,
    relayerFeeBucket: env.params.relayerFeeBucket,
    minWithdraw: env.params.minWithdraw,
  };
}

export async function getFees(ctx: Ctx, flags: RelayFlags, dstChainId: bigint, w: bigint): Promise<SpendFees> {
  checkRelayFlags(flags);
  if (flags.selfRelay) {
    const spoke = ctx.env().spokes.find((s) => BigInt(s.chainId) === dstChainId);
    if (spoke?.stack === 'arbitrum') {
      // TODO(xpool): estimate retryable BridgeParams (+30% margin) for self-relayed Arbitrum releases.
      throw new CliError('self-relay to Arbitrum needs retryable bridge parameters; use a relayer for this destination');
    }
    info('W1 override: self-relaying from your own EOA (linkable).');
    return { relayer: zeroAddress, relayerFee: 0n, ethValue: 0n, bridgeParams: EMPTY_BP };
  }
  const client = await ctx.relayer();
  const q = await client.quote(dstChainId, w);
  const bucket = ctx.env().params.relayerFeeBucket;
  if (!isBucketMultiple(q.relayerFee, bucket)) throw new CliError('relayer quoted a fee outside the fee buckets (W7); refusing');
  if (q.expiresAt * 1000 < Date.now() + 60_000) throw new CliError('relayer quote expires too soon');
  info(`relayer ${q.relayer} fee ${fmtUsdc(q.relayerFee)}`);
  return { relayer: q.relayer, relayerFee: q.relayerFee, ethValue: q.ethValue, bridgeParams: q.bridgeParams, client };
}

function artifactPins(ctx: Ctx): ArtifactPins {
  const pins = ctx.env().artifacts;
  if (pins.wasm && pins.zkey && pins.vkey) return pins;
  if (ctx.envName === 'local') return readHashesFile(join(ctx.circuitsDir(), 'artifacts', 'hashes.json'));
  throw new CliError(`config/${ctx.envName}.json has no pinned artifact hashes; refusing to prove`);
}

const SUBMIT_DELAY_MAX_MS: Record<string, number> = { local: 3_000, testnet: 60_000, mainnet: 300_000 };
const OK_STATES = new Set(['mined', 'confirmed', 'released', 'success', 'succeeded', 'executed', 'done']);
const BAD_STATES = new Set(['failed', 'reverted', 'rejected', 'error', 'expired']);

/** Liquidity pre-check on the destination (PRD 7.4 step 10, checked by the wallet before proving). */
export async function checkLiquidity(ctx: Ctx, dstChainId: bigint, w: bigint): Promise<void> {
  const env = ctx.env();
  const avail = await (await ctx.clients()).hub.run((c) =>
    c.readContract({ address: env.hub.contracts.LiquidityManager, abi: abi.liquidityManagerAbi, functionName: 'available', args: [dstChainId] }),
  );
  if (avail < w) throw new CliError(`insufficient liquidity on destination (${fmtUsdc(avail)} available); try another chain or later`);
}

export async function proveAndSubmit(ctx: Ctx, wallet: Wallet, s: PreparedSpend, fees: SpendFees, flags: RelayFlags): Promise<SpendRecordLocal> {
  const env = ctx.env();
  info('proving (this can take a few seconds)...');
  let proof;
  try {
    proof = (await prove(s.witness, s.publicInputs, { paths: defaultArtifactPaths(ctx.circuitsDir()), pins: artifactPins(ctx), rapidsnark: process.env.XPOOL_RAPIDSNARK })).proof;
  } finally {
    await terminateProver();
  }

  const delay = randomSubmissionDelayMs(SUBMIT_DELAY_MAX_MS[ctx.envName] ?? 60_000);
  info(`W10: waiting a random ${Math.round(delay / 1000)} s before submitting`);
  await sleep(delay);

  const rec: SpendRecordLocal = {
    spendId: s.spendId,
    kind: s.kind,
    dstChainId: Number(s.extData.dstChainId),
    w: s.extData.withdrawAmount.toString(),
    recipient: s.extData.recipient === zeroAddress ? undefined : s.extData.recipient,
    relayer: s.extData.relayer,
    createdAt: Math.floor(Date.now() / 1000),
  };

  if (flags.selfRelay) {
    const account = await getEoaAccount();
    wallet.addLinkedAddress(account.address);
    rec.txHash = await sendTx(ctx, account, env.hub.chainId, env.hub.contracts.HubCore, abi.hubCoreAbi, 'transact',
      [proof, s.publicInputs, s.extData, fees.bridgeParams], fees.ethValue);
  } else {
    if (!fees.client) throw new CliError('no relayer client');
    rec.requestId = await fees.client.relay(proof, s.publicInputs, s.extData);
    info(`relayed, request ${rec.requestId}`);
    rec.txHash = await waitRelay(fees.client, rec.requestId);
  }
  wallet.data.spends.push(rec);
  wallet.notes.markSpent(s.publicInputs.inputNullifiers, s.spendId);
  wallet.save();
  out(`spend ${s.spendId}`);
  if (rec.txHash) out(`tx ${rec.txHash}`);
  return rec;
}

async function waitRelay(client: RelayerClient, id: string): Promise<`0x${string}` | undefined> {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const st = await client.status(id);
    if (st.state !== last) info(`relayer: ${st.state}`);
    last = st.state;
    if (OK_STATES.has(st.state)) return st.txHash;
    if (BAD_STATES.has(st.state)) throw new CliError(`relayer reports ${st.state}; your notes were not spent`);
    await sleep(3_000);
  }
  info('still pending at the relayer; check later with `xpool status <spendId>`');
  return undefined;
}

export function recipientOrFresh(wallet: Wallet, recipient: string | undefined): { address: Address; fresh: boolean } {
  if (recipient) return { address: recipient as Address, fresh: false };
  const r = wallet.reserveFreshRecipient();
  info(`fresh recipient #${r.index}: ${r.address}`);
  return { address: r.address, fresh: true };
}
