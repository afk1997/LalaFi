import { useEffect, useState } from 'react';
import { parseAbi } from 'viem';
import { CHAIN_MARK, Mark, SelectPill } from '../components/pills';
import { available, clientsOf } from '../lib/chain';
import { depositPools, type Pool } from '../lib/env';
import { fmtAmount } from '../lib/format';
import { Diagram } from './how/Diagram';
import { gasTable, guarantees, scenarios } from './how/scenarios';

export function How() {
  const [sid, setSid] = useState(scenarios[0]!.id);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const sc = scenarios.find((s) => s.id === sid)!;
  const step = sc.steps[i]!;
  const last = sc.steps.length - 1;

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => (i < last ? setI(i + 1) : setPlaying(false)), 6000);
    return () => clearTimeout(t);
  }, [playing, i, last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') setI((x) => Math.min(last, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [last]);

  return (
    <section className="how">
      <h1 className="sentence wide swap">
        Show me{' '}
        <SelectPill
          label="Scenario"
          value={sid}
          options={scenarios.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(v) => (setSid(v), setI(0), setPlaying(false))}
        >
          {sc.label}
        </SelectPill>
        .
      </h1>

      <Diagram step={step} index={i} />

      <div className="how-step" aria-live="polite">
        <div>
          <p className="how-count">
            <span>
              Step {i + 1} of {sc.steps.length}
            </span>
            <span>Takes {step.time}</span>
          </p>
          <h2>{step.title}</h2>
          <p className="how-what">{step.what}</p>
          <div className="actions" style={{ marginTop: 22 }}>
            <button type="button" className="btn quiet" disabled={i === 0} onClick={() => setI(i - 1)}>
              Back
            </button>
            <button type="button" className="btn" onClick={() => (i < last ? setI(i + 1) : (setI(0), setPlaying(false)))}>
              {i < last ? 'Next step' : 'Start over'}
            </button>
            <button type="button" className="link" onClick={() => setPlaying((p) => !p)}>
              {playing ? 'Pause' : 'Play all'}
            </button>
          </div>
          <ol className="how-dots" aria-label="Steps">
            {sc.steps.map((s, k) => (
              <li key={k}>
                <button type="button" aria-current={k === i} aria-label={s.title} onClick={() => setI(k)} />
              </li>
            ))}
          </ol>
        </div>
        <dl className="how-facts">
          <dt>Who pays gas</dt>
          <dd>{step.gas}</dd>
          <dt>What anyone can see</dt>
          <dd>{step.publicView}</dd>
          <dt>Why it’s safe</dt>
          <dd>{step.safety}</dd>
        </dl>
      </div>

      <div className="how-cols">
        <div>
          <h2 className="how-h">Who pays for what</h2>
          <table className="how-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Pays gas</th>
                <th>Paid back by</th>
              </tr>
            </thead>
            <tbody>
              {gasTable.map((r) => (
                <tr key={r.action}>
                  <td>{r.action}</td>
                  <td>{r.payer}</td>
                  <td>{r.repaidBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="why" style={{ marginTop: 12 }}>
            Users pay: a 0.10% protocol fee on withdrawals, the relayer fee (rounded to fixed steps so it can’t fingerprint anyone), and a small fixed fee on L2 deposits.
          </p>
        </div>
        <div>
          <h2 className="how-h">Why it’s safe</h2>
          <dl className="how-guarantees">
            {guarantees.map((g) => (
              <div key={g.claim}>
                <dt>{g.claim}</dt>
                <dd>{g.because}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <h2 className="how-h">Live on testnet</h2>
      <div className="how-live">
        {depositPools.map((p) => (
          <LivePool key={p.id} pool={p} />
        ))}
      </div>
    </section>
  );
}

const stakeAbi = parseAbi([
  'function currentEpoch() view returns (uint64)',
  'function totalAllocation(uint64 chainId, uint64 epoch) view returns (uint256)',
]);

function LivePool({ pool }: { pool: Pool }) {
  const [liq, setLiq] = useState<Record<number, bigint>>();
  const [stake, setStake] = useState<Record<number, bigint>>();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const l = Object.fromEntries(await Promise.all(pool.chains.map(async (c) => [c.id, await available(pool, c.id).catch(() => 0n)] as const)));
      const hub = clientsOf(pool).hub;
      const sm = pool.env.hub.contracts.StakeManager;
      const epoch = await hub.run((x) => x.readContract({ address: sm, abi: stakeAbi, functionName: 'currentEpoch' })).catch(() => 0n);
      const s = Object.fromEntries(
        await Promise.all(
          pool.env.spokes.map(async (sp) => [
            sp.chainId,
            await hub
              .run((x) => x.readContract({ address: sm, abi: stakeAbi, functionName: 'totalAllocation', args: [BigInt(sp.chainId), epoch] }))
              .catch(() => 0n),
          ] as const),
        ),
      );
      if (alive) (setLiq(l), setStake(s));
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => ((alive = false), clearInterval(t));
  }, [pool]);

  const f = (v: bigint) => fmtAmount(v, pool.decimals);
  return (
    <div className="how-pool">
      <h3>{pool.symbol} pool</h3>
      <table className="how-table">
        <thead>
          <tr>
            <th>Chain</th>
            <th>Can pay out now</th>
            <th>Validator stake</th>
          </tr>
        </thead>
        <tbody>
          {pool.chains.map((c) => (
            <tr key={c.id}>
              <td>
                <span className="how-chain">
                  <Mark color={CHAIN_MARK[c.key]!} />
                  {c.label}
                </span>
              </td>
              <td>{liq ? `${f(liq[c.id] ?? 0n)} ${pool.symbol}` : '…'}</td>
              <td>{c.id === pool.env.hub.chainId ? 'not needed' : stake ? `${f(stake[c.id] ?? 0n)} ${pool.symbol}` : '…'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
