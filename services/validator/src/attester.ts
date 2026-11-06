import {
  itemHash,
  type DepositBatch,
  type L2Deposit,
  type Logger,
  type Metrics,
  type SpokeConfig,
} from '@xpool/service-common';
import { assertBatchShape, type AttestationSigner } from './attestation-signer.js';
import { batchValue, buildBatches, isEligible, type BatchPolicy } from './batch.js';
import type { ChainView } from './chain-view.js';
import type { DepositStore } from './deposit-store.js';
import type { GossipClient } from './gossip.js';
import type { GossipStore } from './gossip-store.js';
import { EquivocationRefused } from './slashing-db.js';

/**
 * A peer-proposed batch is co-signed only if every deposit is byte-identical to what THIS node
 * verified at finality, is eligible and not yet inserted, and the batch fits current capacity.
 */
export function canCoSign(
  batch: DepositBatch,
  verified: (index: bigint) => L2Deposit | undefined,
  inserted: ReadonlySet<bigint>,
  policy: BatchPolicy,
): boolean {
  try {
    assertBatchShape(batch);
  } catch {
    return false;
  }
  if (batchValue(batch.deposits) > policy.maxBatchValue) return false;
  return batch.deposits.every((d) => {
    const v = verified(d.index);
    return !!v && itemHash(v) === itemHash(d) && isEligible(d, policy) && !inserted.has(d.index);
  });
}

/** Attester (PRD 13.4): builds and signs batches of verified, uninserted deposits; co-signs peers'. */
export class Attester {
  private readonly firstUninserted = new Map<number, bigint>();
  private readonly log: Logger;
  private readonly signed;
  private readonly refused;
  private readonly capacityGauge;

  constructor(
    private readonly spoke: SpokeConfig,
    private readonly deposits: DepositStore,
    private readonly gossip: GossipStore,
    private readonly signer: AttestationSigner,
    private readonly view: ChainView,
    private readonly client: GossipClient,
    logger: Logger,
    metrics: Metrics,
    private readonly lookahead = 128,
  ) {
    this.log = logger.child({ component: 'attester', chain: spoke.chainId });
    this.signed = metrics.counter('validator_batches_signed_total', 'Batches signed', ['chain', 'kind']);
    this.refused = metrics.counter('validator_sign_refused_total', 'Signatures refused by slashing protection', ['chain']);
    this.capacityGauge = metrics.gauge('validator_fast_lane_capacity', 'Max batch value (min of R2/R3 capacity and valve headroom)', ['chain']);
  }

  /** Lowest index that might still be uninserted (cached, advanced as deposits get inserted). */
  lowestUninserted(): bigint {
    return this.firstUninserted.get(this.spoke.chainId) ?? 0n;
  }

  private async insertedWindow(chain: bigint): Promise<{ candidates: L2Deposit[]; inserted: Set<bigint> }> {
    let from = this.lowestUninserted();
    let candidates = this.deposits.range(chain, from, this.lookahead);
    // Advance past the inserted prefix.
    while (candidates.length && (await this.view.inserted(chain, candidates[0]!.index))) {
      from = candidates[0]!.index + 1n;
      candidates = candidates.slice(1);
    }
    this.firstUninserted.set(this.spoke.chainId, from);
    const inserted = new Set<bigint>();
    for (const d of candidates.slice(0, 64)) if (await this.view.inserted(chain, d.index)) inserted.add(d.index);
    return { candidates: candidates.slice(0, 64), inserted };
  }

  async tick(): Promise<void> {
    const chain = BigInt(this.spoke.chainId);
    await this.client.pull(chain, this.lowestUninserted());
    if (this.deposits.haltedReason(chain)) return;

    const epoch = await this.view.currentEpoch();
    const me = await this.view.signerInfo(this.signer.address);
    if (!me.registered || !me.active || me.jailed) return;
    if ((await this.view.allocation(me.id, chain, epoch)) === 0n) return;

    const limits = await this.view.depositLimits();
    const { capacity, headroom } = await this.view.maxBatchValue(chain, epoch);
    const maxBatchValue = capacity < headroom ? capacity : headroom;
    this.capacityGauge.set({ chain: String(this.spoke.chainId) }, Number(maxBatchValue));
    const policy: BatchPolicy = { ...limits, maxBatchValue };

    const { candidates, inserted } = await this.insertedWindow(chain);
    const fresh = [];

    const own = buildBatches(candidates, inserted, policy)[0];
    if (own) {
      const a = await this.trySign({ srcChainId: chain, spoke: this.spoke.spoke, epoch, deposits: own }, 'own');
      if (a) fresh.push(a);
    }

    for (const g of this.gossip.groups(chain, [epoch])) {
      if (g.sigs.some((s) => s.signer.toLowerCase() === this.signer.address.toLowerCase())) continue;
      if (!canCoSign(g.batch, (i) => this.deposits.get(chain, i), inserted, policy)) continue;
      if (g.batch.deposits[0]!.index < this.lowestUninserted()) continue;
      const a = await this.trySign(g.batch, 'cosign');
      if (a) fresh.push(a);
    }
    await this.client.push(fresh);
  }

  private async trySign(batch: DepositBatch, kind: 'own' | 'cosign') {
    try {
      const a = await this.signer.sign(batch);
      const { isNew } = this.gossip.add(a, a.digest);
      if (!isNew) return undefined;
      this.signed.inc({ chain: String(this.spoke.chainId), kind });
      this.log.info('signed batch', { kind, epoch: batch.epoch, first: batch.deposits[0]!.index, count: batch.deposits.length });
      return a;
    } catch (err) {
      if (err instanceof EquivocationRefused) {
        this.refused.inc({ chain: String(this.spoke.chainId) });
        this.log.error('slashing protection refused a signature', { index: err.index, kind });
        return undefined;
      }
      throw err;
    }
  }
}
