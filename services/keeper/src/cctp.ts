import { getAbiItem, type Hex } from 'viem';
import {
  SimulationError,
  chainIdForDomain,
  getLogsChunked,
  liquidityManagerAbi,
  messageTransmitterV2Abi,
  nextRange,
  simulateAndSend,
  spokeAbi,
  type ChainClients,
  type KvStore,
  type Logger,
  type Metrics,
  type ProtocolContext,
} from '@xpool/service-common';
import { fetchIris } from './iris.js';

export interface PendingBurn {
  srcChainId: number;
  srcDomain: number;
  dstChainId: number;
  txHash: Hex;
  seenAtMs: number;
  done: boolean;
}

/**
 * CCTP mint completion (PRD 8.6 step 3): discover rebalance burns (hub Rebalanced with src = hub;
 * spoke RebalanceBurn), fetch the attestation from Iris, call receiveMessage on the destination.
 * Same code path on local (mock Iris served by mock-bridge) and testnet/mainnet.
 */
export class CctpCompleter {
  private readonly log: Logger;
  private readonly minted;
  private readonly inflight;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly kv: KvStore,
    private readonly irisBase: string,
    logger: Logger,
    metrics: Metrics,
  ) {
    this.log = logger.child({ component: 'cctp' });
    this.minted = metrics.counter('keeper_cctp_mints_total', 'receiveMessage calls', ['dst', 'outcome']);
    this.inflight = metrics.gauge('keeper_cctp_inflight', 'Burns awaiting mint');
  }

  private clientsFor(chainId: number): ChainClients | undefined {
    return chainId === this.ctx.cfg.hub.chainId ? this.ctx.hub : this.ctx.spokes.get(chainId)?.clients;
  }

  private transmitterFor(chainId: number): Hex {
    return chainId === this.ctx.cfg.hub.chainId ? this.ctx.cfg.hub.cctp.messageTransmitterV2 : this.ctx.spokes.get(chainId)!.cfg.cctp.messageTransmitterV2;
  }

  private record(b: Omit<PendingBurn, 'seenAtMs' | 'done'>) {
    const k = `burn:${b.srcChainId}:${b.txHash}`;
    if (!this.kv.get(k)) this.kv.set(k, { ...b, seenAtMs: Date.now(), done: false } satisfies PendingBurn);
  }

  async discover(): Promise<void> {
    const hubId = this.ctx.cfg.hub.chainId;
    // hub-originated burns
    const hub = this.ctx.hub.public;
    const hHead = await hub.getBlockNumber();
    const hr = nextRange(this.kv.get<bigint>('cursor:hub'), this.ctx.cfg.hub.deployBlock, hHead, 5_000n);
    if (hr) {
      const logs = await getLogsChunked(hub, {
        address: this.ctx.cfg.hub.contracts.LiquidityManager,
        event: getAbiItem({ abi: liquidityManagerAbi, name: 'Rebalanced' }),
        fromBlock: hr.from,
        toBlock: hr.to,
      });
      for (const l of logs) {
        if (Number(l.args.srcChainId) !== hubId) continue;
        this.record({ srcChainId: hubId, srcDomain: this.ctx.cfg.hub.cctp.domain, dstChainId: Number(l.args.dstChainId), txHash: l.transactionHash });
      }
      this.kv.set('cursor:hub', hr.to);
    }
    // spoke-originated burns
    for (const s of this.ctx.spokes.values()) {
      const pub = s.clients.public;
      const head = await pub.getBlockNumber();
      const ck = `cursor:${s.cfg.chainId}`;
      const r = nextRange(this.kv.get<bigint>(ck), s.cfg.deployBlock, head, 5_000n);
      if (!r) continue;
      const logs = await getLogsChunked(pub, { address: s.cfg.spoke, event: getAbiItem({ abi: spokeAbi, name: 'RebalanceBurn' }), fromBlock: r.from, toBlock: r.to });
      for (const l of logs) {
        const dst = chainIdForDomain(this.ctx.cfg, l.args.dstDomain);
        if (dst === undefined) {
          this.log.error('RebalanceBurn to unknown CCTP domain', { domain: l.args.dstDomain });
          continue;
        }
        this.record({ srcChainId: s.cfg.chainId, srcDomain: s.cfg.cctp.domain, dstChainId: dst, txHash: l.transactionHash });
      }
      this.kv.set(ck, r.to);
    }
  }

  async complete(): Promise<void> {
    const pending = this.kv.list<PendingBurn>('burn:').filter(([, b]) => !b.done);
    this.inflight.set(pending.length);
    for (const [key, b] of pending) {
      const { complete, pending: waiting } = await fetchIris(this.irisBase, b.srcDomain, b.txHash);
      if (!complete.length || waiting) continue;
      const dst = this.clientsFor(b.dstChainId);
      if (!dst?.wallet) throw new Error(`no wallet for chain ${b.dstChainId}`);
      let allDone = true;
      for (const m of complete) {
        try {
          const { hash } = await simulateAndSend(dst.public, dst.wallet, {
            address: this.transmitterFor(b.dstChainId),
            abi: messageTransmitterV2Abi,
            functionName: 'receiveMessage',
            args: [m.message, m.attestation],
          });
          this.minted.inc({ dst: String(b.dstChainId), outcome: 'ok' });
          this.log.info('CCTP mint completed', { src: b.srcChainId, dst: b.dstChainId, tx: hash });
        } catch (err) {
          const reason = err instanceof SimulationError ? `${err.errorName ?? ''} ${err.message}` : '';
          if (/nonce/i.test(reason)) {
            this.minted.inc({ dst: String(b.dstChainId), outcome: 'already' });
            continue; // someone else completed it
          }
          allDone = false;
          this.minted.inc({ dst: String(b.dstChainId), outcome: 'error' });
          this.log.warn('receiveMessage failed', { src: b.srcChainId, dst: b.dstChainId, err });
        }
      }
      if (allDone) this.kv.set(key, { ...b, done: true });
    }
  }
}
