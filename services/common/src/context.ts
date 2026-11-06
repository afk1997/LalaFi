import type { Account, Address, Hex } from 'viem';
import { estimateRetryable, ZERO_BRIDGE_PARAMS } from './arbitrum.js';
import { createChainClients, type ChainClients } from './clients.js';
import type { SpokeConfig, XpoolConfig } from './config.js';
import type { BridgeParams } from './types.js';

/** Clients for the hub and every spoke, optionally with a signing account. */
export interface ProtocolContext {
  cfg: XpoolConfig;
  hub: ChainClients;
  spokes: Map<number, { cfg: SpokeConfig; clients: ChainClients }>;
}

export function createProtocolContext(cfg: XpoolConfig, account?: Account): ProtocolContext {
  const opts = account ? { account, pollingIntervalMs: cfg.isLocal ? 1_000 : 4_000 } : { pollingIntervalMs: cfg.isLocal ? 1_000 : 4_000 };
  const hub = createChainClients(cfg.hub.chainId, cfg.hub.name, cfg.hub.rpc, opts);
  const spokes = new Map<number, { cfg: SpokeConfig; clients: ChainClients }>();
  for (const s of cfg.spokes) spokes.set(s.chainId, { cfg: s, clients: createChainClients(s.chainId, s.name, s.rpc, opts) });
  return { cfg, hub, spokes };
}

export function spokeOf(ctx: ProtocolContext, chainId: number | bigint) {
  const s = ctx.spokes.get(Number(chainId));
  if (!s) throw new Error(`unsupported spoke ${chainId}`);
  return s;
}

/**
 * BridgeParams + msg.value for a hub → spoke message (release or rebalance order).
 * OP Stack and the hub itself need none; Arbitrum gets a retryable estimate with margin.
 */
export async function bridgeParamsFor(
  ctx: ProtocolContext,
  dstChainId: number | bigint,
  message: Hex,
  refundAddress: Address,
  marginBps: number,
): Promise<{ bp: BridgeParams; value: bigint }> {
  if (Number(dstChainId) === ctx.cfg.hub.chainId) return { bp: ZERO_BRIDGE_PARAMS, value: 0n };
  const s = spokeOf(ctx, dstChainId);
  if (s.cfg.stack === 'opstack') return { bp: ZERO_BRIDGE_PARAMS, value: 0n };
  const inbox = s.cfg.l1.inbox;
  if (!inbox) throw new Error(`spoke ${dstChainId}: no inbox configured`);
  return estimateRetryable({
    l1: ctx.hub,
    l2: s.clients,
    inbox,
    l1Sender: s.cfg.hubAdapter,
    spoke: s.cfg.spoke,
    message,
    refundAddress,
    marginBps,
    minGasL2: BigInt(ctx.cfg.params.minGasL2),
    useNodeInterface: !ctx.cfg.isLocal,
  });
}
