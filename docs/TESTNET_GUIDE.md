# xpool testnet — manual test guide

Hub: **Ethereum Sepolia** (11155111). Spokes: **Base Sepolia** (84532), **Arbitrum Sepolia** (421614).
Addresses: [`deployments/testnet.json`](../deployments/testnet.json). Test trusted setup — **NOT FOR MAINNET**.

| Contract | Chain | Address |
|---|---|---|
| HubCore | Sepolia | `0x060F273d2844585A1814Ba7f41ffa876d8a6048D` |
| DepositManager | Sepolia | `0x3839e7D608e46D8563f34EA18dCde1D837727838` |
| StakeManager | Sepolia | `0x85Af2A1d4C19A20d4FA1f6E8A35B3f7d1f1e9606` |
| LiquidityManager (also the xLP token) | Sepolia | `0x99D206623eF7eeA147551780DfD84921c6ca6277` |
| Groth16Verifier | Sepolia | `0x23Fd314454d38bCaedf9d484DCb2bE7eBB13A69F` |
| PoseidonT3 / PoseidonT4 | Sepolia | `0x99231043a78c89811E5212044e3a5D5837C00D3d` / `0x3d6299090E2604E1a21dAFc5A997C9C33Eb7b3C0` |
| OpStackHubAdapter / ArbitrumHubAdapter | Sepolia | `0xEE785956481104069c329D7249d7Da9A2a8cF6A1` / `0x4E1cD50C7539f46Ec01cf9EB1c7C5Ad3375F497a` |
| Spoke (OpStackSpoke) | Base Sepolia | `0xD92406E70Cf210e3bcec7616973C7388Fd3944c7` |
| Spoke (ArbitrumSpoke) | Arbitrum Sepolia | `0xB5398DD9D8Ff451dDF247B104B9e41460a6cD214` |

Guardian = deployer `0x137D61d2899ab1cf1003649C04c4549B1f5B6Db5`. Verified on-chain: 91/91 (Sepolia), 26/26
(Base Sepolia), 26/26 (Arbitrum Sepolia); deployed verifier bytecode == build from the committed zkey.

Everything below runs from the repo root on your machine. Testnet gas is nearly free; USDC is the scarce
resource (Circle faucet: **20 USDC per address per chain every 2 h**).

---

## 0. One-time setup

```bash
pnpm install
pnpm --filter @xpool/sdk --filter @xpool/cli build
alias xpool='node packages/cli/dist/index.js --env testnet'
```

### Accounts you need (fresh EOAs; never reuse a real wallet)

| Role | Needs | Used for |
|---|---|---|
| `RELAYER` | ~0.02 Sepolia ETH + ~0.01 Arbitrum Sepolia ETH | submits spends (`transact`), Arbitrum retryables |
| `FINALIZER` | ~0.02 ETH on each of the 3 chains | `sendCheckpoint` on L2s, finalizes on L1, `processCheckpoint` |
| `KEEPER` | ~0.02 ETH on each of the 3 chains | CCTP rebalances + mints, `processQueue` |
| `VALIDATOR_OPERATOR` | ~0.02 Sepolia ETH + **20 Sepolia USDC** | bonds stake, submits attestations |
| `VALIDATOR_SIGNER` | nothing | signs attestations (must differ from operator) |
| `LP` | ~0.01 Sepolia ETH + **20 Sepolia USDC** | provides liquidity (needed for the fast lane and withdrawals) |
| `ALICE`, `BOB` | a little ETH + USDC on the chains they deposit from | users |

Make keys with `cast wallet new`. ETH: any Sepolia faucet (Google Cloud Web3, Alchemy), then bridge or use
Base/Arbitrum Sepolia faucets. USDC: <https://faucet.circle.com> (pick the chain).

Keep keys in a local, git-ignored file, e.g. `.xpool/testnet.env` (`.xpool/` is ignored):

```bash
RELAYER_PRIVATE_KEY=0x...
FINALIZER_PRIVATE_KEY=0x...
KEEPER_PRIVATE_KEY=0x...
VALIDATOR_OPERATOR_KEY=0x...
VALIDATOR_SIGNER_KEY=0x...
LP_KEY=0x...
ALICE_KEY=0x...
BOB_KEY=0x...
```
Load with `set -a; . .xpool/testnet.env; set +a` in every terminal below.

