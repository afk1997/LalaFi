import { randomUUID } from 'node:crypto';
import type { Address, Hex } from 'viem';
import {
  HttpError,
  ReleaseState,
  SimulationError,
  bridgeParamsFor,
  encodeReleaseMessage,
  hubCoreAbi,
  releasesFromReceipt,
  simulate,
  spendId,
  spokeAbi,
  spokeOf,
  ZERO_ADDRESS,
  type BridgeParams,
  type Logger,
  type Metrics,
  type ProtocolContext,
  type ReleaseMonitor,
} from '@xpool/service-common';
import { computeRelayerFee, QuoteBook } from './fees.js';
import type { QuoteRequest, RelayRequest } from './schema.js';
import type { RelayerSettings } from './settings.js';
import type { RequestRecord, RequestStore } from './store.js';
import { validateRelay } from './validate.js';

export const VERSION = '0.1.0';

/** Immutable HubCore parameters, read once at startup. */
export interface HubParams {
  phiBps: bigint;
  relayerFeeBucket: bigint;
  minWithdraw: Map<bigint, bigint>;
}

export async function readHubParams(ctx: ProtocolContext): Promise<HubParams> {
  const hub = ctx.cfg.hub.contracts.HubCore;
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.hub.public.readContract({ address: hub, abi: hubCoreAbi, functionName, args } as never) as Promise<T>;
  const [phiBps, relayerFeeBucket] = await Promise.all([read<bigint>('phiBps'), read<bigint>('relayerFeeBucket')]);
  const minWithdraw = new Map<bigint, bigint>();
  for (const id of [ctx.cfg.hub.chainId, ...ctx.cfg.spokes.map((s) => s.chainId)]) {
    minWithdraw.set(BigInt(id), await read<bigint>('minWithdraw', [BigInt(id)]));
  }
  return { phiBps, relayerFeeBucket, minWithdraw };
}

export interface Quote {
  relayer: Address;
  relayerFee: bigint;
  ethValue: bigint;
  bridgeParams: BridgeParams;
  expiresAt: number;
}

