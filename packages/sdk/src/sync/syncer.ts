/**
 * Full sync (PRD 13.1, W9): paginated getLogs from all three chains at the `finalized` tag,
 * whole-contract ranges only (never per-note queries), RPCs spread per chain, progress checkpoints.
 * Spokes are synced before the hub so L2 deposit notes can be joined (chain + index) on insertion.
 */
import { getAbiItem, toBytes, type AbiEvent, type Address, type Log } from 'viem';
import { depositManagerAbi, hubCoreAbi, spokeAbi } from '../abi/index.js';
import type { EnvClients, RpcPool } from '../chains/clients.js';
import type { ResolvedEnv } from '../chains/resolve.js';
import type { SpendingKeys } from '../keys/derive.js';
import { interpolateTime, pagedLogs, type Page } from './logs.js';
import { SyncProcessor, type HubEvent, type NoteSink, type SpokeEvent, type SyncStats } from './processor.js';
import type { ChainView } from './state.js';

const HUB_EVENTS = [
  getAbiItem({ abi: hubCoreAbi, name: 'NewCommitment' }),
  getAbiItem({ abi: hubCoreAbi, name: 'NewNullifier' }),
  getAbiItem({ abi: hubCoreAbi, name: 'LeavesInserted' }),
  getAbiItem({ abi: hubCoreAbi, name: 'ReleaseLogged' }),
  getAbiItem({ abi: hubCoreAbi, name: 'Spend' }),
  getAbiItem({ abi: depositManagerAbi, name: 'L1Deposit' }),
  getAbiItem({ abi: depositManagerAbi, name: 'L2DepositInserted' }),
] as const satisfies readonly AbiEvent[];

const SPOKE_EVENTS = [
  getAbiItem({ abi: spokeAbi, name: 'Deposit' }),
  getAbiItem({ abi: spokeAbi, name: 'ReleaseExecuted' }),
  getAbiItem({ abi: spokeAbi, name: 'ReleaseQueued' }),
  getAbiItem({ abi: spokeAbi, name: 'ReleaseFailed' }),
] as const satisfies readonly AbiEvent[];

export interface SyncProgress {
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  /** Last processed block. */
  at: bigint;
}

export interface SyncOptions {
  env: ResolvedEnv;
  clients: EnvClients;
  keys: Pick<SpendingKeys, 'sk' | 'pk' | 'encSk'>;
  view: ChainView;
  notes: NoteSink;
  pageSize?: bigint;
  onProgress?: (p: SyncProgress) => void;
  /** Called after every processed page: persist state + notes here. */
  onCheckpoint?: () => void | Promise<void>;
}

type AnyLog = Log<bigint, number, false, AbiEvent, true> & { eventName: string; args: Record<string, unknown> };

const bytes = (h: unknown): Uint8Array => (typeof h === 'string' ? toBytes(h as `0x${string}`) : new Uint8Array());
const num = (x: unknown): number => Number(x as bigint | number);

export function toHubEvent(l: { eventName: string; args: Record<string, unknown> }): HubEvent | undefined {
  const a = l.args;
  switch (l.eventName) {
    case 'NewCommitment':
      return { type: 'NewCommitment', commitment: a.commitment as bigint, leafIndex: num(a.leafIndex), enc: bytes(a.encryptedOutput) };
    case 'NewNullifier':
      return { type: 'NewNullifier', nullifier: a.nullifier as bigint };
    case 'LeavesInserted':
      return { type: 'LeavesInserted', firstLeafIndex: num(a.firstLeafIndex), count: a.count as bigint, newRoot: a.newRoot as bigint };
    case 'ReleaseLogged':
      return {
        type: 'ReleaseLogged', dstChainId: a.dstChainId as bigint, index: a.index as bigint,
        recipient: a.recipient as string, amount: a.amount as bigint, spendId: a.spendId as string,
      };
    case 'Spend':
      return { type: 'Spend', spendId: a.spendId as string, root: a.root as bigint, dstChainId: a.dstChainId as bigint, v: a.v as bigint };
    case 'L1Deposit':
      return {
        type: 'L1Deposit', leafIndex: num(a.leafIndex), commitment: a.commitment as bigint, amount: a.amount as bigint,
        depositor: a.depositor as string, encNote: bytes(a.encNote),
      };
    case 'L2DepositInserted':
      return {
        type: 'L2DepositInserted', srcChainId: a.srcChainId as bigint, index: a.index as bigint,
        commitment: a.commitment as bigint, leafIndex: num(a.leafIndex), fastLane: a.fastLane as boolean,
      };
    default:
      return undefined;
  }
}

