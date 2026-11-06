/**
 * Paginated getLogs over a whole contract address range (never filtered by commitment, W9),
 * spread across the chain's RPC pool, with adaptive page size.
 */
import type { AbiEvent, Address, Log } from 'viem';
import type { RpcPool } from '../chains/clients.js';

export interface Page<L> {
  fromBlock: bigint;
  toBlock: bigint;
  logs: L[];
  /** Block timestamps of the page boundaries (for interpolation). */
  fromTime: number;
  toTime: number;
}

export interface PagedLogsOptions<E extends readonly AbiEvent[]> {
  pool: RpcPool;
  address: Address[];
  events: E;
  fromBlock: bigint;
  toBlock: bigint;
  pageSize?: bigint;
  minPageSize?: bigint;
}

async function blockTime(pool: RpcPool, n: bigint): Promise<number> {
  const b = await pool.run((c) => c.getBlock({ blockNumber: n }));
  return Number(b.timestamp);
}

/** Yields pages in ascending block order. */
export async function* pagedLogs<E extends readonly AbiEvent[]>(
  o: PagedLogsOptions<E>,
): AsyncGenerator<Page<Log<bigint, number, false, undefined, true, E>>> {
  let size = o.pageSize ?? 2_000n;
  const min = o.minPageSize ?? 16n;
  let from = o.fromBlock;
  let fromTime = from <= o.toBlock ? await blockTime(o.pool, from) : 0;
  while (from <= o.toBlock) {
    const to = from + size - 1n > o.toBlock ? o.toBlock : from + size - 1n;
    let logs: Log<bigint, number, false, undefined, true, E>[];
    try {
      logs = (await o.pool.run((c) =>
        c.getLogs({ address: o.address, events: o.events, fromBlock: from, toBlock: to, strict: true }),
      )) as unknown as Log<bigint, number, false, undefined, true, E>[];
    } catch (e) {
      if (size <= min) throw e;
      size = size / 2n;
      continue;
    }
    const toTime = await blockTime(o.pool, to);
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    yield { fromBlock: from, toBlock: to, logs, fromTime, toTime };
    from = to + 1n;
    fromTime = toTime;
  }
}

/** Linear interpolation of a block's timestamp inside a page. */
export function interpolateTime(page: { fromBlock: bigint; toBlock: bigint; fromTime: number; toTime: number }, block: bigint): number {
  if (page.toBlock === page.fromBlock) return page.toTime;
  const span = Number(page.toBlock - page.fromBlock);
  const off = Number(block - page.fromBlock);
  return Math.round(page.fromTime + ((page.toTime - page.fromTime) * off) / span);
}
