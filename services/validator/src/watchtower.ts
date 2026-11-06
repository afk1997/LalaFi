import { decodeFunctionData, getAbiItem, getAddress, type Hex } from 'viem';
import {
  BatchStatus,
  SimulationError,
  depositManagerAbi,
  getLogsChunked,
  itemHash,
  nextRange,
  simulateAndSend,
  spokeAbi,
  type KvStore,
  type L2Deposit,
  type Logger,
  type Metrics,
  type ProtocolContext,
} from '@xpool/service-common';
import type { ChainView } from './chain-view.js';
import type { DepositStore } from './deposit-store.js';
import { ingest, type IngestDeps } from './gossip.js';
import type { Equivocation, GossipStore } from './gossip-store.js';

export interface OnchainBatch {
  batchId: bigint;
  chainId: bigint;
  epoch: bigint;
  deposits: L2Deposit[];
}

export interface StoredCheckpoint {
  seq: bigint;
  countAtSend: bigint;
  l2Block: bigint;
}

export type AuditFinding =
  | { kind: 'ok' }
  | { kind: 'mismatch'; pos: number }
  | { kind: 'absence'; pos: number; seq: bigint }
  | { kind: 'absence-pending'; pos: number };

/**
 * Pure audit of one attested batch against this node's finalized view and the hub's stored
 * checkpoints. Absence (PRD 7.5): d.index ≥ cp.countAtSend and d.l2Block < cp.l2Block.
 */
export function auditBatch(
  b: OnchainBatch,
  verified: (index: bigint) => L2Deposit | undefined,
  verifiedNext: bigint,
  checkpoints: readonly StoredCheckpoint[],
): AuditFinding {
  for (let pos = 0; pos < b.deposits.length; pos++) {
    const d = b.deposits[pos]!;
    const v = verified(d.index);
    if (v) {
      if (itemHash(v) !== itemHash(d)) return { kind: 'mismatch', pos };
      continue;
    }
    if (d.index < verifiedNext) continue; // cannot happen with a contiguous store
    const cp = checkpoints.find((c) => d.index >= c.countAtSend && d.l2Block < c.l2Block);
    if (cp) return { kind: 'absence', pos, seq: cp.seq };
    return { kind: 'absence-pending', pos };
  }
  return { kind: 'ok' };
}