export function toSpokeEvent(l: { eventName: string; args: Record<string, unknown> }): SpokeEvent | undefined {
  const a = l.args;
  switch (l.eventName) {
    case 'Deposit':
      return {
        type: 'Deposit', index: a.index as bigint, ownerDigest: a.ownerDigest as bigint, amount: a.amount as bigint,
        fee: a.fee as bigint, l2Block: a.l2Block as bigint, encNote: bytes(a.encNote),
      };
    case 'ReleaseExecuted':
    case 'ReleaseQueued':
    case 'ReleaseFailed':
      return { type: l.eventName, index: a.index as bigint };
    default:
      return undefined;
  }
}

async function finalizedHead(pool: RpcPool): Promise<bigint> {
  const b = await pool.run((c) => c.getBlock({ blockTag: 'finalized' }));
  return b.number;
}

/** Group a page's logs by transaction, preserving order. */
function byTx(logs: AnyLog[]): AnyLog[][] {
  const out: AnyLog[][] = [];
  let cur: AnyLog[] = [];
  let tx: string | undefined;
  for (const l of logs) {
    if (l.transactionHash !== tx && cur.length) {
      out.push(cur);
      cur = [];
    }
    tx = l.transactionHash;
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function syncAll(o: SyncOptions): Promise<SyncStats> {
  const proc = new SyncProcessor(o.keys, o.env.hub.chainId, o.view, o.notes);
  const state = o.view.state;

  const runChain = async (
    chainId: number,
    pool: RpcPool,
    address: Address[],
    events: readonly AbiEvent[],
    deployBlock: bigint,
    onPage: (page: Page<AnyLog>) => void,
  ): Promise<void> => {
    const head = await finalizedHead(pool);
    const cursor = state.cursors[String(chainId)];
    const from = cursor !== undefined ? BigInt(cursor) + 1n : deployBlock;
    if (from > head) return;
    for await (const page of pagedLogs({ pool, address, events, fromBlock: from, toBlock: head, pageSize: o.pageSize })) {
      onPage(page as unknown as Page<AnyLog>);
      state.cursors[String(chainId)] = page.toBlock.toString();
      state.lastTime[String(chainId)] = page.toTime;
      o.onProgress?.({ chainId, fromBlock: from, toBlock: head, at: page.toBlock });
      await o.onCheckpoint?.();
    }
  };

  for (const s of o.env.spokes) {
    await runChain(s.chainId, o.clients.pool(s.chainId), [s.spoke], SPOKE_EVENTS, s.deployBlock, (page) => {
      for (const l of page.logs) {
        const e = toSpokeEvent(l);
        if (e) proc.processSpokeEvent(s.chainId, e, { txHash: l.transactionHash, blockNumber: l.blockNumber, time: interpolateTime(page, l.blockNumber) });
      }
    });
  }

  const hub = o.env.hub;
  await runChain(hub.chainId, o.clients.hub, [hub.contracts.HubCore, hub.contracts.DepositManager], HUB_EVENTS, hub.deployBlock, (page) => {
    for (const group of byTx(page.logs)) {
      const first = group[0]!;
      const events = group.map(toHubEvent).filter((e): e is HubEvent => e !== undefined);
      proc.processHubTx(events, { txHash: first.transactionHash, blockNumber: first.blockNumber, time: interpolateTime(page, first.blockNumber) });
    }
  });

  return proc.stats;
}