export class RelayService {
  private readonly book = new QuoteBook();
  private readonly inflight = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly log: Logger;
  private readonly relays;
  private readonly rejects;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly params: HubParams,
    private readonly settings: RelayerSettings,
    private readonly store: RequestStore,
    private readonly monitor: ReleaseMonitor,
    logger: Logger,
    metrics: Metrics,
  ) {
    this.log = logger.child({ component: 'relay' });
    this.relays = metrics.counter('relayer_relays_total', 'Relay outcomes', ['outcome']);
    this.rejects = metrics.counter('relayer_rejections_total', 'Rejected relay requests', ['reason']);
  }

  get address(): Address {
    return this.ctx.hub.wallet!.account.address;
  }

  info() {
    return {
      relayer: this.address,
      version: VERSION,
      hubChainId: this.ctx.cfg.hub.chainId,
      hub: this.ctx.cfg.hub.contracts.HubCore,
      supportedChains: [this.ctx.cfg.hub.chainId, ...this.ctx.cfg.spokes.map((s) => s.chainId)],
      relayerFeeBucket: this.params.relayerFeeBucket,
      minRelayerFee: this.params.relayerFeeBucket,
      quoteTtlSeconds: this.settings.quoteTtlSec,
    };
  }

  /** Bridge params for a concrete or representative release to `dst`. */
  private async bridgeFor(dst: bigint, recipient: Address, amount: bigint, spend: Hex): Promise<{ bp: BridgeParams; value: bigint }> {
    if (dst === 0n) return bridgeParamsFor(this.ctx, this.ctx.cfg.hub.chainId, '0x', this.address, this.settings.arbMarginBps);
    const index =
      dst === BigInt(this.ctx.cfg.hub.chainId)
        ? 0n
        : await this.ctx.hub.public.readContract({
            address: this.ctx.cfg.hub.contracts.HubCore,
            abi: hubCoreAbi,
            functionName: 'releaseCount',
            args: [dst],
          });
    const message = encodeReleaseMessage({ dstChainId: dst, index, recipient, amount, spendId: spend });
    return bridgeParamsFor(this.ctx, dst, message, this.address, this.settings.arbMarginBps);
  }

  async quote(q: QuoteRequest, nowMs = Date.now()): Promise<Quote> {
    if (q.dstChainId !== 0n && !this.params.minWithdraw.has(q.dstChainId)) {
      throw new HttpError(400, 'unsupported_destination');
    }
    const placeholder = this.address; // representative recipient: same calldata size and gas class
    const { bp, value } = await this.bridgeFor(q.dstChainId, placeholder, q.withdrawAmount, `0x${'11'.repeat(32)}`);
    const gasPriceWei = await this.ctx.hub.public.getGasPrice();
    const relayerFee = computeRelayerFee({
      gasUnits: this.settings.transactGas,
      gasPriceWei,
      ethValueWei: value,
      ethPriceUsdc: this.settings.ethPriceUsdc,
      marginBps: this.settings.feeMarginBps,
      flatFee: this.settings.flatFee,
      bucket: this.params.relayerFeeBucket,
    });
    const expiresAt = nowMs + this.settings.quoteTtlSec * 1000;
    this.book.record(q.dstChainId, q.withdrawAmount, relayerFee, expiresAt);
    return { relayer: this.address, relayerFee, ethValue: value, bridgeParams: bp, expiresAt: Math.floor(expiresAt / 1000) };
  }

  private reject(reason: string, status = 422): never {
    this.rejects.inc({ reason });
    throw new HttpError(status, reason);
  }

  async relay(req: RelayRequest, nowMs = Date.now()): Promise<{ requestId: string }> {
    const e = req.extData;
    const [n0, n1] = req.publicInputs.inputNullifiers;
    const nk = `${n0}:${n1}`;
    if (this.inflight.has(nk)) this.reject('duplicate_request', 409);

    const booked = this.book.lowest(e.dstChainId, e.withdrawAmount);
    const minAcceptableFee =
      booked ?? (await this.quote({ dstChainId: e.dstChainId, withdrawAmount: e.withdrawAmount }, nowMs)).relayerFee;
    const rejection = validateRelay(req, {
      hubChainId: BigInt(this.ctx.cfg.hub.chainId),
      hub: this.ctx.cfg.hub.contracts.HubCore,
      relayer: this.address,
      relayerFeeBucket: this.params.relayerFeeBucket,
      phiBps: this.params.phiBps,
      minWithdraw: this.params.minWithdraw,
      nowSec: BigInt(Math.floor(nowMs / 1000)),
      minDeadlineSec: this.settings.minDeadlineSec,
      minAcceptableFee,
    });
    if (rejection) this.reject(rejection);

    // Our own delivery parameters (not bound in the proof), estimated for this exact release.
    const recipient = e.dstChainId === 0n ? ZERO_ADDRESS : e.recipient;
    const { bp, value } = await this.bridgeFor(e.dstChainId, recipient, e.withdrawAmount, spendId(n0, n1));

    // Simulate the exact call; the simulated request is what gets submitted (calldata unchanged).
    let request: unknown;
    try {
      request = await simulate(this.ctx.hub.public, this.ctx.hub.wallet!.account, {
        address: this.ctx.cfg.hub.contracts.HubCore,
        abi: hubCoreAbi,
        functionName: 'transact',
        args: [req.proof, req.publicInputs, req.extData, bp],
        value,
      });
    } catch (err) {
      const name = err instanceof SimulationError ? err.errorName ?? 'reverted' : 'simulation_failed';
      this.reject(`simulation_failed:${name}`);
    }

    const requestId = randomUUID();
    this.store.create(requestId, e.dstChainId, nowMs);
    this.inflight.add(nk);
    this.queue = this.queue.then(() => this.submit(requestId, request, nk));
    return { requestId };
  }

  private async submit(requestId: string, request: unknown, nk: string): Promise<void> {
    const { hub } = this.ctx;
    try {
      const hash = await hub.wallet!.writeContract(request as never);
      this.store.update(requestId, { state: 'submitted', txHash: hash });
      const receipt = await hub.public.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('transact reverted on-chain');
      const releases = releasesFromReceipt(receipt, this.ctx.cfg.hub.contracts.HubCore);
      const rel = releases[0];
      for (const r of releases) this.monitor.track(r);
      this.store.update(requestId, { state: 'confirmed', releaseIndex: rel?.index ?? null });
      this.relays.inc({ outcome: 'confirmed' });
      this.log.info('relayed', { requestId, tx: hash, releaseIndex: rel?.index ?? null });
    } catch (err) {
      this.store.update(requestId, { state: 'failed', error: 'submission_failed' });
      this.relays.inc({ outcome: 'failed' });
      this.log.error('relay submission failed', { requestId, err });
    } finally {
      this.inflight.delete(nk);
    }
  }

  async status(requestId: string): Promise<Pick<RequestRecord, 'txHash' | 'state' | 'releaseIndex'> & { error?: string }> {
    const rec = this.store.get(requestId);
    if (!rec) throw new HttpError(404, 'unknown_request');
    if (rec.state === 'confirmed' && rec.releaseIndex !== null && rec.dstChainId !== BigInt(this.ctx.cfg.hub.chainId) && rec.dstChainId !== 0n) {
      const spoke = spokeOf(this.ctx, rec.dstChainId);
      const st = (await spoke.clients.public.readContract({
        address: spoke.cfg.spoke,
        abi: spokeAbi,
        functionName: 'releaseState',
        args: [rec.releaseIndex],
      })) as ReleaseState;
      if (st !== ReleaseState.None) {
        this.store.update(requestId, { state: 'released' });
        rec.state = 'released';
      }
    } else if (rec.state === 'confirmed' && (rec.dstChainId === BigInt(this.ctx.cfg.hub.chainId) || rec.dstChainId === 0n)) {
      // Paid (or nothing to pay) inside transact itself.
      this.store.update(requestId, { state: 'released' });
      rec.state = 'released';
    }
    return { txHash: rec.txHash, state: rec.state, releaseIndex: rec.releaseIndex, ...(rec.error ? { error: rec.error } : {}) };
  }

  pruneMemory(): void {
    this.book.prune();
  }
}
