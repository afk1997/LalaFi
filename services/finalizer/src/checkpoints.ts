import { getAbiItem, type Hex } from 'viem';
import {
  SimulationError,
  depositManagerAbi,
  getLogsChunked,
  nextRange,
  simulateAndSend,
  spokeAbi,
  type ChainClients,
  type KvStore,
  type L2Deposit,
  type Logger,
  type Metrics,
  type ProtocolContext,
  type SpokeConfig,
} from '@xpool/service-common';
import { checkpointReason, type CheckpointHeader } from './payload.js';
import type { FinalizerSettings } from './settings.js';

/** A CheckpointSent observed on a spoke (L2 → L1 message awaiting delivery). */
export interface SentCheckpoint extends CheckpointHeader {
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number;
  delivered: boolean;
}

const pad = (n: bigint) => n.toString().padStart(20, '0');
export const sentKey = (chain: number, seq: bigint) => `sent:${chain}:${pad(seq)}`;

/** Scans a spoke's CheckpointSent events into kv (anyone may send checkpoints). */
export async function scanSentCheckpoints(spoke: { cfg: SpokeConfig; clients: ChainClients }, kv: KvStore): Promise<void> {
  const pub = spoke.clients.public;
  const head = await pub.getBlockNumber();
  const ck = `sentCursor:${spoke.cfg.chainId}`;
  const range = nextRange(kv.get<bigint>(ck), spoke.cfg.deployBlock, head, 5_000n);
  if (!range) return;
  const logs = await getLogsChunked(pub, {
    address: spoke.cfg.spoke,
    event: getAbiItem({ abi: spokeAbi, name: 'CheckpointSent' }),
    fromBlock: range.from,
    toBlock: range.to,
  });
  for (const l of logs) {
    const key = sentKey(spoke.cfg.chainId, l.args.seq);
    if (kv.get(key)) continue;
    const block = await pub.getBlock({ blockNumber: l.blockNumber });
    const rec: SentCheckpoint = {
      seq: l.args.seq,
      from: l.args.from,
      to: l.args.to,
      countAtSend: l.args.countAtSend,
      l2Block: l.args.l2Block,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      timestamp: Number(block.timestamp),
      delivered: false,
    };
    kv.set(key, rec);
  }
  kv.set(ck, range.to);
}

export function latestSent(kv: KvStore, chain: number): SentCheckpoint | undefined {
  const all = kv.list<SentCheckpoint>(`sent:${chain}:`);
  return all.length ? all[all.length - 1]![1] : undefined;
}

export interface FastMark {
  index: bigint;
  seenAtSec: number;
}

/** Absence checkpoints are only pushed for this long after a suspicious fast-lane index appears. */
export const ABSENCE_WINDOW_SEC = 86_400;

/** Highest fast-lane-inserted index per chain from hub L2DepositInserted events (cursor in kv). */
export async function scanFastInserted(ctx: ProtocolContext, kv: KvStore): Promise<void> {
  const hub = ctx.hub.public;
  const head = await hub.getBlockNumber();
  const range = nextRange(kv.get<bigint>('fastCursor'), ctx.cfg.hub.deployBlock, head, 5_000n);
  if (!range) return;
  const logs = await getLogsChunked(hub, {
    address: ctx.cfg.hub.contracts.DepositManager,
    event: getAbiItem({ abi: depositManagerAbi, name: 'L2DepositInserted' }),
    fromBlock: range.from,
    toBlock: range.to,
  });
  for (const l of logs) {
    if (!l.args.fastLane) continue;
    const k = `maxFast:${l.args.srcChainId}`;
    const cur = kv.get<FastMark>(k);
    if (cur === undefined || l.args.index > cur.index) kv.set(k, { index: l.args.index, seenAtSec: Math.floor(Date.now() / 1000) });
  }
  kv.set('fastCursor', range.to);
}

/** Calls Spoke.sendCheckpoint per the PRD 13.5 schedule. */
export class CheckpointSender {
  private readonly log: Logger;
  private readonly sent;
  private readonly backlog;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly kv: KvStore,
    private readonly s: FinalizerSettings,
    logger: Logger,
    metrics: Metrics,
  ) {
    this.log = logger.child({ component: 'checkpoint-sender' });
    this.sent = metrics.counter('finalizer_checkpoints_sent_total', 'sendCheckpoint calls', ['chain', 'reason']);
    this.backlog = metrics.gauge('finalizer_checkpoint_backlog', 'Deposits not yet in a sent checkpoint', ['chain']);
  }

  async tick(spoke: { cfg: SpokeConfig; clients: ChainClients }, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
    const read = (functionName: 'depositCount' | 'nextCheckpointFrom') =>
      spoke.clients.public.readContract({ address: spoke.cfg.spoke, abi: spokeAbi, functionName }) as Promise<bigint>;
    const [count, from] = await Promise.all([read('depositCount'), read('nextCheckpointFrom')]);
    const pending = count - from;
    this.backlog.set({ chain: String(spoke.cfg.chainId) }, Number(pending));
    const fast = this.kv.get<FastMark>(`maxFast:${spoke.cfg.chainId}`);
    const lastSentSec = latestSent(this.kv, spoke.cfg.chainId)?.timestamp ?? 0;
    const reason = checkpointReason({
      pending,
      lastSentSec,
      nowSec,
      everyN: this.s.checkpointEveryN,
      everySec: this.s.checkpointEverySec,
      // An attested index that doesn't exist yet: a fresh checkpoint lets watchers prove absence.
      absenceNeeded:
        fast !== undefined &&
        fast.index >= count &&
        nowSec - fast.seenAtSec < ABSENCE_WINDOW_SEC &&
        nowSec - lastSentSec >= this.s.checkpointEverySec,
    });
    if (!reason) return;
    try {
      const { hash } = await simulateAndSend(spoke.clients.public, spoke.clients.wallet!, {
        address: spoke.cfg.spoke,
        abi: spokeAbi,
        functionName: 'sendCheckpoint',
        args: [],
      });
      this.sent.inc({ chain: String(spoke.cfg.chainId), reason });
      this.log.info('checkpoint sent', { chain: spoke.cfg.chainId, reason, pending, tx: hash });
    } catch (err) {
      if (err instanceof SimulationError && err.errorName === 'EmptyCheckpointTooSoon') return;
      throw err;
    }
  }
}

/** Fetches the Deposit events for indices [from, to) of a spoke (indexed `index` topic filter). */
export async function fetchDeposits(spoke: { cfg: SpokeConfig; clients: ChainClients }, from: bigint, to: bigint, toBlock: bigint): Promise<L2Deposit[]> {
  if (to <= from) return [];
  const indices = [];
  for (let i = from; i < to; i++) indices.push(i);
  const logs = await getLogsChunked(spoke.clients.public, {
    address: spoke.cfg.spoke,
    event: getAbiItem({ abi: spokeAbi, name: 'Deposit' }),
    args: { index: indices },
    fromBlock: spoke.cfg.deployBlock,
    toBlock,
    chunk: 50_000n,
  });
  return logs.map((l) => ({ index: l.args.index, ownerDigest: l.args.ownerDigest, amount: l.args.amount, fee: l.args.fee, l2Block: l.args.l2Block }));
}