---

## 1. Start the services (one terminal each)

All read `config/testnet.json` + `deployments/testnet.json`. Override RPCs with `XPOOL_RPC_<chainId>=url1,url2`.

```bash
# T1 relayer (http://127.0.0.1:8080). Amsterdam pricing makes transact ~2-3M gas: quote with that.
cd services/relayer && XPOOL_ENV=testnet RELAYER_TRANSACT_GAS=3000000 node --import tsx src/index.ts

# T2 finalizer (checkpoints every 15 min; slow lane + L2 deposit confirmation)
cd services/finalizer && XPOOL_ENV=testnet node --import tsx src/index.ts

# T3 keeper (CCTP rebalances via Circle's sandbox attestation API)
cd services/keeper && XPOOL_ENV=testnet node --import tsx src/index.ts

# T4 validator: registers, bonds 20 USDC, allocates 10/10 to Base/Arbitrum, then attests
cd services/validator && XPOOL_ENV=testnet VALIDATOR_BOOTSTRAP_BOND=20000000 \
  VALIDATOR_BOOTSTRAP_ALLOCATIONS=84532:10000000,421614:10000000 node --import tsx src/index.ts
```

The validator's bond/allocation become active at the **next epoch** (testnet epoch = 1 h); its epoch
keeper calls `advanceEpoch` when due. Until then the fast lane is idle and L2 deposits use the slow lane.

Health: `curl 127.0.0.1:8080/v1/info`; metrics on `127.0.0.1:910x/metrics`.

---

## 2. Add LP liquidity (enables the fast lane and seeds withdrawals)

```bash
XPOOL_HOME=.xpool/lp XPOOL_PASSWORD=lp-pass-123 xpool --no-tor init     # any wallet works for LP
XPOOL_HOME=.xpool/lp XPOOL_PASSWORD=lp-pass-123 XPOOL_EOA_KEY=$LP_KEY xpool --no-tor lp add --amount 20
```
Expect: `LiquidityAdded` on Sepolia. Within ~15 min the keeper rebalances part of it to Base and Arbitrum
through CCTP (targets 30/35/35%); watch T3 for `rebalanced` then `CCTP mint completed`.

Fast-lane sizing with these numbers: validator 10 USDC per chain → max **~6.6 USDC** per fast batch
(k = 1.5), and the safety valve allows **10 USDC** unconfirmed in total (β = ½ of LP 20). Larger L2
deposits silently use the slow lane — that is expected behavior, not a failure.

---

## 3. User flows

Set up two wallets (the recovery phrase is printed once; for testnet you can ignore it):

```bash
export XPOOL_RELAYER_URL=http://127.0.0.1:8080
a() { XPOOL_HOME=.xpool/alice XPOOL_PASSWORD=alice-pass-123 xpool --no-tor "$@"; }
b() { XPOOL_HOME=.xpool/bob   XPOOL_PASSWORD=bob-pass-123   xpool --no-tor "$@"; }
a init; b init
b address        # bob's shielded address (txpool1...)
```

`--no-tor` is fine for testing; drop it if Tor runs on 127.0.0.1:9050. On testnet the anonymity set is
tiny, so withdrawals need `--ignore-delay --ignore-anonymity` (the W3/W4 guards **block** < 1 h and < 5
deposits by design — seeing that block without the flags is itself a test of the privacy defaults).

