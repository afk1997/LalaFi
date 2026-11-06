import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Hash } from 'viem';
import { CHAIN_MARK, Mark, SelectPill, USDC_MARK, AmountPill } from '../components/pills';
import { balancesOf, settleFee, type ChainBalance } from '../lib/chain';
import { groupCode, newCode, type DepositCode } from '../lib/code';
import { performDeposit, type DepositStep } from '../lib/deposit';
import { chainById, chains, env, ENV_NAME } from '../lib/env';
import { fmtUsdc, parseUsdc } from '../lib/format';
import { useWallet } from '../lib/wallet';

type Stage = { kind: 'form' } | { kind: 'code'; code: DepositCode } | { kind: 'busy'; code: DepositCode; step: DepositStep; hash?: Hash } | { kind: 'done'; code: DepositCode; hash: Hash };

const READY_IN: Record<string, string> = {
  hub: ENV_NAME === 'local' ? 'in a few seconds' : 'in about 15 minutes',
  spoke: ENV_NAME === 'local' ? 'in under a minute' : 'in about 30 minutes',
};

export function Deposit() {
  const { address } = useWallet();
  const [amount, setAmount] = useState('100');
  const [chainId, setChainId] = useState<number>(chains.find((c) => c.key === 'base')?.id ?? chains[0]!.id);
  const [balances, setBalances] = useState<ChainBalance[]>();
  const [fee, setFee] = useState<bigint>(0n);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [autoPicked, setAutoPicked] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return setBalances(undefined);
    setBalances(await balancesOf(address));
  }, [address]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Once balances arrive, start on the chain where the wallet holds the most USDC.
  useEffect(() => {
    if (!balances || autoPicked) return;
    const best = [...balances].sort((a, b) => (b.usdc > a.usdc ? 1 : -1))[0];
    if (best && best.usdc > 0n) setChainId(best.chainId);
    setAutoPicked(true);
  }, [balances, autoPicked]);

  useEffect(() => {
    settleFee(chainId).then(setFee, () => setFee(0n));
  }, [chainId]);

  const chain = chainById(chainId);
  const bal = balances?.find((b) => b.chainId === chainId);
  const a = parseUsdc(amount);
  const isHub = chainId === env.hub.chainId;

  const problem = useMemo(() => {
    if (a === undefined || a === 0n) return 'Enter an amount.';
    if (a < env.params.minDeposit) return `The smallest deposit is ${fmtUsdc(env.params.minDeposit)} USDC.`;
    if (a > env.params.maxDeposit) return `The largest deposit is ${fmtUsdc(env.params.maxDeposit)} USDC.`;
    if (!address) return undefined;
    if (!bal) return undefined;
    if (bal.usdc < a + fee) return `You have ${fmtUsdc(bal.usdc)} USDC on ${chain.label}${fee ? `, and the fee is ${fmtUsdc(fee)} USDC` : ''}.`;
    if (bal.eth === 0n) return `You need a little ETH on ${chain.label} to pay for gas.`;
    return undefined;
  }, [a, address, bal, fee, chain.label]);

  const chainOptions = chains.map((c) => {
    const b = balances?.find((x) => x.chainId === c.id);
    return {
      value: c.id,
      label: (
        <>
          <Mark color={CHAIN_MARK[c.key]!} />
          {c.label}
        </>
      ),
      detail: b ? (b.eth === 0n ? `${fmtUsdc(b.usdc)} USDC, no ETH for gas` : `${fmtUsdc(b.usdc)} USDC`) : undefined,
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
      setStage({ kind: 'done', code, hash });
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
        value="USDC"
        options={[{ value: 'USDC', label: (<><Mark color={USDC_MARK} />USDC</>), detail: bal ? `${fmtUsdc(bal.usdc)} on ${chain.label}` : undefined }]}
        note="This pool holds USDC only."
        onChange={() => undefined}
      >
        <Mark color={USDC_MARK} />
        USDC
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
    return (
      <section>
        <h1 className="sentence swap">Deposited {fmtUsdc(a ?? 0n)} USDC on {chain.label}.</h1>
        <p className="lead">
          Your code can withdraw it once it lands in the pool, {isHub ? READY_IN.hub : READY_IN.spoke}. Keep the code. It is the only way to reach these funds.
        </p>
        <CodeSlip code={stage.code} />
        <div className="actions">
          {chain.explorer && (
            <a className="link" href={`${chain.explorer}/tx/${stage.hash}`} target="_blank" rel="noreferrer noopener">
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
    const step = busy ? stage.step : undefined;
    const order: DepositStep[] = ['approve', 'approving', 'deposit', 'depositing'];
    const at = step ? order.indexOf(step) : -1;
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
            <li className={cls(0, 1)}>{at === 1 ? 'Approving USDC…' : `Approve ${fmtUsdc((a ?? 0n) + fee)} USDC in your wallet`}</li>
            <li className={cls(2, 3)}>{at === 3 ? 'Depositing…' : 'Confirm the deposit in your wallet'}</li>
          </ol>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" disabled={!saved || busy || !!problem} onClick={() => void start(stage.code)}>
            {busy ? 'Depositing…' : `Deposit ${fmtUsdc(a ?? 0n)} USDC`}
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
        You get a withdrawal code. Use it later to withdraw to any address on Ethereum, Base or Arbitrum, with no link back to this
        deposit. It's usable {isHub ? READY_IN.hub : READY_IN.spoke}.
      </p>
      <div className="facts">
        {address && bal && (
          <span className="fact">
            You have <b>{fmtUsdc(bal.usdc)} USDC</b> on {chain.label}
          </span>
        )}
        {!isHub && fee > 0n && (
          <span className="fact">
            Network fee <b>{fmtUsdc(fee)} USDC</b>
          </span>
        )}
        <span className="fact">
          Range <b>{fmtUsdc(env.params.minDeposit)}–{fmtUsdc(env.params.maxDeposit)} USDC</b>
        </span>
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={!address || !!problem} onClick={() => (setSaved(false), setStage({ kind: 'code', code: newCode() }))}>
          {address ? `Deposit ${a ? fmtUsdc(a) : ''} USDC` : 'Connect a wallet to deposit'}
        </button>
        {address && problem && <span className="why">{problem}</span>}
      </div>
    </section>
  );
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
      [`xpool withdrawal code (${ENV_NAME})\n\n${code.text}\n\nAnyone with this code can withdraw the deposit. Keep it private.\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = 'xpool-code.txt';
    el.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="slip">
      <h2>Your withdrawal code</h2>
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
