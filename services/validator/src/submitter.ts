import { concat, keccak256, type Address, type Hex } from 'viem';
import {
  SimulationError,
  depositManagerAbi,
  simulateAndSend,
  type L2Deposit,
  type Logger,
  type Metrics,
  type ProtocolContext,
  type SpokeConfig,
} from '@xpool/service-common';
import { batchValue } from './batch.js';
import type { ChainView } from './chain-view.js';
import type { GossipStore } from './gossip-store.js';
import { selectQuorum, type Candidate } from './quorum.js';

/**
 * Deterministic submission order so validators don't all race to submit the same batch:
 * signers are ranked by keccak(digest ‖ signer); rank r waits r·stagger after quorum is first seen.
 * A non-signer ranks last.
 */
export function designatedRank(digest: Hex, signers: readonly Address[], me: Address): number {
  const ranked = [...signers]
    .map((s) => ({ s: s.toLowerCase(), h: BigInt(keccak256(concat([digest, s.toLowerCase() as Hex]))) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .map((x) => x.s);
  const i = ranked.indexOf(me.toLowerCase());
  return i === -1 ? ranked.length : i;
}

/** Submitter (PRD 13.4): collect a quorum, check R1–R3 locally, call submitAttestation. */
export class Submitter {
  private readonly firstQuorumAt = new Map<string, number>();
  private readonly done = new Set<string>();
  private readonly log: Logger;
  private readonly submitted;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly spoke: SpokeConfig,
    private readonly gossip: GossipStore,
    private readonly view: ChainView,
    private readonly me: Address,
    private readonly staggerMs: number,
    logger: Logger,
    metrics: Metrics,
  ) {
    this.log = logger.child({ component: 'submitter', chain: spoke.chainId });
    this.submitted = metrics.counter('validator_batches_submitted_total', 'submitAttestation calls', ['chain', 'outcome']);
  }

  async tick(nowMs = Date.now()): Promise<void> {
    const chain = BigInt(this.spoke.chainId);
    const epoch = await this.view.currentEpoch();
    const epochs = epoch > 0n ? [epoch, epoch - 1n] : [epoch];
    const { k, theta } = await this.view.ratios();

    for (const g of this.gossip.groups(chain, epochs)) {
      if (this.done.has(g.digest)) continue;
      const ins = await Promise.all(g.batch.deposits.map((d) => this.view.inserted(chain, d.index)));
      if (ins.some(Boolean)) {
        this.done.add(g.digest);
        continue;
      }
      const candidates: Candidate[] = [];
      for (const s of g.sigs) {
        const info = await this.view.signerInfo(s.signer);
        if (!info.registered || !info.active || info.jailed) continue;
        const [stake, exposure] = await Promise.all([this.view.allocation(info.id, chain, g.batch.epoch), this.view.exposure(info.id, chain)]);
        candidates.push({ signer: s.signer, id: info.id, stake, exposure, signature: s.signature });
      }
      const amount = batchValue(g.batch.deposits);
      const totalStake = await this.view.totalAllocation(chain, g.batch.epoch);
      const q = selectQuorum(candidates, amount, { totalStake, k, theta });
      if (!q) continue;
      const { headroom } = await this.view.maxBatchValue(chain, g.batch.epoch);
      if (amount > headroom) continue;

      const first = this.firstQuorumAt.get(g.digest) ?? nowMs;
      this.firstQuorumAt.set(g.digest, first);
      const rank = designatedRank(g.digest, q.signers.map((s) => s.signer), this.me);
      if (nowMs - first < rank * this.staggerMs) continue;

      await this.submit(chain, g.digest, g.batch.epoch, g.batch.deposits, q.signers);
    }
  }

  private async submit(chain: bigint, digest: Hex, epoch: bigint, deposits: readonly L2Deposit[], signers: Candidate[]) {
    const hub = this.ctx.hub;
    try {
      const { hash } = await simulateAndSend(hub.public, hub.wallet!, {
        address: this.ctx.cfg.hub.contracts.DepositManager,
        abi: depositManagerAbi,
        functionName: 'submitAttestation',
        args: [chain, epoch, deposits, signers.map((s) => s.signer), signers.map((s) => s.signature)],
      });
      this.done.add(digest);
      this.submitted.inc({ chain: String(chain), outcome: 'ok' });
      this.log.info('batch submitted', { epoch, first: deposits[0]!.index, count: deposits.length, signers: signers.length, tx: hash });
    } catch (err) {
      const name = err instanceof SimulationError ? err.errorName : undefined;
      this.submitted.inc({ chain: String(chain), outcome: name ?? 'error' });
      if (name === 'AlreadyInserted' || name === 'BadEpoch') this.done.add(digest);
      this.log.warn('submitAttestation failed', { digest, reason: name ?? 'error', err });
    }
  }
}
