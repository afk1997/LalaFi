/**
 * Browser wallets via EIP-6963 (multi-wallet discovery) + viem. No wallet SDK, no WalletConnect relay:
 * the app talks only to the extension the user picks, the chain RPCs in config, and the relayer.
 */
import { useSyncExternalStore } from 'react';
import {
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  numberToHex,
  type Abi,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
} from 'viem';
import { chainById, type ChainInfo } from './env';

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface Discovered {
  info: WalletInfo;
  provider: EIP1193Provider;
}

interface State {
  wallets: Discovered[];
  active?: Discovered;
  address?: Address;
  chainId?: number;
}

let state: State = { wallets: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e: Event) => {
    const d = (e as CustomEvent<Discovered>).detail;
    if (!d?.info?.uuid || state.wallets.some((w) => w.info.uuid === d.info.uuid)) return;
    set({ wallets: [...state.wallets, d] });
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function useWallet(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Legacy injected provider (wallets that don't announce via EIP-6963). */
export function legacyProvider(): Discovered | undefined {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) return undefined;
  return { info: { uuid: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected' }, provider: eth };
}

export async function connect(w: Discovered): Promise<void> {
  const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
  const chainHex = (await w.provider.request({ method: 'eth_chainId' })) as string;
  const onAccounts = (a: unknown) => {
    const list = a as string[];
    set({ address: list[0] ? getAddress(list[0]) : undefined });
  };
  const onChain = (c: unknown) => set({ chainId: Number(c as string) });
  w.provider.on?.('accountsChanged', onAccounts);
  w.provider.on?.('chainChanged', onChain);
  set({ active: w, address: accounts[0] ? getAddress(accounts[0]) : undefined, chainId: Number(chainHex) });
}

export function disconnect(): void {
  set({ active: undefined, address: undefined, chainId: undefined });
}

function viemChain(c: ChainInfo): Chain {
  return defineChain({
    id: c.id,
    name: c.label,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: c.rpc } },
    ...(c.explorer ? { blockExplorers: { default: { name: 'Explorer', url: c.explorer } } } : {}),
  });
}

export async function ensureChain(chainId: number): Promise<void> {
  const w = state.active;
  if (!w) throw new Error('Connect a wallet first.');
  if (state.chainId === chainId) return;
  const c = chainById(chainId);
  try {
    await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chainId) }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await w.provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: numberToHex(chainId),
          chainName: c.label,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: c.rpc,
          ...(c.explorer ? { blockExplorerUrls: [c.explorer] } : {}),
        },
      ],
    });
  }
  set({ chainId });
}

export async function write(
  chainId: number,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<Hash> {
  const w = state.active;
  if (!w || !state.address) throw new Error('Connect a wallet first.');
  await ensureChain(chainId);
  const client = createWalletClient({ account: state.address, chain: viemChain(chainById(chainId)), transport: custom(w.provider) });
  return client.writeContract({ address, abi, functionName, args } as never);
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
