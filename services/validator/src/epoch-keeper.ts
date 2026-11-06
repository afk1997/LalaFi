import { SimulationError, simulateAndSend, stakeManagerAbi, type Logger, type ProtocolContext } from '@xpool/service-common';
import type { ChainView } from './chain-view.js';

/** advanceEpoch is due once epochStart(current) + epochSeconds has passed (hub block time). */
export function epochDue(epochStart: bigint, epochSeconds: bigint, blockTimestamp: bigint): boolean {
  return blockTimestamp >= epochStart + epochSeconds;
}

/** Epoch keeper (PRD 13.4): permissionless StakeManager.advanceEpoch when due. */
export class EpochKeeper {
  private readonly log: Logger;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly view: ChainView,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'epoch-keeper' });
  }

  async tick(): Promise<void> {
    const epoch = await this.view.currentEpoch();
    const start = await this.view.epochStart(epoch);
    const block = await this.ctx.hub.public.getBlock({ blockTag: 'latest' });
    if (!epochDue(start, BigInt(this.ctx.cfg.params.epochSeconds), block.timestamp)) return;
    try {
      const { hash } = await simulateAndSend(this.ctx.hub.public, this.ctx.hub.wallet!, {
        address: this.ctx.cfg.hub.contracts.StakeManager,
        abi: stakeManagerAbi,
        functionName: 'advanceEpoch',
        args: [],
      });
      this.log.info('epoch advanced', { from: epoch, tx: hash });
    } catch (err) {
      // Another validator usually wins the race (EpochNotDue): fine.
      if (!(err instanceof SimulationError)) throw err;
      this.log.debug('advanceEpoch skipped', { reason: err.errorName });
    }
  }
}