/** Watchtower (PRD 13.4): equivocation proofs from gossip, absence proofs from checkpoints. */
export class Watchtower {
  private readonly log: Logger;
  private readonly frauds;
  private lastCheckpointRequest = new Map<number, number>();

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly gossip: GossipStore,
    private readonly deposits: DepositStore,
    private readonly view: ChainView,
    private readonly kv: KvStore,
    private readonly ingestDeps: IngestDeps,
    logger: Logger,
    metrics: Metrics,
    private readonly checkpointRequestIntervalMs = 300_000,
  ) {
    this.log = logger.child({ component: 'watchtower' });
    this.frauds = metrics.counter('validator_fraud_events_total', 'Fraud detected / proven', ['kind', 'outcome']);
  }

  async tick(): Promise<void> {
    await this.scanBatches();
    await this.scanCheckpoints();
    await this.proveEquivocations();
    await this.auditPending();
  }

  // ------------------------------------------------------------------ equivocation
  async proveEquivocations(): Promise<void> {
    for (const e of this.gossip.pendingEquivocations()) await this.proveEquivocation(e);
  }

  private async proveEquivocation(e: Equivocation): Promise<void> {
    const a = this.gossip.get(e.digestA, e.signer);
    const b = this.gossip.get(e.digestB, e.signer);
    if (!a || !b) return this.gossip.setEquivocationStatus(e, 'moot');
    const info = await this.view.signerInfo(e.signer, 0);
    if (info.jailed) return this.gossip.setEquivocationStatus(e, 'moot');
    const posA = a.batch.deposits.findIndex((d) => d.index === e.index);
    const posB = b.batch.deposits.findIndex((d) => d.index === e.index);
    try {
      const { hash } = await simulateAndSend(this.ctx.hub.public, this.ctx.hub.wallet!, {
        address: this.ctx.cfg.hub.contracts.DepositManager,
        abi: depositManagerAbi,
        functionName: 'proveEquivocation',
        args: [e.chainId, getAddress(e.signer), a.batch.epoch, a.batch.deposits, a.signature, BigInt(posA), b.batch.epoch, b.batch.deposits, b.signature, BigInt(posB)],
      });
      this.gossip.setEquivocationStatus(e, 'proven');
      this.frauds.inc({ kind: 'equivocation', outcome: 'proven' });
      this.log.warn('equivocation proven', { signer: e.signer, chain: e.chainId, index: e.index, tx: hash });
    } catch (err) {
      this.frauds.inc({ kind: 'equivocation', outcome: 'failed' });
      this.log.error('proveEquivocation failed', { signer: e.signer, reason: err instanceof SimulationError ? err.errorName : 'error', err });
      if (err instanceof SimulationError) this.gossip.setEquivocationStatus(e, 'failed');
    }
  }

  // ------------------------------------------------------------------ on-chain batches
  /** Reads BatchAttested events, decodes the submitted batch from calldata, feeds signatures to gossip. */
  async scanBatches(): Promise<void> {
    const hub = this.ctx.hub.public;
    const head = await hub.getBlockNumber();
    const range = nextRange(this.kv.get<bigint>('batchCursor'), this.ctx.cfg.hub.deployBlock, head, 5_000n);
    if (!range) return;
    const logs = await getLogsChunked(hub, {
      address: this.ctx.cfg.hub.contracts.DepositManager,
      event: getAbiItem({ abi: depositManagerAbi, name: 'BatchAttested' }),
      fromBlock: range.from,
      toBlock: range.to,
    });
    for (const l of logs) {
      const tx = await hub.getTransaction({ hash: l.transactionHash });
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: depositManagerAbi, data: tx.input });
      } catch {
        decoded = undefined;
      }
      if (decoded?.functionName !== 'submitAttestation') {
        this.log.warn('BatchAttested from a non-direct call; cannot audit from calldata', { batchId: l.args.batchId });
        continue;
      }
      const [chainId, epoch, deps, signers, sigs] = decoded.args;
      const batch: OnchainBatch = { batchId: l.args.batchId, chainId, epoch, deposits: deps.map((d) => ({ ...d })) };
      this.kv.set(`batch:${batch.batchId.toString().padStart(20, '0')}`, batch);
      const spoke = this.ctx.spokes.get(Number(chainId));
      if (spoke) {
        await ingest(
          signers.map((s, i) => ({ batch: { srcChainId: chainId, spoke: spoke.cfg.spoke, epoch, deposits: batch.deposits }, signer: s, signature: sigs[i]! as Hex })),
          this.ingestDeps,
        );
      }
    }
    this.kv.set('batchCursor', range.to);
  }

  async scanCheckpoints(): Promise<void> {
    const hub = this.ctx.hub.public;
    const head = await hub.getBlockNumber();
    const range = nextRange(this.kv.get<bigint>('cpCursor'), this.ctx.cfg.hub.deployBlock, head, 5_000n);
    if (!range) return;
    const logs = await getLogsChunked(hub, {
      address: this.ctx.cfg.hub.contracts.DepositManager,
      event: getAbiItem({ abi: depositManagerAbi, name: 'CheckpointReceived' }),
      fromBlock: range.from,
      toBlock: range.to,
    });
    for (const l of logs) {
      const cp: StoredCheckpoint = { seq: l.args.seq, countAtSend: l.args.countAtSend, l2Block: l.args.l2Block };
      this.kv.set(`cp:${l.args.srcChainId}:${l.args.seq.toString().padStart(20, '0')}`, cp);
    }
    this.kv.set('cpCursor', range.to);
  }

  async auditPending(): Promise<void> {
    for (const [key, b] of this.kv.list<OnchainBatch>('batch:')) {
      const status = (await this.ctx.hub.public.readContract({
        address: this.ctx.cfg.hub.contracts.DepositManager,
        abi: depositManagerAbi,
        functionName: 'batchStatus',
        args: [b.batchId],
      })) as BatchStatus;
      if (status !== BatchStatus.Pending) {
        this.kv.delete(key);
        continue;
      }
      const cps = this.kv.list<StoredCheckpoint>(`cp:${b.chainId}:`).map(([, v]) => v);
      const finding = auditBatch(b, (i) => this.deposits.get(b.chainId, i), this.deposits.nextIndex(b.chainId), cps);
      if (finding.kind === 'mismatch') {
        if (!this.kv.get(`mismatch:${b.batchId}`)) {
          this.frauds.inc({ kind: 'mismatch', outcome: 'detected' });
          this.log.error('attested batch MISMATCHES finalized data; will be slashed at checkpoint processing', { batchId: b.batchId, pos: finding.pos });
          this.kv.set(`mismatch:${b.batchId}`, true);
        }
      } else if (finding.kind === 'absence') {
        await this.proveAbsence(b, finding.seq, finding.pos);
      } else if (finding.kind === 'absence-pending') {
        await this.requestCheckpoint(Number(b.chainId));
      }
    }
  }

  private async proveAbsence(b: OnchainBatch, seq: bigint, pos: number): Promise<void> {
    try {
      const { hash } = await simulateAndSend(this.ctx.hub.public, this.ctx.hub.wallet!, {
        address: this.ctx.cfg.hub.contracts.DepositManager,
        abi: depositManagerAbi,
        functionName: 'proveAbsence',
        args: [b.chainId, seq, b.batchId, b.deposits, BigInt(pos)],
      });
      this.frauds.inc({ kind: 'absence', outcome: 'proven' });
      this.log.warn('absence proven', { batchId: b.batchId, seq, pos, tx: hash });
    } catch (err) {
      this.frauds.inc({ kind: 'absence', outcome: 'failed' });
      this.log.error('proveAbsence failed', { batchId: b.batchId, reason: err instanceof SimulationError ? err.errorName : 'error', err });
    }
  }

  /** Asks the spoke for a (possibly empty) checkpoint so absence becomes provable. */
  private async requestCheckpoint(chainId: number, nowMs = Date.now()): Promise<void> {
    if (nowMs - (this.lastCheckpointRequest.get(chainId) ?? 0) < this.checkpointRequestIntervalMs) return;
    this.lastCheckpointRequest.set(chainId, nowMs);
    const s = this.ctx.spokes.get(chainId);
    if (!s?.clients.wallet) return;
    try {
      const { hash } = await simulateAndSend(s.clients.public, s.clients.wallet, { address: s.cfg.spoke, abi: spokeAbi, functionName: 'sendCheckpoint', args: [] });
      this.log.info('requested checkpoint for absence proof', { chainId, tx: hash });
    } catch (err) {
      this.log.debug('sendCheckpoint not possible yet', { chainId, reason: err instanceof SimulationError ? err.errorName : 'error' });
    }
  }
}
