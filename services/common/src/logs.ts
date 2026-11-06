import type { AbiEvent, Address, Chain, Log, PublicClient, Transport } from 'viem';

export interface ChunkedLogsQuery<E extends AbiEvent> {
  address: Address;
  event: E;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint;
  /** Max block span per eth_getLogs call. */
  chunk?: bigint;
}

/** eth_getLogs over [fromBlock, toBlock] in bounded chunks (public RPCs cap the range). */
export async function getLogsChunked<E extends AbiEvent>(
  client: PublicClient<Transport, Chain>,
  q: ChunkedLogsQuery<E>,
): Promise<Log<bigint, number, false, E, true>[]> {
  const chunk = q.chunk ?? 5_000n;
  const out: Log<bigint, number, false, E, true>[] = [];
  for (let from = q.fromBlock; from <= q.toBlock; from += chunk) {
    const to = from + chunk - 1n < q.toBlock ? from + chunk - 1n : q.toBlock;
    const logs = await client.getLogs({
      address: q.address,
      event: q.event,
      ...(q.args ? { args: q.args } : {}),
      fromBlock: from,
      toBlock: to,
      strict: true,
    } as never);
    out.push(...(logs as unknown as Log<bigint, number, false, E, true>[]));
  }
  return out;
}

/**
 * Persistent block cursor for an event scanner: returns the next [from, to] range to scan
 * (capped by `maxSpan`), or undefined when caught up.
 */
export function nextRange(cursor: bigint | undefined, startBlock: bigint, head: bigint, maxSpan: bigint): { from: bigint; to: bigint } | undefined {
  const from = cursor === undefined ? startBlock : cursor + 1n;
  if (from > head) return undefined;
  const to = from + maxSpan - 1n < head ? from + maxSpan - 1n : head;
  return { from, to };
}
