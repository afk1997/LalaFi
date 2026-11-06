import type { NodeId, Step } from './scenarios';

/** Fixed layout: off-chain actors on top, the three chains in the middle, recipients at the bottom. */
const N: Record<NodeId, { x: number; y: number; label: string; sub?: string }> = {
  you: { x: 95, y: 64, label: 'You', sub: 'wallet' },
  browser: { x: 255, y: 64, label: 'Your device', sub: 'code + proof' },
  relayer: { x: 435, y: 64, label: 'Relayer', sub: 'submits for you' },
  validators: { x: 615, y: 64, label: 'Validators', sub: 'vouch, staked' },
  finalizer: { x: 775, y: 64, label: 'Finalizer', sub: 'bridge courier' },
  keeper: { x: 925, y: 64, label: 'Keeper', sub: 'moves liquidity' },
  baseSpoke: { x: 170, y: 268, label: 'Pool contract', sub: 'holds tokens' },
  hub: { x: 500, y: 232, label: 'Hub', sub: 'tree + spent tags' },
  vault: { x: 500, y: 312, label: 'Vault', sub: 'liquidity ledger' },
  arbSpoke: { x: 830, y: 268, label: 'Pool contract', sub: 'holds tokens' },
  payBase: { x: 170, y: 470, label: 'Fresh address', sub: 'on Base' },
  payEth: { x: 500, y: 470, label: 'Fresh address', sub: 'on Ethereum' },
  payArb: { x: 830, y: 470, label: 'Fresh address', sub: 'on Arbitrum' },
};
const W = 128;
const H = 48;

const CHAINS = [
  { label: 'Base', x0: 40, x1: 300, mark: '#4d7cf0' },
  { label: 'Ethereum', x0: 350, x1: 650, mark: '#9aa6d8' },
  { label: 'Arbitrum', x0: 700, x1: 960, mark: '#5fb0dd' },
];

/** Point where the segment from a's centre towards b leaves a's box. */
function edge(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sx = dx === 0 ? Infinity : W / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : H / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: a.x + dx * s, y: a.y + dy * s };
}

export function Diagram({ step, index }: { step: Step; index: number }) {
  const a = N[step.from];
  const b = N[step.to];
  const sideBySide = Math.abs(a.y - b.y) < 20;
  // leave from / arrive at the bottom edge when boxes share a row
  const p = sideBySide ? { x: a.x + Math.sign(b.x - a.x) * 20, y: a.y + H / 2 } : edge(a, b);
  const q = sideBySide ? { x: b.x - Math.sign(b.x - a.x) * 20, y: b.y + H / 2 } : edge(b, a);
  // gentle curve: control point pushed sideways from the midpoint
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  // Side-by-side boxes: dip the arrow below the row so the label has room.
  const flat = Math.abs(a.y - b.y) < 20;
  const bend = flat ? 0 : Math.min(60, len / 4);
  const cx = flat ? mx : mx + (-(q.y - p.y) / len) * bend;
  const cy = flat ? my + 110 : my + ((q.x - p.x) / len) * bend;
  const path = `M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}`;
  // label at the curve's midpoint (t = .5 on a quadratic)
  const lx = 0.25 * p.x + 0.5 * cx + 0.25 * q.x;
  const ly = 0.25 * p.y + 0.5 * cy + 0.25 * q.y;
  const labelW = Math.max(90, step.carries.length * 7.2 + 24);

  return (
    <svg className="diagram" viewBox="0 0 1000 520" role="img" aria-label={`${step.title}: ${step.carries}`}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--brass)" />
        </marker>
      </defs>

      <text className="d-zone" x="40" y="22">
        Off-chain
      </text>
      {CHAINS.map((c) => (
        <g key={c.label}>
          <rect className="d-chain" x={c.x0} y={170} width={c.x1 - c.x0} height={220} rx={18} />
          <circle cx={c.x0 + 22} cy={366} r={6} fill={c.mark} />
          <text className="d-chain-label" x={c.x0 + 36} y={371}>
            {c.label}
          </text>
        </g>
      ))}
      <text className="d-zone" x="40" y="428">
        Recipients
      </text>

      {(Object.keys(N) as NodeId[]).map((id) => {
        const n = N[id];
        const on = id === step.from || id === step.to;
        return (
          <g key={id} className={`d-node${on ? ' on' : ''}`}>
            <rect x={n.x - W / 2} y={n.y - H / 2} width={W} height={H} rx={12} />
            <text x={n.x} y={n.y - 3} textAnchor="middle" className="d-label">
              {n.label}
            </text>
            {n.sub && (
              <text x={n.x} y={n.y + 14} textAnchor="middle" className="d-sub">
                {n.sub}
              </text>
            )}
          </g>
        );
      })}

      <g key={index} className="d-flow">
        <path d={path} className="d-arrow" markerEnd="url(#arrow)" />
        <circle r="7" className="d-token">
          <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
        </circle>
        <rect x={lx - labelW / 2} y={ly - 15} width={labelW} height={30} rx={15} className="d-carries-bg" />
        <text x={lx} y={ly + 5} textAnchor="middle" className="d-carries">
          {step.carries}
        </text>
      </g>
    </svg>
  );
}
