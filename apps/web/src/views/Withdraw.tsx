import { useEffect, useMemo, useState } from 'react';
import { getAddress, isAddress, type Address, type Hash } from 'viem';
import { AmountPill, CHAIN_MARK, FieldPill, Mark, SelectPill, TOKEN_MARK } from '../components/pills';
import { available } from '../lib/chain';
import { parseCode, type DepositCode } from '../lib/code';
import { chainOf, pools, type Pool } from '../lib/env';
import { fmtAmount, parseAmount, plainAmount } from '../lib/format';
import { withdrawalHints } from '../lib/privacy';
import { warmProver } from '../lib/prover';
import { scan, type ScanResult } from '../lib/scan';
import { arrivalText, maxWithdraw, performWithdraw, quoteWithdraw, type WithdrawQuote, type WithdrawStep } from '../lib/withdraw';
import { shortAddress, useWallet } from '../lib/wallet';

type Stage =
  | { kind: 'enter' }
  | { kind: 'scanning'; code: DepositCode; progress: number }
  | { kind: 'ready'; code: DepositCode; scanned: ScanResult }
  | { kind: 'busy'; code: DepositCode; scanned: ScanResult; step: WithdrawStep }
  | { kind: 'sent'; code: DepositCode; amount: bigint; chainId: number; recipient: Address; txHash?: Hash };

