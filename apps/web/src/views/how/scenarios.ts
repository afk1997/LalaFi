/**
 * The flows the "How it works" page can play. Each step is one arrow on the diagram plus the facts a
 * person explaining the system needs: what moves, who pays gas, what the public sees, why it's safe.
 */
export type NodeId =
  | 'you'
  | 'browser'
  | 'relayer'
  | 'validators'
  | 'finalizer'
  | 'keeper'
  | 'baseSpoke'
  | 'hub'
  | 'vault'
  | 'arbSpoke'
  | 'payEth'
  | 'payBase'
  | 'payArb';

export interface Step {
  title: string;
  from: NodeId;
  to: NodeId;
  /** Label on the arrow. */
  carries: string;
  what: string;
  gas: string;
  publicView: string;
  safety: string;
  /** Rough wall-clock time for this step on testnet. */
  time: string;
}

export interface Scenario {
  id: string;
  label: string;
  steps: Step[];
}

export const scenarios: Scenario[] = [
  {
    id: 'base-to-eth',
    label: 'a deposit on Base, withdrawn on Ethereum',
    steps: [
      {
        title: 'You deposit on Base',
        from: 'you',
        to: 'baseSpoke',
        carries: '10 DAI + 0.1 fee',
        what: 'Your wallet sends 10 DAI to the pool contract on Base. The page creates a secret withdrawal code first; the deposit is locked to that code, not to your wallet.',
        gas: 'You pay Base gas (a fraction of a cent). The 0.1 DAI settlement fee later repays whoever does steps 2 and 3.',
        publicView: 'Your address, the amount, the time, and a scrambled fingerprint of the code. Not who can withdraw it.',
        safety: 'The code never leaves your device. Only someone holding it can ever withdraw.',
        time: 'one Base block (~2 s)',
      },
      {
        title: 'Validators vouch for it on Ethereum',
        from: 'validators',
        to: 'hub',
        carries: 'signed "this deposit exists"',
        what: 'Validators watch Base, check the deposit, and sign a statement. Once enough stake has signed, the hub adds your deposit to the shared pool (a Merkle tree on Ethereum). This is the fast lane.',
        gas: 'The validator that submits pays Ethereum gas; it is repaid from the deposit’s settlement fee.',
        publicView: 'That some Base deposit entered the tree at position N. Nothing new about you.',
        safety: 'Validators must stake at least 1.5× what they vouch for. If they lie, step 3 proves it and their whole stake is taken, so lying always loses money.',
        time: '~30 s on testnet',
      },
      {
        title: 'Base’s own bridge confirms it (in the background)',
        from: 'finalizer',
        to: 'hub',
        carries: 'checkpoint of Base deposits',
        what: 'The finalizer sends a list of Base deposits to Ethereum through Base’s built-in L1 messaging (part of Base itself, not a third-party bridge). Matching deposits are confirmed, validators are released from their promise, and Base’s payout balance grows.',
        gas: 'The finalizer pays; it is repaid from the settlement fee.',
        publicView: 'The same deposit list Base already shows.',
        safety: 'This is the check that catches a lying validator. It needs no trust in anyone but Base itself, and it also works when every validator is offline.',
        time: 'days on testnet (Base’s challenge window); you don’t wait for it',
      },
      {
        title: 'You prove ownership, privately',
        from: 'you',
        to: 'browser',
        carries: 'your code',
        what: 'Days or minutes later you paste the code. The page reads the chains, finds your deposit, and builds a zero-knowledge proof: “I own some deposit in the pool and it hasn’t been spent”, without saying which one.',
        gas: 'None. It all happens in your browser (about 1–3 s).',
        publicView: 'Nothing. The code is checked on this device and never sent.',
        safety: 'The proof also locks in the recipient, amount, chain, fees and a deadline, so nobody can change them later.',
        time: '~2 s',
      },
      {
        title: 'A relayer submits it',
        from: 'browser',
        to: 'relayer',
        carries: 'proof only',
        what: 'The page hands the proof to a relayer, which sends the transaction. Your own wallet never touches the pool, so the withdrawal can’t be tied to your deposit address.',
        gas: 'The relayer pays Ethereum gas; its fee (0.01 DAI here) is taken out of your withdrawal, inside the proof.',
        publicView: 'The relayer’s address. Not yours.',
        safety: 'The relayer can only submit or refuse. Changing anything breaks the proof; if it refuses, use another relayer.',
        time: 'a few seconds (plus a small random delay so timing can’t identify you)',
      },
      {
        title: 'The hub checks and pays out',
        from: 'relayer',
        to: 'hub',
        carries: 'withdraw 9.98 DAI',
        what: 'HubCore checks the proof, that the pool state it refers to is real, and that this deposit’s one-time “spent” tag (nullifier) hasn’t been used. Then it records the tag so the deposit can never be spent again, on any chain.',
        gas: 'Covered by the relayer (step 5).',
        publicView: 'A random-looking spent tag, the amount, the destination chain and recipient.',
        safety: 'One global list of spent tags on Ethereum means a deposit can be withdrawn once, ever, no matter which chain you ask.',
        time: 'one Ethereum block (~12 s)',
      },
      {
        title: 'Money arrives at a fresh address',
        from: 'vault',
        to: 'payEth',
        carries: '9.98 DAI',
        what: 'The pool’s Ethereum vault pays the recipient in the same transaction. 0.1% stays with the pool as the protocol fee (shared by validators, liquidity providers and an insurance fund).',
        gas: 'None for the recipient.',
        publicView: 'A fresh address received 9.98 DAI from the pool. Nothing links it to the Base deposit.',
        safety: 'The vault only pays what the hub has approved; nobody, including the team, can move pool funds.',
        time: 'no extra time (same block)',
      },
    ],
  },
  {
    id: 'eth-to-base',
    label: 'a deposit on Ethereum, withdrawn on Base',
    steps: [
      {
        title: 'You deposit on Ethereum',
        from: 'you',
        to: 'hub',
        carries: '100 USDC',
        what: 'On Ethereum the deposit goes straight into the pool: the hub adds it to the shared tree in the same transaction. No validators needed.',
        gas: 'You pay Ethereum gas.',
        publicView: 'Your address, amount and time. Not who can withdraw it.',
        safety: 'The hub computes the deposit’s entry itself, so a deposit can never claim more than it paid.',
        time: 'one Ethereum block',
      },
      {
        title: 'Your USDC sits in the Ethereum vault',
        from: 'hub',
        to: 'vault',
        carries: '100 USDC',
        what: 'The tokens are held by the LiquidityManager. It keeps a ledger of how much each chain can pay out right now.',
        gas: '—',
        publicView: 'The vault balance (total for everyone).',
        safety: 'No admin function can move these funds. The contracts can’t be upgraded.',
        time: 'no extra time (same block)',
      },
      {
        title: 'The keeper keeps every chain stocked',
        from: 'keeper',
        to: 'baseSpoke',
        carries: 'USDC via Circle CCTP',
        what: 'When Base is running low, the keeper moves surplus from Ethereum to Base using Circle’s official burn-and-mint transfer (CCTP). For test DAI, which Circle doesn’t support, a testnet mover does the same job.',
        gas: 'The keeper pays (the team runs it in v1).',
        publicView: 'That the pool moved liquidity between chains. Nothing per user.',
        safety: 'Moves are only allowed from a chain with surplus to a chain below its target, so nobody can grief the pool by shuffling funds.',
        time: '~20 min for CCTP on testnet; ~35 s for the DAI mover',
      },
      {
        title: 'You prove ownership and a relayer submits',
        from: 'browser',
        to: 'relayer',
        carries: 'proof only',
        what: 'Same as before: paste the code, the browser builds the proof, a relayer sends it to the hub, which checks it and marks the deposit spent.',
        gas: 'Relayer pays, repaid by its fee inside the withdrawal.',
        publicView: 'Relayer address, spent tag, amount, destination (Base) and recipient.',
        safety: 'The destination chain is part of the proof; it can’t be switched.',
        time: '~15 s',
      },
      {
        title: 'Ethereum tells Base to pay',
        from: 'hub',
        to: 'baseSpoke',
        carries: '"pay 99.89 USDC to 0xabc…"',
        what: 'The hub sends a payout instruction to the Base contract through Base’s built-in L1→L2 messaging. Base only accepts instructions that really came from our hub.',
        gas: 'Paid inside the relayer’s transaction.',
        publicView: 'The payout instruction (recipient and amount).',
        safety: 'Each instruction has a number and runs once. If delivery fails it can be re-sent safely.',
        time: '~1–3 min',
      },
      {
        title: 'Money arrives on Base',
        from: 'baseSpoke',
        to: 'payBase',
        carries: '99.89 USDC',
        what: 'The Base contract pays the fresh address from the liquidity it holds. If a refill is still on its way, the payout waits in line and goes out as soon as it lands.',
        gas: 'None for the recipient.',
        publicView: 'A fresh Base address received 99.89 USDC from the pool.',
        safety: 'Payouts never wait on validators; they only depend on Ethereum and Base themselves.',
        time: 'no extra time (pays on arrival)',
      },
    ],
  },
];

