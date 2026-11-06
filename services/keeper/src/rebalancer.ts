import type { Address, Hex } from 'viem';
import {
  CCTP_FINALITY_STANDARD,
  SimulationError,
  bridgeParamsFor,
  encodeRebalanceMessage,
  liquidityManagerAbi,
  simulateAndSend,
  spokeAbi,
  type Logger,
  type Metrics,
  type ProtocolContext,
} from '@xpool/service-common';
import { computeTargets, planRebalance } from './policy.js';

/** Polls L[c] and the targets and calls LiquidityManager.rebalance when PRD 11.3 allows. */
export class Rebalancer {
  private readonly log: Logger;
  private readonly moves;
  private readonly liquidity;
  private readonly targetGauge;
  private lastMoveMs = 0;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly marginBps: number,
    private readonly cooldownMs: number,
    logger: Logger,
    metrics: Metrics,
  ) {
    this.log = logger.child({ component: 'rebalancer' });
    this.moves = metrics.counter('keeper_rebalances_total', 'rebalance calls', ['src', 'dst', 'outcome']);
    this.liquidity = metrics.gauge('keeper_liquidity_available', 'L[c]', ['chain']);
    this.targetGauge = metrics.gauge('keeper_liquidity_target', 'target[c]', ['chain']);
  }

  private get chains(): bigint[] {
    return [this.ctx.cfg.hub.chainId, ...this.ctx.cfg.spokes.map((s) => s.chainId)].map(BigInt);
  }

  private read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.ctx.hub.public.readContract({ address: this.ctx.cfg.hub.contracts.LiquidityManager, abi: liquidityManagerAbi, functionName, args } as never) as Promise<T>;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    const available = new Map<bigint, bigint>();
    const target = new Map<bigint, bigint>();
    const bps = new Map<bigint, bigint>();
    for (const c of this.chains) {
      const [a, t, b] = await Promise.all([this.read<bigint>('available', [c]), this.read<bigint>('target', [c]), this.read<bigint>('targetBps', [c])]);
      available.set(c, a);
      target.set(c, t);
      bps.set(c, b);
      this.liquidity.set({ chain: String(c) }, Number(a));
      this.targetGauge.set({ chain: String(c) }, Number(t));
    }
    const computed = computeTargets(available, bps);
    for (const c of this.chains) {
      if (computed.get(c) !== target.get(c)) this.log.warn('off-chain target differs from LiquidityManager.target', { chain: c, offchain: computed.get(c), onchain: target.get(c) });
    }
    if (nowMs - this.lastMoveMs < this.cooldownMs) return;

    const move = planRebalance({ available, target, minRebalance: this.ctx.cfg.params.minRebalance });
    if (!move) return;

    const { bp, value } = await this.bridgeParams(move.src, move.dst, move.amount);
    const labels = { src: String(move.src), dst: String(move.dst) };
    try {
      const { hash } = await simulateAndSend(this.ctx.hub.public, this.ctx.hub.wallet!, {
        address: this.ctx.cfg.hub.contracts.LiquidityManager,
        abi: liquidityManagerAbi,
        functionName: 'rebalance',
        args: [move.src, move.dst, move.amount, bp],
        value,
      });
      this.lastMoveMs = nowMs;
      this.moves.inc({ ...labels, outcome: 'ok' });
      this.log.info('rebalanced', { ...move, tx: hash });
    } catch (err) {
      this.moves.inc({ ...labels, outcome: err instanceof SimulationError ? err.errorName ?? 'revert' : 'error' });
      this.log.warn('rebalance failed', { ...move, err });
    }
  }

  /** src = hub burns directly; src = spoke needs MSG_REBALANCE delivered (Arbitrum: retryable ETH). */
  private async bridgeParams(src: bigint, dst: bigint, amount: bigint) {
    const nonce = await this.read<bigint>('rebalanceNonce', []);
    const message = encodeRebalanceMessage({
      amount,
      dstDomain: this.domainOf(dst),
      mintRecipient: `0x${'11'.repeat(32)}` as Hex, // representative: same size as the real order
      maxFee: 0n,
      minFinality: CCTP_FINALITY_STANDARD,
      nonce,
    });
    return bridgeParamsFor(this.ctx, src, message, this.ctx.hub.wallet!.account.address as Address, this.marginBps);
  }

  private domainOf(chain: bigint): number {
    if (Number(chain) === this.ctx.cfg.hub.chainId) return this.ctx.cfg.hub.cctp.domain;
    return this.ctx.spokes.get(Number(chain))!.cfg.cctp.domain;
  }
}

/** Calls Spoke.processQueue when releases are queued and the spoke's USDC balance changed. */
export class QueueProcessor {
  private readonly lastBalance = new Map<number, bigint>();
  private readonly log: Logger;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly maxItems: bigint,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'queue' });
  }

  async tick(): Promise<void> {
    for (const s of this.ctx.spokes.values()) {
      const pub = s.clients.public;
      const queued = (await pub.readContract({ address: s.cfg.spoke, abi: spokeAbi, functionName: 'queueLength' })) as bigint;
      if (queued === 0n) continue;
      const bal = (await pub.readContract({
        address: s.cfg.usdc,
        abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [s.cfg.spoke],
      })) as bigint;
      if (this.lastBalance.get(s.cfg.chainId) === bal) continue;
      try {
        const { hash } = await simulateAndSend(pub, s.clients.wallet!, { address: s.cfg.spoke, abi: spokeAbi, functionName: 'processQueue', args: [this.maxItems] });
        this.log.info('processQueue', { chain: s.cfg.chainId, queued, tx: hash });
      } catch (err) {
        this.log.warn('processQueue failed', { chain: s.cfg.chainId, err });
      }
      this.lastBalance.set(s.cfg.chainId, bal);
    }
  }
}
