import type { Address, Hex } from 'viem';

/** LOCAL ONLY. Pure scheduling / failure-injection logic for the mock bridge. */

export type RouteName = 'op-l1-to-l2' | 'op-l2-to-l1' | 'arb-l1-to-l2' | 'arb-l2-to-l1';
export const ROUTES: RouteName[] = ['op-l1-to-l2', 'op-l2-to-l1', 'arb-l1-to-l2', 'arb-l2-to-l1'];

export type Delivery =
  | { route: 'op-l1-to-l2' | 'op-l2-to-l1'; dstChainId: number; nonce: bigint; sender: Address; target: Address; message: Hex; gasLimit: bigint }
  | { route: 'arb-l1-to-l2'; dstChainId: number; ticketId: bigint; from: Address; to: Address; l2CallValue: bigint; gasLimit: bigint; data: Hex }
  | { route: 'arb-l2-to-l1'; dstChainId: number; position: bigint; caller: Address; destination: Address; data: Hex };

export interface Scheduled {
  key: string;
  dueAt: number;
  delivery: Delivery;
  attempts: number;
  /** Deliver with too little gas (failure simulation). */
  lowGas: boolean;
}

/** Ordered by due time; items are released only once due. */
export class DelayQueue {
  private items: Scheduled[] = [];

  add(item: Scheduled): void {
    if (this.items.some((i) => i.key === item.key)) return;
    this.items.push(item);
    this.items.sort((a, b) => a.dueAt - b.dueAt);
  }

  takeDue(now: number): Scheduled[] {
    const due = this.items.filter((i) => i.dueAt <= now);
    this.items = this.items.filter((i) => i.dueAt > now);
    return due;
  }

  list(): readonly Scheduled[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }
}

/** "Fail the next N deliveries on route R" — consumed one per delivery. */
export class FailureInjector {
  private readonly next = new Map<RouteName, number>();

  constructor(spec?: string) {
    // MOCK_FAIL_NEXT="op-l1-to-l2:1,arb-l1-to-l2:2"
    for (const part of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [r, n] = part.split(':');
      if (!ROUTES.includes(r as RouteName) || !/^\d+$/.test(n ?? '')) throw new Error(`bad MOCK_FAIL_NEXT entry ${part}`);
      this.set(r as RouteName, Number(n));
    }
  }

  set(route: RouteName, count: number): void {
    this.next.set(route, Math.max(0, Math.floor(count)));
  }

  consume(route: RouteName): boolean {
    const n = this.next.get(route) ?? 0;
    if (n <= 0) return false;
    this.next.set(route, n - 1);
    return true;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.next);
  }
}

/** Gas too low for any receive handler to complete, used for failure simulation. */
export const LOW_GAS = 30_000n;

/**
 * Total tx gas for an impersonated Arbitrum retryable execution: the ticket's gasLimit for the
 * call itself, plus intrinsic cost (21000 + 16 per calldata byte, upper bound).
 */
export function arbTxGas(gasLimit: bigint, data: Hex, lowGas: boolean): bigint {
  const intrinsic = 21_000n + 16n * BigInt((data.length - 2) / 2);
  return intrinsic + (lowGas ? 5_000n : gasLimit);
}

/** Backoff for transient delivery errors (RPC hiccups, nonce races). */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
}