| # | Flow | Commands | Expect | Time |
|---|---|---|---|---|
| A | Deposit on Ethereum | `XPOOL_EOA_KEY=$ALICE_KEY a deposit --chain eth --amount 5` | `L1Deposit` on Sepolia; after `a sync`, `a balance` = 5 | sync sees it at the **finalized** tag: ~15 min |
| B | Deposit on Arbitrum (fast lane) | `XPOOL_EOA_KEY=$ALICE_KEY a deposit --chain arb --amount 3` | `Deposit` on the Arbitrum spoke; T4 logs `signed batch` / `submitted`; hub emits `L2DepositInserted(..., fastLane=true)` | L2 finality + attestation: ~20–40 min |
| C | Deposit on Base (fast lane) | `XPOOL_EOA_KEY=$ALICE_KEY a deposit --chain base --amount 3` | same as B, on Base | ~20–40 min |
| D | Withdraw to Ethereum | `a withdraw --to-chain eth --amount 2 --ignore-delay --ignore-anonymity -y` | fresh recipient printed; it holds 2 USDC on Sepolia in the same tx | ~1 min |
| E | Withdraw to Base | `a withdraw --to-chain base --amount 2 --ignore-delay --ignore-anonymity -y` | `ReleaseLogged` on Sepolia → `ReleaseExecuted` on Base spoke; recipient has 2 USDC | ~2–5 min (queued until a CCTP mint lands if Base liquidity is short) |
| F | Withdraw to Arbitrum | `a withdraw --to-chain arb --amount 2 --ignore-delay --ignore-anonymity -y` | retryable → `ReleaseExecuted` on Arbitrum spoke | ~10–15 min |
| G | Cross-chain | deposit on Base (C), withdraw on Arbitrum (F) | works — one global pool | as above |
| H | Private transfer | `a transfer --to <bob txpool1…> --amount 1 -y`, then `b sync; b balance` | bob sees 1 USDC; on-chain only nullifiers/commitments + relayer fee | ~15 min (finality) |
| I | Merge | `a merge -y`, then `a notes` | two notes become one | ~15 min |
| J | Status | `a status <spendId>` (printed by withdraw) | spend, release and delivery state across chains | — |
| K | Privacy estimate | `a privacy` | k_feas / delay / amount advice per note | — |
| L | Slow lane (Arbitrum) | stop T4, `XPOOL_EOA_KEY=$BOB_KEY b deposit --chain arb --amount 10` | inserted with `fastLane=false` once the finalizer's checkpoint is confirmed on L1 and processed | Arbitrum Sepolia assertion confirmation: **~1–2 h (measure)** |
| M | Slow lane (Base) | same with `--chain base` | inserted via canonical checkpoint | Base Sepolia withdrawal delay: **days (~3.5–7)** |
| N | Validator exit | `XPOOL_EOA_KEY=$VALIDATOR_OPERATOR_KEY a validator unbond --amount 20` → after 8 days `... validator withdraw` | blocked while its fast-lane exposure is unconfirmed | 8 days |
| O | LP exit | `XPOOL_HOME=.xpool/lp XPOOL_PASSWORD=lp-pass-123 XPOOL_EOA_KEY=$LP_KEY xpool --no-tor lp remove --all` (or `--amount <shares>`) | allowed only while Ethereum liquidity and the safety valve hold | — |

Each L2 deposit costs the fixed settlement fee (0.10 USDC) on top of the amount.

### Negative checks worth doing by hand
- Withdraw without `--ignore-delay` right after depositing → **blocked** (W3).
- `a withdraw ... --self-relay` without `--i-understand-linkability` → **refused** (W1).
- Run the same withdrawal from two copies of one wallet (`cp -R .xpool/alice .xpool/alice2`) at the same
  time to two different chains → exactly one succeeds; the other is rejected with `NullifierSpent`.
- Withdraw more than the destination chain's free liquidity → rejected with `InsufficientLiquidity`;
  no note is spent.

### Where to look
- Hub events: Sepolia explorer on `HubCore` / `DepositManager` (addresses in `deployments/testnet.json`).
- Spoke events: Base Sepolia / Arbitrum Sepolia explorers on each `Spoke`.
- Services: their terminal logs (JSON lines; no IPs, bodies or secrets are logged).

## 4. If something is stuck
- **Release not delivered** (E/F): the relayer re-sends after 30 min (OP) / 60 min (Arbitrum) via
  `HubCore.resendRelease`; spoke execution is idempotent, so re-sends are always safe.
- **Release queued on a spoke**: liquidity is in flight via CCTP; the keeper calls `processQueue` after the mint.
- **Fast lane never attests**: check the epoch has advanced since the validator bonded, the deposit is
  ≤ ~6.6 USDC, and LP liquidity exists. Otherwise the deposit completes through the slow lane.
- **Wallet out of sync**: `a sync`. Deleting `.xpool/alice/testnet/chain.vault` forces a full resync;
  notes are rebuilt from the mnemonic.
