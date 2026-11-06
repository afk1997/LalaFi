import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Hash } from 'viem';
import { AmountPill, CHAIN_MARK, Mark, SelectPill, TOKEN_MARK } from '../components/pills';
import { balancesOf, settleFee, type WalletBalances } from '../lib/chain';
import { groupCode, newCode, type DepositCode } from '../lib/code';
import { performDeposit, type DepositStep } from '../lib/deposit';
import { chainOf, ENV_NAME, poolById, pools, type Pool } from '../lib/env';
import { fmtAmount, parseAmount } from '../lib/format';
import { useWallet } from '../lib/wallet';

type Stage =
  | { kind: 'form' }
  | { kind: 'code'; code: DepositCode }
  | { kind: 'busy'; code: DepositCode; step: DepositStep; hash?: Hash }
  | { kind: 'done'; code: DepositCode; hash: Hash; amount: bigint; chainId: number };

const readyIn = (hub: boolean) =>
  ENV_NAME === 'local' ? (hub ? 'in a few seconds' : 'in under a minute') : hub ? 'in about 15 minutes' : 'in about 30 minutes';

/** Compare balances of tokens with different decimals. */
const norm = (v: bigint, decimals: number) => v * 10n ** BigInt(36 - decimals);

export function Deposit() {
  const { address } = useWallet();
  const [poolId, setPoolId] = useState(pools[0]!.id);
  const pool = poolById(poolId);
  const [amount, setAmount] = useState('100');
  const [chainId, setChainId] = useState<number>(pool.chains.find((c) => c.key === 'base')?.id ?? pool.chains[0]!.id);
  const [bals, setBals] = useState<WalletBalances>();
  const [fee, setFee] = useState<bigint>(0n);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [autoPicked, setAutoPicked] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return setBals(undefined);
    setBals(await balancesOf(address));
  }, [address]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const held = (p: Pool, id: number) => bals?.holdings.find((h) => h.poolId === p.id && h.chainId === id)?.amount;

  // Once balances arrive, start on the token + chain the wallet holds the most of.
  useEffect(() => {
    if (!bals || autoPicked) return;
    const best = [...bals.holdings].sort((a, b) => {
      const x = norm(a.amount, poolById(a.poolId).decimals);
      const y = norm(b.amount, poolById(b.poolId).decimals);
      return x === y ? 0 : y > x ? 1 : -1;
    })[0];
    if (best && best.amount > 0n) {
      setPoolId(best.poolId);
      setChainId(best.chainId);
    }
    setAutoPicked(true);
  }, [bals, autoPicked]);

  const choosePool = (id: string) => {
    const p = poolById(id);
    setPoolId(id);
    if (!p.chains.some((c) => c.id === chainId)) {
      const best = [...p.chains].sort((a, b) => ((held(p, b.id) ?? 0n) > (held(p, a.id) ?? 0n) ? 1 : -1))[0]!;
      setChainId(best.id);
    }
  };

  useEffect(() => {
    settleFee(pool, chainId).then(setFee, () => setFee(0n));
  }, [pool, chainId]);

  const chain = chainOf(pool, chainId);
  const bal = held(pool, chainId);
  const gas = bals?.eth[chainId];
  const a = parseAmount(amount, pool.decimals);
  const isHub = chainId === pool.env.hub.chainId;
  const fmt = (v: bigint) => fmtAmount(v, pool.decimals);
  const sym = pool.symbol;

  const problem = useMemo(() => {
    if (a === undefined || a === 0n) return 'Enter an amount.';
    if (a < pool.env.params.minDeposit) return `The smallest deposit is ${fmt(pool.env.params.minDeposit)} ${sym}.`;
    if (a > pool.env.params.maxDeposit) return `The largest deposit is ${fmt(pool.env.params.maxDeposit)} ${sym}.`;
    if (!address || bal === undefined) return undefined;
    if (bal < a + fee) return `You have ${fmt(bal)} ${sym} on ${chain.label}${fee ? `, and the fee is ${fmt(fee)} ${sym}` : ''}.`;
    if (gas === 0n) return `You need a little ETH on ${chain.label} to pay for gas.`;
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, address, bal, gas, fee, chain.label, pool]);

  const tokenOptions = pools.map((p) => {
    const best = bals ? [...p.chains].sort((x, y) => ((held(p, y.id) ?? 0n) > (held(p, x.id) ?? 0n) ? 1 : -1))[0] : undefined;
    const amt = best ? held(p, best.id) : undefined;
    return {
      value: p.id,
      label: (
        <>
          <Mark color={TOKEN_MARK[p.symbol] ?? '#b9c4c2'} />
          {p.symbol}
        </>
      ),
      detail: best && amt !== undefined ? (amt > 0n ? `${fmtAmount(amt, p.decimals)} on ${best.label}` : 'none in this wallet') : undefined,
    };
  });

  const chainOptions = pool.chains.map((c) => {
    const b = held(pool, c.id);
    const g = bals?.eth[c.id];
    return {
      value: c.id,
      label: (
        <>
          <Mark color={CHAIN_MARK[c.key]!} />
          {c.label}
        </>
      ),
      detail: b === undefined ? undefined : g === 0n ? `${fmt(b)} ${sym}, no ETH for gas` : `${fmt(b)} ${sym}`,
    };
  });

  const start = async (code: DepositCode) => {
    if (!address || a === undefined) return;
    setError(undefined);
    try {
      const hash = await performDeposit({
        code,
        chainId,
        amount: a,
        owner: address,
        onStep: (step, h) => setStage({ kind: 'busy', code, step, hash: h }),
      });
      setStage({ kind: 'done', code, hash, amount: a, chainId });
      void refresh();
    } catch (e) {
      const m = (e as Error).message;
      setError(/rejected|denied/i.test(m) ? 'The transaction was declined in your wallet. Nothing was deposited.' : m.split('\n')[0]);
      setStage({ kind: 'code', code });
    }
  };

  const sentence = (
    <h1 className="sentence swap">
      Deposit <AmountPill label="Amount" value={amount} onChange={setAmount} invalid={!!amount && a === undefined} />{' '}
      <SelectPill
        label="Token"
        value={poolId}
        options={tokenOptions}
        note={pools.length === 1 ? 'More tokens appear here as their pools go live.' : 'Each token has its own pool.'}
        onChange={choosePool}
      >
        <Mark color={TOKEN_MARK[sym] ?? '#b9c4c2'} />
        {sym}
      </SelectPill>{' '}
      on{' '}
      <SelectPill label="Chain" value={chainId} options={chainOptions} onChange={setChainId}>
        <Mark color={CHAIN_MARK[chain.key]!} />
        {chain.label}
      </SelectPill>
      .
    </h1>
  );

  if (stage.kind === 'done') {
    const p = stage.code.pool;
    const c = chainOf(p, stage.chainId);
    return (
      <section>
        <h1 className="sentence swap">
          Deposited {fmtAmount(stage.amount, p.decimals)} {p.symbol} on {c.label}.
        </h1>
        <p className="lead">
          Your code can withdraw it once it lands in the pool, {readyIn(stage.chainId === p.env.hub.chainId)}. Keep the code. It is the only
          way to reach these funds.
        </p>
        <CodeSlip code={stage.code} />
        <div className="actions">
          {c.explorer && (
            <a className="link" href={`${c.explorer}/tx/${stage.hash}`} target="_blank" rel="noreferrer noopener">
              View the deposit transaction
            </a>
          )}
          <button type="button" className="btn quiet" onClick={() => (setStage({ kind: 'form' }), setSaved(false))}>
            Make another deposit
          </button>
        </div>
      </section>
    );
  }

  if (stage.kind === 'code' || stage.kind === 'busy') {
    const busy = stage.kind === 'busy';
    const order: DepositStep[] = ['approve', 'approving', 'deposit', 'depositing'];
    const at = busy ? order.indexOf(stage.step) : -1;
    const cls = (from: number, to: number) => (at > to ? 'done' : at >= from ? 'now' : '');
    return (
      <section>
        {sentence}
        <CodeSlip code={stage.code} />
        <label className="check">
          <input type="checkbox" checked={saved} disabled={busy} onChange={(e) => setSaved(e.target.checked)} />
          <span>I saved this code. Anyone who has it can withdraw the deposit, and nobody can recover it for me.</span>
        </label>
        {busy && (
          <ol className="steps" aria-live="polite">
            <li className={cls(0, 1)}>{at === 1 ? `Approving ${sym}…` : `Approve ${fmt((a ?? 0n) + fee)} ${sym} in your wallet`}</li>
            <li className={cls(2, 3)}>{at === 3 ? 'Depositing…' : 'Confirm the deposit in your wallet'}</li>
          </ol>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!saved || busy || !!problem || stage.code.pool.id !== pool.id}
            onClick={() => void start(stage.code)}
          >
            {busy ? 'Depositing…' : `Deposit ${fmt(a ?? 0n)} ${sym}`}
          </button>
          {!busy && (
            <button type="button" className="link" onClick={() => setStage({ kind: 'form' })}>
              Back
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section>
      {sentence}
      <p className="lead">
        You get a withdrawal code. Use it later to withdraw to any address on {listChains(pool)}, with no link back to this deposit.
        It's usable {readyIn(isHub)}.
      </p>
      <div className="facts">
        {address && bal !== undefined && (
          <span className="fact">
            You have <b>{fmt(bal)} {sym}</b> on {chain.label}
          </span>
        )}
        {!isHub && fee > 0n && (
          <span className="fact">
            Network fee <b>{fmt(fee)} {sym}</b>
          </span>
        )}
        <span className="fact">
          Range <b>{fmt(pool.env.params.minDeposit)}–{fmt(pool.env.params.maxDeposit)} {sym}</b>
        </span>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!address || !!problem}
          onClick={() => (setSaved(false), setError(undefined), setStage({ kind: 'code', code: newCode(pool) }))}
        >
          {address ? `Deposit ${a ? fmt(a) : ''} ${sym}` : 'Connect a wallet to deposit'}
        </button>
        {address && problem && <span className="why">{problem}</span>}
      </div>
    </section>
  );
}

function listChains(pool: Pool): string {
  const names = pool.chains.map((c) => c.label);
  return names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

function CodeSlip({ code }: { code: DepositCode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const download = () => {
    const blob = new Blob(
      [`xpool ${code.pool.symbol} withdrawal code (${ENV_NAME})\n\n${code.text}\n\nAnyone with this code can withdraw the deposit. Keep it private.\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `xpool-${code.pool.id}-code.txt`;
    el.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="slip">
      <h2>Your {code.pool.symbol} withdrawal code</h2>
      <p>This code is the deposit. It is never stored or sent anywhere, so save it before you continue.</p>
      <div className="code" aria-label="Withdrawal code">
        {groupCode(code.text).map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="row">
        <button type="button" className="chip-btn" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <button type="button" className="chip-btn" onClick={download}>
          Download as a file
        </button>
      </div>
    </div>
  );
}