export function Withdraw() {
  const [stage, setStage] = useState<Stage>({ kind: 'enter' });
  const [codeText, setCodeText] = useState('');
  const [error, setError] = useState<string>();

  const find = async (text: string) => {
    const r = parseCode(text);
    if (!r.ok) return setError(r.reason);
    setError(undefined);
    warmProver();
    setStage({ kind: 'scanning', code: r.code, progress: 0 });
    try {
      const scanned = await scan(r.code.pool, r.code.keys, (p) => setStage({ kind: 'scanning', code: r.code, progress: p }));
      setStage({ kind: 'ready', code: r.code, scanned });
    } catch (e) {
      setError(`Couldn't read the chains: ${(e as Error).message.split('\n')[0]}. Try again in a moment.`);
      setStage({ kind: 'enter' });
    }
  };

  if (stage.kind === 'enter' || stage.kind === 'scanning') {
    const scanning = stage.kind === 'scanning';
    return (
      <section>
        <h1 className="sentence wide swap">
          Withdraw with code{' '}
          <FieldPill
            label="Withdrawal code"
            value={codeText}
            onChange={(v) => (setCodeText(v), setError(undefined))}
            placeholder={`${pools[0]!.codePrefix}1…`}
            width={18}
            display={codeText.length > 18 ? `${codeText.slice(0, 10)}…${codeText.slice(-6)}` : undefined}
            mono
            invalid={!!error}
            autoFocus
          />
          .
        </h1>
        <p className="lead">Paste the code you saved when you deposited. It is checked on this device and never sent anywhere.</p>
        {scanning && (
          <>
            <div className="meter" role="progressbar" aria-valuenow={Math.round(stage.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.max(4, stage.progress * 100)}%` }} />
            </div>
            <p className="why" style={{ marginTop: 10 }}>
              Reading Ethereum, Base and Arbitrum for this code's deposits…
            </p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" disabled={scanning || !codeText.trim()} onClick={() => void find(codeText)}>
            {scanning ? 'Finding your balance…' : 'Find balance'}
          </button>
        </div>
      </section>
    );
  }

  if (stage.kind === 'sent') {
    const pool = stage.code.pool;
    const c = chainOf(pool, stage.chainId);
    const hubExplorer = chainOf(pool, pool.env.hub.chainId).explorer;
    return (
      <section>
        <h1 className="sentence swap">
          Sent {fmtAmount(stage.amount, pool.decimals)} {pool.symbol} to {shortAddress(stage.recipient)} on {c.label}.
        </h1>
        <p className="lead">It arrives {arrivalText(pool, stage.chainId)}. Anything left stays on the same code.</p>
        <div className="actions">
          {stage.txHash && hubExplorer && (
            <a className="link" href={`${hubExplorer}/tx/${stage.txHash}`} target="_blank" rel="noreferrer noopener">
              View it on the Ethereum explorer
            </a>
          )}
          <button type="button" className="btn quiet" onClick={() => void find(stage.code.text)}>
            Check the remaining balance
          </button>
        </div>
      </section>
    );
  }

  return (
    <Ready
      stage={stage}
      onReset={() => (setStage({ kind: 'enter' }), setCodeText(''))}
      onStep={(step) => setStage({ kind: 'busy', code: stage.code, scanned: stage.scanned, step })}
      onSent={(s) => setStage({ kind: 'sent', code: stage.code, ...s })}
      onFailed={() => setStage({ kind: 'ready', code: stage.code, scanned: stage.scanned })}
    />
  );
}

function Ready({
  stage,
  onReset,
  onStep,
  onSent,
  onFailed,
}: {
  stage: Extract<Stage, { kind: 'ready' | 'busy' }>;
  onReset: () => void;
  onStep: (s: WithdrawStep) => void;
  onSent: (s: { amount: bigint; chainId: number; recipient: Address; txHash?: Hash }) => void;
  onFailed: () => void;
}) {
  const { address: connected } = useWallet();
  const { scanned, code } = stage;
  const pool = code.pool;
  const env = pool.env;
  const sym = pool.symbol;
  const fmt = (v: bigint) => fmtAmount(v, pool.decimals);
  const busy = stage.kind === 'busy';
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [chainId, setChainId] = useState<number>((pool.chains.find((c) => c.key === 'arb') ?? pool.chains.find((c) => c.key === 'base') ?? pool.chains[0]!).id);
  const [q, setQ] = useState<WithdrawQuote>();
  const [quoteError, setQuoteError] = useState<string>();
  const [liquidity, setLiquidity] = useState<Record<number, bigint>>({});
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string>();

  const w = parseAmount(amount, pool.decimals);
  const to = isAddress(recipient.trim(), { strict: false }) ? (getAddress(recipient.trim()) as Address) : undefined;
  const chain = chainOf(pool, chainId);

  useEffect(() => {
    void Promise.all(pool.chains.map(async (c) => [c.id, await available(pool, c.id).catch(() => 0n)] as const)).then((l) => setLiquidity(Object.fromEntries(l)));
  }, [pool]);

  // Quote (relayer fee) for the current chain and amount; debounced.
  useEffect(() => {
    setQ(undefined);
    setQuoteError(undefined);
    const amt = w && w > 0n ? w : env.params.minWithdraw;
    const t = setTimeout(() => {
      quoteWithdraw(pool, chainId, amt).then(setQ, (e: Error) => setQuoteError(`The relayer isn't reachable (${e.message.split('\n')[0]}).`));
    }, 350);
    return () => clearTimeout(t);
  }, [pool, chainId, w]);

  // Default the amount to everything the code can withdraw once the first quote arrives.
  useEffect(() => {
    if (q && amount === '' && scanned.balance > 0n) setAmount(plainAmount(maxWithdraw(pool, scanned.balance, q.quote.relayerFee), pool.decimals));
  }, [q, amount, scanned.balance, pool]);

  const hints = useMemo(() => withdrawalHints({ scanned, recipient: to, connected, amount: w }), [scanned, to, connected, w]);
  useEffect(() => setAccepted(false), [hints.length]);

  const problem = useMemo(() => {
    if (scanned.balance === 0n) return undefined;
    if (!w) return 'Enter an amount.';
    if (w < env.params.minWithdraw) return `The smallest withdrawal is ${fmt(env.params.minWithdraw)} ${sym}.`;
    if (!to) return `Enter the address that should receive the ${sym}.`;
    if (!q) return quoteError ?? 'Getting the relayer fee…';
    if (q.total > scanned.balance) return `With fees this needs ${fmt(q.total)} ${sym}; the code holds ${fmt(scanned.balance)}.`;
    const liq = liquidity[chainId];
    if (liq !== undefined && liq < w) return `${chain.label} can pay out ${fmt(liq)} ${sym} right now. Pick another chain or a smaller amount.`;
    if (hints.length > 0 && !accepted) return undefined;
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, to, q, quoteError, scanned.balance, liquidity, chainId, chain.label, hints.length, accepted, pool]);

  const go = async () => {
    if (!w || !to || !q) return;
    setError(undefined);
    try {
      const r = await performWithdraw({ code, scanned, dstChainId: chainId, recipient: to, amount: w, q, onStep });
      onSent({ amount: w, chainId, recipient: to, txHash: r.txHash });
    } catch (e) {
      setError((e as Error).message.split('\n')[0]);
      onFailed();
    }
  };

  const holds = (
    <p className="lead" style={{ marginTop: 0, marginBottom: 18 }}>
      This code holds <strong>{fmt(scanned.balance)} {sym}</strong>
      {scanned.arrivingTotal > 0n && (
        <>
          , and <strong>{fmt(scanned.arrivingTotal)} {sym}</strong> more is on its way into the pool
        </>
      )}
      .{' '}
      <button type="button" className="link" onClick={onReset} disabled={busy}>
        Use a different code
      </button>
    </p>
  );

  if (scanned.balance === 0n) {
    return (
      <section>
        {holds}
        <h1 className="sentence swap">{scanned.arrivingTotal > 0n ? 'Your deposit is on its way.' : 'Nothing to withdraw yet.'}</h1>
        {scanned.arrivingTotal > 0n ? (
          <ul className="lead" style={{ paddingLeft: 20 }}>
            {scanned.arriving.map((d) => (
              <li key={`${d.chainId}:${d.index}`}>{arrivingLine(pool, d, scanned.fastLane[d.chainId] ?? false)}</li>
            ))}
          </ul>
        ) : (
          <p className="lead">
            If you deposited in the last few minutes, it may not be readable yet. Otherwise this code has already been withdrawn.
          </p>
        )}
      </section>
    );
  }

  const chainOptions = pool.chains.map((c) => ({
    value: c.id,
    label: (
      <>
        <Mark color={CHAIN_MARK[c.key]!} />
        {c.label}
      </>
    ),
    detail: liquidity[c.id] !== undefined ? `${fmt(liquidity[c.id]!)} ${sym} available` : undefined,
  }));

  const step = busy ? stage.step : undefined;
  const order = ['checking', 'proving', 'waiting', 'sending', 'sent', 'confirmed'];
  const at = step ? order.indexOf(step.kind) : -1;
  const cls = (i: number) => (at > i ? 'done' : at === i ? 'now' : '');

  return (
    <section>
      {holds}
      <h1 className="sentence wide swap">
        Withdraw{' '}
        <AmountPill
          label="Amount"
          value={amount}
          onChange={setAmount}
          invalid={!!amount && w === undefined}
        />{' '}
        <span className="pill">
          <Mark color={TOKEN_MARK[sym] ?? '#b9c4c2'} />
          {sym}
        </span>{' '}
        to{' '}
        <FieldPill
          label="Recipient address"
          value={recipient}
          onChange={setRecipient}
          placeholder="0x address"
          width={42}
          display={to ? shortAddress(to) : undefined}
          mono
          invalid={recipient.trim() !== '' && !to}
        />{' '}
        on{' '}
        <SelectPill label="Destination chain" value={chainId} options={chainOptions} onChange={setChainId}>
          <Mark color={CHAIN_MARK[chain.key]!} />
          {chain.label}
        </SelectPill>
        .
      </h1>

      <p className="lead">
        {q && w ? (
          <>
            <strong>{fmt(w)} {sym}</strong> arrives {arrivalText(pool, chainId)}. Fees come out of the code: relayer {fmt(q.quote.relayerFee)}, pool{' '}
            {fmt(q.protocolFee)} {sym}. No wallet is needed; a relayer submits it, so none of your addresses touch the pool.
          </>
        ) : (
          <>A relayer submits the withdrawal, so none of your addresses touch the pool. Use an address that has never sent funds into it.</>
        )}
      </p>

      <div className="facts">
        <button
          type="button"
          className="fact"
          style={{ border: 0, cursor: 'pointer' }}
          disabled={!q || busy}
          onClick={() => q && setAmount(plainAmount(maxWithdraw(pool, scanned.balance, q.quote.relayerFee), pool.decimals))}
        >
          Withdraw everything
        </button>
      </div>

      {hints.length > 0 && (
        <>
          <ul className="hints">
            {hints.map((h) => (
              <li key={h.id}>{h.text}</li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={accepted} disabled={busy} onChange={(e) => setAccepted(e.target.checked)} />
            <span>I understand these make my withdrawal easier to trace. Withdraw anyway.</span>
          </label>
        </>
      )}

      {busy && (
        <ol className="steps" aria-live="polite">
          <li className={cls(0)}>Checking {chain.label} has enough liquidity</li>
          <li className={cls(1)}>Proving you own this balance, on this device</li>
          <li className={cls(2)}>
            {step?.kind === 'waiting' ? `Waiting ${Math.round(step.ms / 1000)} seconds so the timing can't identify you` : 'Waiting a random few seconds'}
          </li>
          <li className={cls(3)}>Handing the proof to the relayer</li>
          <li className={at >= 4 ? (at >= 5 ? 'done' : 'now') : ''}>Waiting for Ethereum to accept it</li>
        </ol>
      )}
      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !!problem || !w || !to || !q || (hints.length > 0 && !accepted)}
          onClick={() => void go()}
        >
          {busy ? 'Withdrawing…' : `Withdraw ${w ? fmt(w) : ''} ${sym}`}
        </button>
        {!busy && problem && <span className="why">{problem}</span>}
      </div>
    </section>
  );
}

function arrivingLine(pool: Pool, d: { chainId: number; amount: bigint; finalized: boolean }, fast: boolean): string {
  const c = chainOf(pool, d.chainId);
  const amt = `${fmtAmount(d.amount, pool.decimals)} ${pool.symbol} from ${c.label}`;
  const wait = d.finalized ? '' : `${c.label} hasn't finalized that block yet (this can take a few hours on testnet). After that, `;
  const lane = fast
    ? 'validators add it to the pool within about 30 minutes.'
    : `it reaches the pool through ${c.label}'s official bridge, which takes several days on testnet because no validator backs this pool on ${c.label} yet.`;
  return `${amt}: seen on-chain. ${wait}${d.finalized ? lane.charAt(0).toUpperCase() + lane.slice(1) : lane}`;
}
