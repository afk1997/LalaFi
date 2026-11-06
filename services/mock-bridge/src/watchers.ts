import { getAbiItem, type Address, type Hex } from 'viem';
import {
  ARB_SYS,
  getLogsChunked,
  mockArbSysAbi,
  mockInboxAbi,
  mockMessengerAbi,
  mockTokenMessengerAbi,
  nextRange,
  type ChainClients,
  type KvStore,
  type XpoolConfig,
} from '@xpool/service-common';
import type { Delivery } from './queue.js';

/** LOCAL ONLY. Scans mock bridge contracts for messages to relay. */

export interface Observed {
  key: string;
  delivery: Delivery;
}

export interface Source {
  name: string;
  clients: ChainClients;
  startBlock: bigint;
  scan(from: bigint, to: bigint): Promise<Observed[]>;
}

const keyOf = (route: string, tx: Hex, logIndex: number) => `${route}:${tx}:${logIndex}`;

function mock(cfg: XpoolConfig, chainId: number, name: string): Address {
  const a = cfg.mockContracts[String(chainId)]?.[name];
  if (!a) throw new Error(`deployments.mocks.${chainId}.${name} missing`);
  return a;
}

/** Picks the OP-style spoke an L1 message targets (by spoke address; the only one as fallback). */
export function opDestination(cfg: XpoolConfig, target: Address): number | undefined {
  const ops = cfg.spokes.filter((s) => s.stack === 'opstack');
  return ops.find((s) => s.spoke.toLowerCase() === target.toLowerCase())?.chainId ?? (ops.length === 1 ? ops[0]!.chainId : undefined);
}

export function buildSources(cfg: XpoolConfig, hub: ChainClients, spokes: Map<number, ChainClients>): Source[] {
  const sources: Source[] = [];
  const hubStart = cfg.hub.deployBlock;
  const opSpokes = cfg.spokes.filter((s) => s.stack === 'opstack');
  const arbSpokes = cfg.spokes.filter((s) => s.stack === 'arbitrum');

  if (opSpokes.length) {
    const l1Messenger = mock(cfg, cfg.hub.chainId, 'MockL1CrossDomainMessenger');
    sources.push({
      name: 'op-l1-to-l2',
      clients: hub,
      startBlock: hubStart,
      async scan(from, to) {
        const logs = await getLogsChunked(hub.public, { address: l1Messenger, event: getAbiItem({ abi: mockMessengerAbi, name: 'SentMessage' }), fromBlock: from, toBlock: to });
        return logs.flatMap((l) => {
          const dst = opDestination(cfg, l.args.target);
          if (dst === undefined) return [];
          const a = l.args;
          return [{ key: keyOf('op-l1-to-l2', l.transactionHash, l.logIndex), delivery: { route: 'op-l1-to-l2', dstChainId: dst, nonce: a.messageNonce, sender: a.sender, target: a.target, message: a.message, gasLimit: a.gasLimit } }];
        });
      },
    });
  }
  for (const s of opSpokes) {
    const c = spokes.get(s.chainId)!;
    const l2Messenger = mock(cfg, s.chainId, 'MockL2CrossDomainMessenger');
    sources.push({
      name: `op-l2-to-l1:${s.chainId}`,
      clients: c,
      startBlock: s.deployBlock,
      async scan(from, to) {
        const logs = await getLogsChunked(c.public, { address: l2Messenger, event: getAbiItem({ abi: mockMessengerAbi, name: 'SentMessage' }), fromBlock: from, toBlock: to });
        return logs.map((l) => {
          const a = l.args;
          return { key: keyOf(`op-l2-to-l1:${s.chainId}`, l.transactionHash, l.logIndex), delivery: { route: 'op-l2-to-l1', dstChainId: cfg.hub.chainId, nonce: a.messageNonce, sender: a.sender, target: a.target, message: a.message, gasLimit: a.gasLimit } };
        });
      },
    });
  }
  if (arbSpokes.length) {
    const inbox = mock(cfg, cfg.hub.chainId, 'MockInbox');
    const arb = arbSpokes[0]!; // one Arbitrum-style spoke locally
    sources.push({
      name: 'arb-l1-to-l2',
      clients: hub,
      startBlock: hubStart,
      async scan(from, to) {
        const logs = await getLogsChunked(hub.public, { address: inbox, event: getAbiItem({ abi: mockInboxAbi, name: 'RetryableCreated' }), fromBlock: from, toBlock: to });
        return logs.map((l) => {
          const a = l.args;
          return { key: keyOf('arb-l1-to-l2', l.transactionHash, l.logIndex), delivery: { route: 'arb-l1-to-l2', dstChainId: arb.chainId, ticketId: a.ticketId, from: a.from, to: a.to, l2CallValue: a.l2CallValue, gasLimit: a.gasLimit, data: a.data } };
        });
      },
    });
  }
  for (const s of arbSpokes) {
    const c = spokes.get(s.chainId)!;
    const arbSys = cfg.mockContracts[String(s.chainId)]?.MockArbSys ?? ARB_SYS;
    sources.push({
      name: `arb-l2-to-l1:${s.chainId}`,
      clients: c,
      startBlock: s.deployBlock,
      async scan(from, to) {
        const logs = await getLogsChunked(c.public, { address: arbSys, event: getAbiItem({ abi: mockArbSysAbi, name: 'L2ToL1Tx' }), fromBlock: from, toBlock: to });
        return logs.map((l) => {
          const a = l.args;
          return { key: keyOf(`arb-l2-to-l1:${s.chainId}`, l.transactionHash, l.logIndex), delivery: { route: 'arb-l2-to-l1', dstChainId: cfg.hub.chainId, position: a.position, caller: a.caller, destination: a.destination, data: a.data } };
        });
      },
    });
  }
  return sources;
}

