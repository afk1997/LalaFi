import { useEffect, useRef, useState } from 'react';
import { connect, disconnect, legacyProvider, shortAddress, useWallet } from '../lib/wallet';

export function WalletButton() {
  const { wallets, address, active } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choices = wallets.length > 0 ? wallets : [legacyProvider()].filter((x) => x !== undefined);

  const pick = async (i: number) => {
    setError(undefined);
    try {
      await connect(choices[i]!);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message.includes('rejected') ? 'Connection was declined in the wallet.' : (e as Error).message);
    }
  };

  if (address) {
    return (
      <div className="wallet-menu" ref={ref}>
        <button type="button" className="chip-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {active?.info.icon ? <img src={active.info.icon} alt="" /> : <span className="dot" aria-hidden />}
          {shortAddress(address)}
        </button>
        {open && (
          <div className="menu" role="menu">
            <button type="button" role="menuitem" onClick={() => (disconnect(), setOpen(false))}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-menu" ref={ref}>
      <button type="button" className="chip-btn light" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Connect wallet
      </button>
      {open && (
        <div className="menu" role="menu">
          {choices.length === 0 && <div className="note">No browser wallet found. Install one, then reload this page.</div>}
          {choices.map((w, i) => (
            <button type="button" role="menuitem" key={w.info.uuid} onClick={() => pick(i)}>
              <span className="opt">
                {w.info.icon && <img src={w.info.icon} alt="" width={20} height={20} />}
                {w.info.name}
              </span>
            </button>
          ))}
          {error && <div className="note" style={{ color: 'var(--amber)' }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
