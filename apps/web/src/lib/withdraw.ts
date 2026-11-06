/**
 * Withdraw = the CLI's spend pipeline (PRD 8.3): liquidity check → relayer quote → build spend
 * (change back to the same code) → prove in a worker → random submission delay (W10) → relay → track.
 * The user's own wallet is never involved: the relayer submits, so no address of theirs touches the pool.
 */
import {
  buildWithdraw,
  isBucketMultiple,
  protocolFee,
  RelayerClient,
  randomSubmissionDelayMs,
  type OwnedNote,
  type RelayerQuote,
} from '@xpool/sdk/browser';
import type { Address, Hash } from 'viem';
import { available } from './chain';
import type { DepositCode } from './code';
import { env, ENV_NAME, RELAYER_URL } from './env';
import { prove } from './prover';
import type { ScanResult } from './scan';

export const relayer = new RelayerClient({ baseUrl: RELAYER_URL, timeoutMs: 20_000 });

export interface WithdrawQuote {
  quote: RelayerQuote;
  protocolFee: bigint;
  /** What leaves the code: w + relayer fee + protocol fee. */
  total: bigint;
}

export async function quoteWithdraw(dstChainId: number, w: bigint): Promise<WithdrawQuote> {
  const quote = await relayer.quote(BigInt(dstChainId), w);
  if (!isBucketMultiple(quote.relayerFee, env.params.relayerFeeBucket)) {
    throw new Error('The relayer quoted an unusual fee that could identify you. Try again later.');
  }
  const pf = protocolFee(w, env.params.phiBps);
  return { quote, protocolFee: pf, total: w + quote.relayerFee + pf };
}

/** Largest w such that w + relayerFee + ceil(w·φ) ≤ balance. */
export function maxWithdraw(balance: bigint, relayerFee: bigint): bigint {
  let w = ((balance - relayerFee) * 10_000n) / (10_000n + env.params.phiBps);
  while (w > 0n && w + relayerFee + protocolFee(w, env.params.phiBps) > balance) w--;
  return w > 0n ? w : 0n;
}

export type WithdrawStep =
  | { kind: 'checking' }
  | { kind: 'proving' }
  | { kind: 'waiting'; ms: number }
  | { kind: 'sending' }
  | { kind: 'sent'; requestId: string }
  | { kind: 'confirmed'; txHash?: Hash };

const MAX_DELAY_MS: Record<string, number> = { local: 2_000, testnet: 15_000, mainnet: 120_000 };

export async function performWithdraw(opts: {
  code: DepositCode;
  scanned: ScanResult;
  dstChainId: number;
  recipient: Address;
  amount: bigint;
  q: WithdrawQuote;
  onStep: (s: WithdrawStep) => void;
}): Promise<{ spendId: string; txHash?: Hash }> {
  const { code, scanned, dstChainId, recipient, amount, q, onStep } = opts;
  onStep({ kind: 'checking' });
  if ((await available(dstChainId)) < amount) {
    throw new Error('Not enough liquidity on that chain right now. Try another chain or a smaller amount.');
  }
  const notes: OwnedNote[] = scanned.notes.filter((n) => !n.spent);
  const spend = buildWithdraw(
    {
      keys: code.keys,
      tree: scanned.view.tree,
      hubChainId: BigInt(env.hub.chainId),
      hub: env.hub.contracts.HubCore,
      phiBps: env.params.phiBps,
      relayerFeeBucket: env.params.relayerFeeBucket,
      minWithdraw: env.params.minWithdraw,
    },
    { notes, dstChainId: BigInt(dstChainId), recipient, amount, fees: { relayer: q.quote.relayer, relayerFee: q.quote.relayerFee } },
  );

  onStep({ kind: 'proving' });
  const proof = await prove(spend.witness, spend.publicInputs);

  const delay = randomSubmissionDelayMs(MAX_DELAY_MS[ENV_NAME] ?? 15_000);
  onStep({ kind: 'waiting', ms: delay });
  await new Promise((r) => setTimeout(r, delay));

  onStep({ kind: 'sending' });
  const requestId = await relayer.relay(proof, spend.publicInputs, spend.extData);
  onStep({ kind: 'sent', requestId });

  for (let i = 0; i < 200; i++) {
    const st = await relayer.status(requestId);
    if (st.state === 'confirmed' || st.state === 'released') {
      onStep({ kind: 'confirmed', txHash: st.txHash });
      return { spendId: spend.spendId, txHash: st.txHash };
    }
    if (st.state === 'failed') throw new Error('The relayer could not submit this withdrawal. Your balance was not spent.');
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return { spendId: spend.spendId };
}

/** Typical arrival time after the hub accepts the withdrawal. */
export function arrivalText(dstChainId: number): string {
  if (dstChainId === env.hub.chainId) return 'right away';
  const s = env.spokes.find((x) => x.chainId === dstChainId);
  if (ENV_NAME === 'local') return 'in a few seconds';
  return s?.stack === 'arbitrum' ? 'in about 10–15 minutes' : 'in about 2–5 minutes';
}
