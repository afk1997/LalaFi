import { getAbiItem, parseEventLogs, type Hex } from 'viem';
import { finalizeWithdrawal, getGame, getWithdrawalStatus, getWithdrawals, buildProveWithdrawal, proveWithdrawal } from 'viem/op-stack';
import {
  ARB_SYS,
  arbBridgeAbi,
  arbOutboxAbi,
  arbRollupAbi,
  arbSysAbi,
  getLogsChunked,
  nodeInterfaceAbi,
  NODE_INTERFACE,
  simulateAndSend,
  type ChainClients,
  type Logger,
  type ProtocolContext,
  type SpokeConfig,
} from '@xpool/service-common';
import type { SentCheckpoint } from './checkpoints.js';

/** Result of one non-blocking delivery step for an L2 → L1 checkpoint message. */
export type DeliveryStep = 'delivered' | 'waiting' | 'acted';

export interface Delivery {
  step(cp: SentCheckpoint): Promise<DeliveryStep>;
}

type Spoke = { cfg: SpokeConfig; clients: ChainClients };

/** Local: the mock-bridge relays; the finalizer only waits for CheckpointReceived. */
export class LocalDelivery implements Delivery {
  async step(): Promise<DeliveryStep> {
    return 'waiting';
  }
}

/**
 * OP Stack (Base): prove once a dispute game covers the L2 block, then finalize after the proof
 * maturity delay (viem/op-stack). Uses viem's chain definition (portal + disputeGameFactory).
 */
export class OpStackDelivery implements Delivery {
  private readonly log: Logger;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly spoke: Spoke,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'op-delivery', chain: spoke.cfg.chainId });
    const portal = (spoke.clients.chain.contracts as Record<string, Record<number, { address: string }>> | undefined)?.portal?.[ctx.cfg.hub.chainId]?.address;
    const cfgPortal = spoke.cfg.l1.optimismPortal;
    if (!portal) this.log.warn('chain definition has no OptimismPortal for the hub; proving will fail');
    else if (cfgPortal && portal.toLowerCase() !== cfgPortal.toLowerCase()) this.log.error('config optimismPortal differs from viem chain definition', { portal, cfgPortal });
  }

  async step(cp: SentCheckpoint): Promise<DeliveryStep> {
    const l1 = this.ctx.hub;
    const l2 = this.spoke.clients;
    const targetChain = l2.chain as never;
    const receipt = await l2.public.getTransactionReceipt({ hash: cp.txHash });
    const status = await getWithdrawalStatus(l1.public as never, { receipt, targetChain } as never);
    if (status === 'finalized') return 'delivered';
    if (status === 'waiting-to-prove' || status === 'waiting-to-finalize') return 'waiting';
    const [withdrawal] = getWithdrawals({ logs: receipt.logs });
    if (!withdrawal) throw new Error(`no withdrawal in checkpoint tx ${cp.txHash}`);
    if (status === 'ready-to-prove') {
      const game = await getGame(l1.public as never, { l2BlockNumber: receipt.blockNumber, targetChain } as never);
      const args = await buildProveWithdrawal(l2.public as never, { withdrawal, game } as never);
      const hash = await proveWithdrawal(l1.wallet! as never, { ...(args as object), account: l1.wallet!.account, targetChain } as never);
      await l1.public.waitForTransactionReceipt({ hash });
      this.log.info('checkpoint withdrawal proven', { seq: cp.seq, tx: hash });
      return 'acted';
    }
    // ready-to-finalize
    const hash = await finalizeWithdrawal(l1.wallet! as never, { withdrawal, targetChain, account: l1.wallet!.account } as never);
    await l1.public.waitForTransactionReceipt({ hash });
    this.log.info('checkpoint withdrawal finalized', { seq: cp.seq, tx: hash });
    return 'acted';
  }
}

/**
 * Arbitrum: once an assertion confirming the L2→L1 send is confirmed on L1, build the outbox
 * proof with NodeInterface.constructOutboxProof and call Outbox.executeTransaction.
 * TODO(xpool): verify against Arbitrum Sepolia (BoLD) once deployed; pre-BoLD rollups emit NodeConfirmed.
 */
