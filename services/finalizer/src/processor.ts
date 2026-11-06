import { getAbiItem, parseEventLogs } from 'viem';
import {
  SimulationError,
  depositManagerAbi,
  getLogsChunked,
  nextRange,
  simulateAndSend,
  spokeAbi,
  type KvStore,
  type Logger,
  type Metrics,
  type ProtocolContext,
} from '@xpool/service-common';
import { fetchDeposits, sentKey, type SentCheckpoint } from './checkpoints.js';
import { buildCheckpointPayload, sameHeader, type CheckpointHeader } from './payload.js';

interface ReceivedCheckpoint extends CheckpointHeader {
  chainId: number;
  done: boolean;
  attempts: number;
}

const recvKey = (chain: number | bigint, seq: bigint) => `recv:${chain}:${seq.toString().padStart(20, '0')}`;

/**
 * Processes canonical checkpoints on the hub: watches CheckpointReceived / CheckpointProcessed,
 * rebuilds each payload from the spoke's events, and calls processCheckpoint in chunks.
 */
export class CheckpointProcessor {
  private readonly log: Logger;
  private readonly processed;
  private readonly backlog;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly kv: KvStore,
    private readonly chunk: bigint,
    private readonly maxAttempts: number,
    logger: Logger,
    metrics: Metrics,
  ) {
    this.log = logger.child({ component: 'processor' });
    this.processed = metrics.counter('finalizer_checkpoints_processed_total', 'processCheckpoint calls', ['chain', 'outcome']);
    this.backlog = metrics.gauge('finalizer_unprocessed_checkpoints', 'Received but unprocessed checkpoints');
  }

  async scan(): Promise<void> {
    const hub = this.ctx.hub.public;
    const head = await hub.getBlockNumber();
    const range = nextRange(this.kv.get<bigint>('recvCursor'), this.ctx.cfg.hub.deployBlock, head, 5_000n);
    if (!range) return;
    const dm = this.ctx.cfg.hub.contracts.DepositManager;
    const received = await getLogsChunked(hub, { address: dm, event: getAbiItem({ abi: depositManagerAbi, name: 'CheckpointReceived' }), fromBlock: range.from, toBlock: range.to });
    for (const l of received) {
      const k = recvKey(l.args.srcChainId, l.args.seq);
      if (this.kv.get(k)) continue;
      const rec: ReceivedCheckpoint = { chainId: Number(l.args.srcChainId), seq: l.args.seq, from: l.args.from, to: l.args.to, countAtSend: l.args.countAtSend, l2Block: l.args.l2Block, done: false, attempts: 0 };
      this.kv.set(k, rec);
      // mark the matching sent checkpoint delivered
      const sk = sentKey(rec.chainId, rec.seq);
      const sent = this.kv.get<SentCheckpoint>(sk);
      if (sent) this.kv.set(sk, { ...sent, delivered: true });
    }
    const processed = await getLogsChunked(hub, { address: dm, event: getAbiItem({ abi: depositManagerAbi, name: 'CheckpointProcessed' }), fromBlock: range.from, toBlock: range.to });
    for (const l of processed) {
      if (!l.args.done) continue;
      const k = recvKey(l.args.srcChainId, l.args.seq);
      const rec = this.kv.get<ReceivedCheckpoint>(k);
      if (rec) this.kv.set(k, { ...rec, done: true });
    }
    this.kv.set('recvCursor', range.to);
  }

  pending(): ReceivedCheckpoint[] {
    return this.kv.list<ReceivedCheckpoint>('recv:').map(([, v]) => v).filter((r) => !r.done && r.attempts < this.maxAttempts);
  }

  async processAll(): Promise<void> {
    const todo = this.pending();
    this.backlog.set(todo.length);
    for (const rec of todo) await this.process(rec);
  }

  /** Header of a spoke's CheckpointSent for `seq` (from the scanner, else directly from logs). */
  private async sentHeader(rec: ReceivedCheckpoint): Promise<{ header: CheckpointHeader; blockNumber: bigint }> {
    const cached = this.kv.get<SentCheckpoint>(sentKey(rec.chainId, rec.seq));
    if (cached) return { header: cached, blockNumber: cached.blockNumber };
    const spoke = this.ctx.spokes.get(rec.chainId)!;
    const head = await spoke.clients.public.getBlockNumber();
    const logs = await getLogsChunked(spoke.clients.public, {
      address: spoke.cfg.spoke,
      event: getAbiItem({ abi: spokeAbi, name: 'CheckpointSent' }),
      args: { seq: rec.seq },
      fromBlock: spoke.cfg.deployBlock,
      toBlock: head,
      chunk: 50_000n,
    });
    const l = logs[0];
    if (!l) throw new Error(`CheckpointSent seq ${rec.seq} not found on ${rec.chainId}`);
    return { header: { seq: l.args.seq, from: l.args.from, to: l.args.to, countAtSend: l.args.countAtSend, l2Block: l.args.l2Block }, blockNumber: l.blockNumber };
  }

  private async process(rec: ReceivedCheckpoint): Promise<void> {
    const k = recvKey(rec.chainId, rec.seq);
    const spoke = this.ctx.spokes.get(rec.chainId);
    if (!spoke) return;
    const { header, blockNumber } = await this.sentHeader(rec);
    if (!sameHeader(header, rec)) throw new Error(`CheckpointSent/Received mismatch for ${rec.chainId}:${rec.seq}`);
    const deposits = await fetchDeposits(spoke, rec.from, rec.to, blockNumber);
    const { payload } = buildCheckpointPayload(rec, deposits);
    const hub = this.ctx.hub;
    try {
      for (let i = 0; i < 1_000; i++) {
        const { receipt } = await simulateAndSend(hub.public, hub.wallet!, {
          address: this.ctx.cfg.hub.contracts.DepositManager,
          abi: depositManagerAbi,
          functionName: 'processCheckpoint',
          args: [BigInt(rec.chainId), rec.seq, payload, this.chunk],
        });
        const ev = parseEventLogs({ abi: depositManagerAbi, eventName: 'CheckpointProcessed', logs: receipt.logs })[0];
        this.processed.inc({ chain: String(rec.chainId), outcome: 'ok' });
        if (!ev || ev.args.done) break;
      }
      this.kv.set(k, { ...rec, done: true });
      this.log.info('checkpoint processed', { chain: rec.chainId, seq: rec.seq, items: rec.to - rec.from });
    } catch (err) {
      this.kv.set(k, { ...rec, attempts: rec.attempts + 1 });
      this.processed.inc({ chain: String(rec.chainId), outcome: err instanceof SimulationError ? err.errorName ?? 'revert' : 'error' });
      this.log.error('processCheckpoint failed', { chain: rec.chainId, seq: rec.seq, attempt: rec.attempts + 1, err });
    }
  }
}