/** CCTP MessageSent sources, one per chain with a MockTokenMessengerV2. */
export interface CctpSource {
  chainId: number;
  domain: number;
  clients: ChainClients;
  startBlock: bigint;
  scan(from: bigint, to: bigint): Promise<Array<{ txHash: Hex; message: Hex }>>;
}

export function buildCctpSources(cfg: XpoolConfig, hub: ChainClients, spokes: Map<number, ChainClients>): CctpSource[] {
  const chains = [
    { chainId: cfg.hub.chainId, domain: cfg.hub.cctp.domain, clients: hub, start: cfg.hub.deployBlock, messenger: cfg.hub.cctp.tokenMessengerV2 },
    ...cfg.spokes.map((s) => ({ chainId: s.chainId, domain: s.cctp.domain, clients: spokes.get(s.chainId)!, start: s.deployBlock, messenger: s.cctp.tokenMessengerV2 })),
  ];
  return chains.map((c) => ({
    chainId: c.chainId,
    domain: c.domain,
    clients: c.clients,
    startBlock: c.start,
    async scan(from, to) {
      const logs = await getLogsChunked(c.clients.public, { address: c.messenger, event: getAbiItem({ abi: mockTokenMessengerAbi, name: 'MessageSent' }), fromBlock: from, toBlock: to });
      return logs.map((l) => ({ txHash: l.transactionHash, message: l.args.message }));
    },
  }));
}

/**
 * Advances a cursor-based scan. `persist` runs (and must durably record the items) BEFORE the
 * cursor moves, so a crash can only cause a re-scan, never a lost message.
 */
export async function scanNext<T>(
  kv: KvStore,
  name: string,
  src: { clients: ChainClients; startBlock: bigint; scan(from: bigint, to: bigint): Promise<T[]> },
  persist: (items: T[]) => Promise<void> | void,
): Promise<void> {
  const head = await src.clients.public.getBlockNumber();
  const range = nextRange(kv.get<bigint>(`cursor:${name}`), src.startBlock, head, 2_000n);
  if (!range) return;
  await persist(await src.scan(range.from, range.to));
  kv.set(`cursor:${name}`, range.to);
}