export const gasTable: { action: string; payer: string; repaidBy: string }[] = [
  { action: 'Deposit', payer: 'You', repaidBy: 'Nobody: it is your own transaction (L2 deposits also pay a small fixed settlement fee)' },
  { action: 'Vouching for an L2 deposit (fast lane)', payer: 'Validator', repaidBy: 'Settlement fee (insert part)' },
  { action: 'Bridge checkpoint + confirming deposits', payer: 'Finalizer', repaidBy: 'Settlement fee (final part)' },
  { action: 'Withdrawal transaction', payer: 'Relayer', repaidBy: 'Relayer fee, taken from the withdrawal inside the proof' },
  { action: 'Payout message to Base / Arbitrum', payer: 'Relayer (inside the same tx)', repaidBy: 'Relayer fee' },
  { action: 'Moving liquidity between chains', payer: 'Keeper', repaidBy: 'Nobody in v1 (team-run)' },
  { action: 'Proving a validator lied', payer: 'Anyone', repaidBy: 'A reward from the slashed stake' },
];

export const guarantees: { claim: string; because: string }[] = [
  { claim: 'A deposit can be withdrawn only once, on any chain', because: 'Every withdrawal reveals a one-time spent tag, and Ethereum keeps one global list of them.' },
  { claim: 'Only the code holder can withdraw', because: 'The zero-knowledge proof can only be made with the code’s secret key.' },
  { claim: 'Nobody can redirect your withdrawal', because: 'Recipient, chain, amount, fees and deadline are sealed into the proof.' },
  { claim: 'Lying validators lose money', because: 'They stake 1.5× what they vouch for; the rollup’s own bridge later proves the truth and their entire stake is taken to cover the pool.' },
  { claim: 'Works even if every validator is offline', because: 'Deposits also enter through each rollup’s built-in bridge, and payouts never need validators.' },
  { claim: 'The team can’t take funds', because: 'No upgradeable contracts and no admin withdraw. The guardian can only pause new deposits, or pause spends for at most 72 h once a month.' },
  { claim: 'The pool can’t create money', because: 'The math in the proof forces inputs = outputs + fees exactly, and the hub computes every deposit’s value itself.' },
];
