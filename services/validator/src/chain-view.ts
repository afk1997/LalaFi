import type { Address } from 'viem';
import {
  depositManagerAbi,
  liquidityManagerAbi,
  stakeManagerAbi,
  type ProtocolContext,
} from '@xpool/service-common';
import { fastCapacity, valveHeadroom, type Ratio } from './quorum.js';

export interface SignerInfo {
  id: number;
  registered: boolean;
  active: boolean;
  jailed: boolean;
}

/** Cached reads of hub state needed by the validator. */
export class ChainView {
  private readonly signerCache = new Map<string, { at: number; info: SignerInfo }>();
  private kCache?: { k: Ratio; theta: Ratio };
  private limits?: { at: number; minDeposit: bigint; maxFastDeposit: bigint };

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly ttlMs = 30_000,
  ) {}

  private get c() {
    return this.ctx.cfg.hub.contracts;
  }

  private read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.ctx.hub.public.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  }

  currentEpoch(): Promise<bigint> {
    return this.read(this.c.StakeManager, stakeManagerAbi, 'currentEpoch');
  }

  epochStart(epoch: bigint): Promise<bigint> {
    return this.read(this.c.StakeManager, stakeManagerAbi, 'epochStart', [epoch]);
  }

  /** Registration status of a signer key (registered iff signerOf(id) == signer). */
  async signerInfo(signer: Address, now = Date.now()): Promise<SignerInfo> {
    const key = signer.toLowerCase();
    const hit = this.signerCache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.info;
    const [id, active, jailed] = await this.read<readonly [number, boolean, boolean]>(this.c.StakeManager, stakeManagerAbi, 'validatorBySigner', [signer]);
    const registeredSigner = await this.read<Address>(this.c.StakeManager, stakeManagerAbi, 'signerOf', [id]);
    const info = { id: Number(id), registered: registeredSigner.toLowerCase() === key, active, jailed };
    this.signerCache.set(key, { at: now, info });
    return info;
  }

  async ratios(): Promise<{ k: Ratio; theta: Ratio }> {
    if (this.kCache) return this.kCache;
    const [k, theta] = await Promise.all([
      this.read<readonly [bigint, bigint]>(this.c.StakeManager, stakeManagerAbi, 'k'),
      this.read<readonly [bigint, bigint]>(this.c.StakeManager, stakeManagerAbi, 'theta'),
    ]);
    this.kCache = { k: [k[0], k[1]], theta: [theta[0], theta[1]] };
    return this.kCache;
  }

  allocation(id: number, chain: bigint, epoch: bigint): Promise<bigint> {
    return this.read(this.c.StakeManager, stakeManagerAbi, 'allocation', [id, chain, epoch]);
  }

  totalAllocation(chain: bigint, epoch: bigint): Promise<bigint> {
    return this.read(this.c.StakeManager, stakeManagerAbi, 'totalAllocation', [chain, epoch]);
  }

  exposure(id: number, chain: bigint): Promise<bigint> {
    return this.read(this.c.StakeManager, stakeManagerAbi, 'exposure', [id, chain]);
  }

  activeValidators(): Promise<readonly number[]> {
    return this.read(this.c.StakeManager, stakeManagerAbi, 'activeValidators');
  }

  inserted(chain: bigint, index: bigint): Promise<boolean> {
    return this.read(this.c.DepositManager, depositManagerAbi, 'inserted', [chain, index]);
  }

  async depositLimits(now = Date.now()): Promise<{ minDeposit: bigint; maxFastDeposit: bigint }> {
    if (this.limits && now - this.limits.at < this.ttlMs) return this.limits;
    const [minDeposit, maxFastDeposit] = await Promise.all([
      this.read<bigint>(this.c.DepositManager, depositManagerAbi, 'minDeposit'),
      this.read<bigint>(this.c.DepositManager, depositManagerAbi, 'maxFastDeposit'),
    ]);
    this.limits = { at: now, minDeposit, maxFastDeposit };
    return this.limits;
  }

  /** Max batch value now: min(capacity of the active set under R2/R3, safety-valve headroom). */
  async maxBatchValue(chain: bigint, epoch: bigint): Promise<{ capacity: bigint; headroom: bigint }> {
    const { k } = await this.ratios();
    const ids = await this.activeValidators();
    const vs = await Promise.all(
      ids.map(async (id) => ({ stake: await this.allocation(id, chain, epoch), exposure: await this.exposure(id, chain) })),
    );
    const [unconfirmed, lp, ins] = await Promise.all([
      this.read<bigint>(this.c.DepositManager, depositManagerAbi, 'unconfirmedFastValue'),
      this.read<bigint>(this.c.LiquidityManager, liquidityManagerAbi, 'lpAssets'),
      this.read<bigint>(this.c.LiquidityManager, liquidityManagerAbi, 'insurance'),
    ]);
    return { capacity: fastCapacity(vs, k), headroom: valveHeadroom(unconfirmed, lp, ins, this.ctx.cfg.params.beta) };
  }
}
