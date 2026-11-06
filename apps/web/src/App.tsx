import { useState } from 'react';
import { WalletButton } from './components/WalletButton';
import { ENV_NAME, NETWORK_LABEL } from './lib/env';
import { Deposit } from './views/Deposit';
import { Withdraw } from './views/Withdraw';

type Mode = 'deposit' | 'withdraw';

export function App() {
  const [mode, setMode] = useState<Mode>(() => (location.hash === '#withdraw' ? 'withdraw' : 'deposit'));
  const choose = (m: Mode) => {
    setMode(m);
    history.replaceState(null, '', m === 'withdraw' ? '#withdraw' : '#');
  };
  return (
    <div className="frame">
      <header className="top">
        <div className="brand">
          xpool {NETWORK_LABEL && <small>{NETWORK_LABEL}</small>}
        </div>
        <nav className="modes" aria-label="Mode">
          <button type="button" aria-pressed={mode === 'deposit'} onClick={() => choose('deposit')}>
            Deposit
          </button>
          <button type="button" aria-pressed={mode === 'withdraw'} onClick={() => choose('withdraw')}>
            Withdraw
          </button>
        </nav>
        <div className="top-right">{mode === 'deposit' ? <WalletButton /> : null}</div>
      </header>

      <main className="stage" key={mode}>
        {mode === 'deposit' ? <Deposit /> : <Withdraw />}
      </main>

      <footer className="foot">
        <span>One USDC pool shared by Ethereum, Base and Arbitrum.</span>
        {ENV_NAME !== 'mainnet' && <span>Test network: test USDC only, not audited, not for real funds.</span>}
      </footer>
    </div>
  );
}
