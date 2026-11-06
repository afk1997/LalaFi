import { getAbiItem } from 'viem';
import {
  CrossCheckError,
  crossCheck,
  getLogsChunked,
  minFinalizedBlock,
  nextRange,
  spokeAbi,
  stringifyBig,
  type ChainClients,
  type L2Deposit,
  type Logger,
  type Metrics,
  type SpokeConfig,
} from '@xpool/service-common';
import { DepositConflict, type DepositStore } from './deposit-store.js';

export type ObservedDeposit = L2Deposit & { blockNumber: bigint };

/**
 * Checks that every RPC returned exactly the same deposits for the range, that they are
 * contiguous from `expectedNext`, and that every claimed l2Block is at or below the finalized
 * head. Pure, so it can be tested without chains.
 */
export function reconcileRpcViews(views: ObservedDeposit[][], expectedNext: bigint, finalized: bigint): ObservedDeposit[] {
  const enc = views.map((v) => stringifyBig(v));
  if (enc.some((e) => e !== enc[0])) throw new CrossCheckError('Deposit logs', enc.map((e) => e.slice(0, 120)));
  const deps = [...(views[0] ?? [])].sort((a, b) => (a.index < b.index ? -1 : 1));
  let next = expectedNext;
  for (const d of deps) {
    if (d.index !== next) throw new Error(`deposit logs not contiguous: expected ${next}, got ${d.index}`);
    if (d.l2Block > finalized) throw new Error(`deposit ${d.index} claims l2Block ${d.l2Block} above finalized ${finalized}`);
    next++;
  }
  return deps;
}

/**
 * Spoke watcher (PRD 13.4): tracks Deposit events at the L2 `finalized` tag, reading every RPC
 * independently and requiring identical answers, then confirms the count with depositCount() at
 * the range end on every RPC.
 */
export class SpokeWatcher {
  private readonly chain: bigint;
  private readonly log: Logger;
  private readonly head;
  private readonly alerts;

  constructor(
    private readonly spoke: { cfg: SpokeConfig; clients: ChainClients },
    private readonly store: DepositStore,
    logger: Logger,
    metrics: Metrics,
    private readonly maxSpan = 2_000n,
    /** Testnet only: sign at latest - N instead of the finalized tag (validator bears the reorg risk). */
    private readonly confirmations?: bigint,
  ) {
    this.chain = BigInt(spoke.cfg.chainId);
    this.log = logger.child({ component: 'watcher', chain: spoke.cfg.chainId });
    this.head = metrics.gauge('validator_verified_deposit_count', 'Verified finalized deposits', ['chain']);
    this.alerts = metrics.counter('validator_watch_alerts_total', 'Cross-check / finality alerts', ['chain', 'kind']);
  }

  async tick(): Promise<void> {
    if (this.store.haltedReason(this.chain)) return;
    const { clients, cfg } = this.spoke;
    const finalized =
      this.confirmations === undefined
        ? await minFinalizedBlock(clients, 'finalized')
        : (await minFinalizedBlock(clients, 'latest')) - this.confirmations;
    const range = nextRange(this.store.cursor(this.chain), cfg.deployBlock, finalized, this.maxSpan);
    if (!range) return;

    const event = getAbiItem({ abi: spokeAbi, name: 'Deposit' });
    const views = await Promise.all(
      clients.perRpc.map(async (c) => {
        const logs = await getLogsChunked(c, { address: cfg.spoke, event, fromBlock: range.from, toBlock: range.to });
        return logs.map((l) => ({
          index: l.args.index,
          ownerDigest: l.args.ownerDigest,
          amount: l.args.amount,
          fee: l.args.fee,
          l2Block: l.args.l2Block,
          blockNumber: l.blockNumber,
        }));
      }),
    );

    let deposits: ObservedDeposit[];
    try {
      deposits = reconcileRpcViews(views, this.store.nextIndex(this.chain), finalized);
      const count = await crossCheck(clients, 'depositCount', (c) =>
        c.readContract({ address: cfg.spoke, abi: spokeAbi, functionName: 'depositCount', blockNumber: range.to }),
      );
      const expected = this.store.nextIndex(this.chain) + BigInt(deposits.length);
      if (count !== expected) throw new Error(`depositCount ${count} at block ${range.to} != ${expected} from logs`);
      for (const d of deposits) {
        if (d.l2Block !== d.blockNumber) this.log.warn('deposit l2Block differs from log block', { index: d.index });
      }
      this.store.append(this.chain, deposits, range.to);
    } catch (err) {
      const kind = err instanceof CrossCheckError ? 'rpc_mismatch' : err instanceof DepositConflict ? 'finality_violation' : 'inconsistent';
      this.alerts.inc({ chain: String(cfg.chainId), kind });
      if (err instanceof DepositConflict) this.store.halt(this.chain, err.message);
      this.log.error('watcher refused range', { from: range.from, to: range.to, kind, err });
      throw err;
    }
    this.head.set({ chain: String(cfg.chainId) }, Number(this.store.nextIndex(this.chain)));
    if (deposits.length) this.log.info('verified deposits', { from: deposits[0]!.index, count: deposits.length, toBlock: range.to });
  }
}