export class ArbitrumDelivery implements Delivery {
  private readonly log: Logger;
  private confirmed?: { at: number; sendCount: bigint };

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly spoke: Spoke,
    private readonly lookbackBlocks: bigint,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'arb-delivery', chain: spoke.cfg.chainId });
  }

  /** sendCount of the latest confirmed assertion (cached for a minute). */
  private async confirmedSendCount(): Promise<bigint | undefined> {
    if (this.confirmed && Date.now() - this.confirmed.at < 60_000) return this.confirmed.sendCount;
    const l1 = this.ctx.hub.public;
    const bridge = this.spoke.cfg.l1.bridge!;
    const rollup = await l1.readContract({ address: bridge, abi: arbBridgeAbi, functionName: 'rollup' });
    const assertionHash = await l1.readContract({ address: rollup, abi: arbRollupAbi, functionName: 'latestConfirmed' });
    const head = await l1.getBlockNumber();
    const logs = await getLogsChunked(l1, {
      address: rollup,
      event: getAbiItem({ abi: arbRollupAbi, name: 'AssertionConfirmed' }),
      args: { assertionHash },
      fromBlock: head > this.lookbackBlocks ? head - this.lookbackBlocks : 0n,
      toBlock: head,
      chunk: 10_000n,
    });
    const last = logs[logs.length - 1];
    if (!last) return undefined;
    const block = (await this.spoke.clients.public.request({
      method: 'eth_getBlockByHash',
      params: [last.args.blockHash, false],
    } as never)) as { sendCount?: Hex } | null;
    if (!block?.sendCount) return undefined;
    this.confirmed = { at: Date.now(), sendCount: BigInt(block.sendCount) };
    return this.confirmed.sendCount;
  }

  async step(cp: SentCheckpoint): Promise<DeliveryStep> {
    const l1 = this.ctx.hub;
    const l2 = this.spoke.clients.public;
    const receipt = await l2.getTransactionReceipt({ hash: cp.txHash });
    const ev = parseEventLogs({ abi: arbSysAbi, eventName: 'L2ToL1Tx', logs: receipt.logs }).find(
      (l) => l.address.toLowerCase() === ARB_SYS.toLowerCase() && l.args.destination.toLowerCase() === this.spoke.cfg.hubAdapter.toLowerCase(),
    );
    if (!ev) throw new Error(`no L2ToL1Tx to the hub adapter in ${cp.txHash}`);
    const outbox = this.spoke.cfg.l1.outbox!;
    const spent = await l1.public.readContract({ address: outbox, abi: arbOutboxAbi, functionName: 'isSpent', args: [ev.args.position] });
    if (spent) return 'delivered';
    const sendCount = await this.confirmedSendCount();
    if (sendCount === undefined || sendCount <= ev.args.position) return 'waiting';
    const [, , proof] = await l2.readContract({
      address: NODE_INTERFACE,
      abi: nodeInterfaceAbi,
      functionName: 'constructOutboxProof',
      args: [sendCount, ev.args.position],
    });
    const a = ev.args;
    const { hash } = await simulateAndSend(l1.public, l1.wallet!, {
      address: outbox,
      abi: arbOutboxAbi,
      functionName: 'executeTransaction',
      args: [proof, a.position, a.caller, a.destination, a.arbBlockNum, a.ethBlockNum, a.timestamp, a.callvalue, a.data],
    });
    this.log.info('checkpoint executed on outbox', { seq: cp.seq, position: a.position, tx: hash });
    return 'acted';
  }
}

export function deliveryFor(ctx: ProtocolContext, spoke: Spoke, lookbackBlocks: bigint, logger: Logger): Delivery {
  if (ctx.cfg.isLocal) return new LocalDelivery();
  return spoke.cfg.stack === 'opstack' ? new OpStackDelivery(ctx, spoke, logger) : new ArbitrumDelivery(ctx, spoke, lookbackBlocks, logger);
}
