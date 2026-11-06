import { getAbiItem, parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { hubCoreAbi, spokeAbi } from './abis.js';
import { bridgeParamsFor, spokeOf, type ProtocolContext } from './context.js';
import { encodeReleaseMessage, releaseHash } from './encoding.js';
import type { KvStore } from './kv.js';
import type { Logger } from './logger.js';
import { getLogsChunked, nextRange } from './logs.js';
import type { Metrics } from './metrics.js';
import { simulateAndSend } from './tx.js';
import { ReleaseState, type Release } from './types.js';

/**
 * Release re-delivery, shared by the relayer (its own releases) and the finalizer (all releases).
 * A logged release that the destination spoke hasn't executed after `resendAfterMs` is re-sent
 * through HubCore.resendRelease. Spokes execute each index at most once, so this is always safe.
 */

export interface TrackedRelease {
  release: Release;
  firstSeenMs: number;
  lastAttemptMs: number;
  resends: number;
}

export type ReleaseAction = 'done' | 'wait' | 'resend' | 'stuck';

/** Pure decision for one tracked release given the spoke's current state. */
export function releaseAction(
  t: TrackedRelease,
  state: ReleaseState,
  nowMs: number,
  resendAfterMs: number,
  maxResends: number,
): ReleaseAction {
  if (state !== ReleaseState.None) return 'done';
  if (nowMs - t.lastAttemptMs < resendAfterMs) return 'wait';
  return t.resends >= maxResends ? 'stuck' : 'resend';
}

export function releasesFromReceipt(receipt: TransactionReceipt, hubCore: Address): Release[] {
  const logs = parseEventLogs({ abi: hubCoreAbi, eventName: 'ReleaseLogged', logs: receipt.logs });
  return logs
    .filter((l) => l.address.toLowerCase() === hubCore.toLowerCase())
    .map((l) => ({
      dstChainId: l.args.dstChainId,
      index: l.args.index,
      recipient: l.args.recipient,
      amount: l.args.amount,
      spendId: l.args.spendId,
    }));
}

export interface ReleaseMonitorOptions {
  ctx: ProtocolContext;
  kv: KvStore;
  logger: Logger;
  metrics?: Metrics;
  /** Per destination chain: how long to wait for delivery before re-sending. */
  resendAfterMs: (dstChainId: number) => number;
  maxResends: number;
  marginBps: number;
  /** Refund address for Arbitrum retryables (the sending EOA). */
  refundAddress: Address;
}

const key = (r: Release) => `rel:${r.dstChainId}:${r.index.toString().padStart(20, '0')}`;

export class ReleaseMonitor {
  private readonly log: Logger;
  private readonly delivered;
  private readonly resent;
  private readonly stuck;
  private readonly latency;

  constructor(private readonly o: ReleaseMonitorOptions) {
    this.log = o.logger.child({ component: 'release-monitor' });
    this.delivered = o.metrics?.counter('releases_delivered_total', 'Releases seen executed on the spoke', ['dst']);
    this.resent = o.metrics?.counter('releases_resent_total', 'resendRelease calls', ['dst']);
    this.stuck = o.metrics?.gauge('releases_stuck', 'Releases undelivered after max resends', ['dst']);
    this.latency = o.metrics?.histogram('release_delivery_seconds', 'Log-to-execution latency', ['dst'], [10, 30, 60, 180, 600, 1800, 3600, 7200]);
  }

  track(release: Release, nowMs = Date.now()): void {
    if (Number(release.dstChainId) === this.o.ctx.cfg.hub.chainId) return; // paid in transact
    if (this.o.kv.get(key(release))) return;
    const t: TrackedRelease = { release, firstSeenMs: nowMs, lastAttemptMs: nowMs, resends: 0 };
    this.o.kv.set(key(release), t);
  }

  pending(): TrackedRelease[] {
    return this.o.kv.list<TrackedRelease>('rel:').map(([, v]) => v);
  }

  async tick(nowMs = Date.now()): Promise<void> {
    const stuckBy = new Map<number, number>();
    for (const t of this.pending()) {
      const r = t.release;
      const dst = Number(r.dstChainId);
      const spoke = spokeOf(this.o.ctx, dst);
      const state = (await spoke.clients.public.readContract({
        address: spoke.cfg.spoke,
        abi: spokeAbi,
        functionName: 'releaseState',
        args: [r.index],
      })) as ReleaseState;
      const action = releaseAction(t, state, nowMs, this.o.resendAfterMs(dst), this.o.maxResends);
      if (action === 'done') {
        this.o.kv.delete(key(r));
        this.delivered?.inc({ dst: String(dst) });
        this.latency?.observe({ dst: String(dst) }, (nowMs - t.firstSeenMs) / 1000);
        this.log.info('release delivered', { dst, index: r.index, state: ReleaseState[state] });
        if (state === ReleaseState.Failed) this.log.warn('release marked Failed on spoke (e.g. blacklisted recipient)', { dst, index: r.index });
        continue;
      }
      if (action === 'stuck') {
        stuckBy.set(dst, (stuckBy.get(dst) ?? 0) + 1);
        continue;
      }
      if (action === 'resend') await this.resend(t, nowMs);
    }
    for (const s of this.o.ctx.spokes.keys()) this.stuck?.set({ dst: String(s) }, stuckBy.get(s) ?? 0);
  }

  private async resend(t: TrackedRelease, nowMs: number): Promise<void> {
    const r = t.release;
    const hub = this.o.ctx.hub;
    if (!hub.wallet) throw new Error('release monitor needs a hub wallet to resend');
    const onchain = await hub.public.readContract({
      address: this.o.ctx.cfg.hub.contracts.HubCore,
      abi: hubCoreAbi,
      functionName: 'releaseHash',
      args: [r.dstChainId, r.index],
    });
    if (onchain.toLowerCase() !== releaseHash(r).toLowerCase()) {
      this.log.error('tracked release does not match hub releaseHash; dropping', { dst: r.dstChainId, index: r.index });
      this.o.kv.delete(key(r));
      return;
    }
    // Record the attempt first so a crash mid-send can't cause a tight resend loop.
    this.o.kv.set(key(r), { ...t, lastAttemptMs: nowMs, resends: t.resends + 1 });
    const { bp, value } = await bridgeParamsFor(this.o.ctx, r.dstChainId, encodeReleaseMessage(r), this.o.refundAddress, this.o.marginBps);
    const { hash } = await simulateAndSend(hub.public, hub.wallet, {
      address: this.o.ctx.cfg.hub.contracts.HubCore,
      abi: hubCoreAbi,
      functionName: 'resendRelease',
      args: [r, bp],
      value,
    });
    this.resent?.inc({ dst: String(r.dstChainId) });
    this.log.warn('release re-sent', { dst: r.dstChainId, index: r.index, attempt: t.resends + 1, tx: hash });
  }
}

/** Scans HubCore ReleaseLogged events (cursor in kv) and tracks every cross-chain release. */
export async function scanReleaseLogs(ctx: ProtocolContext, kv: KvStore, monitor: ReleaseMonitor, maxSpan = 5_000n): Promise<void> {
  const head = await ctx.hub.public.getBlockNumber();
  const range = nextRange(kv.get<bigint>('releaseScanCursor'), ctx.cfg.hub.deployBlock, head, maxSpan);
  if (!range) return;
  const logs = await getLogsChunked(ctx.hub.public, {
    address: ctx.cfg.hub.contracts.HubCore,
    event: getAbiItem({ abi: hubCoreAbi, name: 'ReleaseLogged' }),
    fromBlock: range.from,
    toBlock: range.to,
  });
  for (const l of logs) {
    monitor.track({
      dstChainId: l.args.dstChainId,
      index: l.args.index,
      recipient: l.args.recipient,
      amount: l.args.amount,
      spendId: l.args.spendId,
    });
  }
  kv.set('releaseScanCursor', range.to);
}
