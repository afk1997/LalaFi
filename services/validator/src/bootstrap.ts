import type { Address } from 'viem';
import { simulateAndSend, stakeManagerAbi, usdcAbi, type KvStore, type Logger, type ProtocolContext } from '@xpool/service-common';
import type { ChainView } from './chain-view.js';

export interface BootstrapOptions {
  signer: Address;
  bond: bigint;
  /** chainId → allocation; defaults to an equal split of `bond` across spokes. */
  allocations?: Map<bigint, bigint>;
  /** Local only: mint MockUSDC (open faucet) if the operator lacks USDC for the bond. */
  mintIfShort: boolean;
}

/** Parses "31338:50000000,31339:50000000". */
export function parseAllocations(s: string | undefined): Map<bigint, bigint> | undefined {
  if (!s) return undefined;
  const m = new Map<bigint, bigint>();
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [c, a] = part.split(':');
    if (!c || !a || !/^\d+$/.test(c) || !/^\d+$/.test(a)) throw new Error(`bad allocation ${part}`);
    m.set(BigInt(c), BigInt(a));
  }
  return m;
}

export function defaultAllocations(bond: bigint, spokes: readonly number[]): Map<bigint, bigint> {
  const each = bond / BigInt(spokes.length);
  return new Map(spokes.map((c) => [BigInt(c), each]));
}

/**
 * Optional operator bootstrap (PRD 8.8 step 1): register(signer) → bond → setAllocations, each
 * only if not already done. Uses the OPERATOR key; the signer key never sends transactions.
 */
export async function bootstrapValidator(ctx: ProtocolContext, view: ChainView, kv: KvStore, o: BootstrapOptions, logger: Logger): Promise<void> {
  const log = logger.child({ component: 'bootstrap' });
  const hub = ctx.hub;
  const wallet = hub.wallet!;
  const sm = ctx.cfg.hub.contracts.StakeManager;
  const send = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) =>
    simulateAndSend(hub.public, wallet, { address, abi: abi as never, functionName, args });

  let info = await view.signerInfo(o.signer, 0);
  if (!info.registered) {
    await send(sm, stakeManagerAbi, 'register', [o.signer]);
    info = await view.signerInfo(o.signer, 0);
    log.info('registered', { id: info.id });
  }

  const bonded = (await hub.public.readContract({ address: sm, abi: stakeManagerAbi, functionName: 'bondedOf', args: [info.id] })) as bigint;
  if (bonded < o.bond) {
    const need = o.bond - bonded;
    const usdc = ctx.cfg.hub.usdc;
    const me = wallet.account.address;
    const bal = (await hub.public.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [me] })) as bigint;
    if (bal < need) {
      if (!o.mintIfShort) throw new Error(`operator has ${bal} USDC, needs ${need} to bond`);
      await send(usdc, usdcAbi, 'mint', [me, need - bal]);
    }
    await send(usdc, usdcAbi, 'approve', [sm, need]);
    await send(sm, stakeManagerAbi, 'bond', [need]);
    log.info('bonded', { amount: need });
  }

  if (!kv.get('allocationsSet')) {
    const alloc = o.allocations ?? defaultAllocations(o.bond, ctx.cfg.spokes.map((s) => s.chainId));
    await send(sm, stakeManagerAbi, 'setAllocations', [[...alloc.keys()], [...alloc.values()]]);
    kv.set('allocationsSet', true);
    log.info('allocations set (effective next epoch)', { chains: [...alloc.keys()] });
  }
}
