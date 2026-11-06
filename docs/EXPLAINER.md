# xpool, explained simply

A plain-English guide to what xpool is and how it works, written for a founder who has to explain
the system to a senior engineer. Sources: the spec (`2026-11-06-xpool-v1-prd.md`, "the PRD"),
`docs/IMPLEMENTATION.md` and the code. Where they disagree, this file follows the code.

---

## 1. The pitch

xpool is one shielded pool shared by three chains: Ethereum, Base and Arbitrum. A *shielded pool* is a
smart contract that holds everyone's tokens together and tracks who owns what using cryptography
instead of public balances. You deposit on one chain and later withdraw on any of the three, to any
address. Nothing on-chain connects your deposit to your withdrawal. The pool's accounting and every
security check live on Ethereum, and the rollups' own built-in messaging carries instructions to and
from Base and Arbitrum. It is code-complete for local and testnet. It is not on mainnet.

## 2. The 60-second version

- **Deposit** tokens on Ethereum, Base or Arbitrum. You get a secret *withdrawal code*. Whoever holds the code owns the money.
- **Withdraw** by pasting the code. Your browser builds a *zero-knowledge proof*: a short piece of math that proves "I own some unspent deposit in this pool" without saying which one.
- A **relayer** (a paid helper service) submits the withdrawal, so none of your own addresses touch the pool.
- **Ethereum is the hub.** It checks every proof, keeps one global list of spent deposits, and pays out on Ethereum directly or tells Base/Arbitrum to pay.
- **L2 deposits** (Base, Arbitrum) become usable in about 15–30 minutes when *validators* vouch for them, or after the rollup's own bridge confirms them (days on Base). The bridge path always runs, as a backstop.
- **Validators can't profit from lying.** They post stake worth 1.5× what they vouch for, and they lose all of it if the rollup bridge later shows they lied.
- **Nobody can take funds.** There are no upgradeable contracts. The admin key can only pause new deposits, and pause spends for at most 72 hours once per 30 days.

## 3. Cast of characters

| Who | What it does | Can | Can't |
|---|---|---|---|
| **User** | Deposits, withdraws, transfers privately | Spend notes they hold the key for | Spend someone else's note, spend twice, create money |
| **Web app / CLI** | Wallet software. Web: one code per deposit. CLI: a full wallet with a 24-word phrase | Build proofs locally, scan chains, warn about privacy mistakes | Recover a lost code |
| **Relayer** | Submits the withdrawal transaction on Ethereum and pays its gas, for a fee | Delay or drop a withdrawal (you retry with another) | Change recipient, amount, chain, fees or deadline |
| **Validator** | Watches L2 deposits and signs "this deposit really happened" so it can be used fast. Bonds stake on Ethereum | Vouch for deposits; slow the fast lane by going offline | Profit from lying (loses all stake); block withdrawals; touch payouts |
| **Finalizer** | Carries *checkpoints* (lists of L2 deposits) from Base/Arbitrum to Ethereum through the rollup bridge, then processes them | Delay checkpoints (anyone can do the job instead) | Change any message |
| **Keeper** | Moves liquidity between chains (*rebalancing*) and completes those transfers | Delay rebalances | Move money except surplus to deficit, within fixed rules |
| **Attester** (testnet DAI only) | A small service that signs off DAI rebalance transfers, imitating Circle's API | Release tokens held by the testnet DAI mover | Anything else. Not used for USDC; not for mainnet |
| **LP** (liquidity provider) | Deposits tokens on Ethereum so withdrawals can be paid before L2 deposits are confirmed. Earns 60% of protocol fees | Add, and remove when Ethereum liquidity and the safety rule allow | Withdraw liquidity that is backing unconfirmed fast deposits |
| **Guardian** | Emergency admin key (a team multi-sig on mainnet) | Pause new inflows; one 72-hour spend pause per 30 days; adjust caps within hard limits; renounce forever | Move funds, change the verifier or fees, upgrade anything, block exits beyond 72 h |
| **HubCore** (Ethereum) | The heart: the Merkle tree of all deposits, the spent list, proof checking, payouts and release messages | — | — |
| **DepositManager** (Ethereum) | Takes Ethereum deposits; accepts validator attestations; receives and processes checkpoints; handles fraud proofs | — | Accept a commitment from anyone (it computes them itself) |
| **StakeManager** (Ethereum) | Validator registry, bonds, epochs, *exposure* (what each validator vouched for and isn't confirmed yet), slashing, rewards | — | Let a validator withdraw stake that backs open exposure |
| **LiquidityManager** (Ethereum) | The Ethereum vault. Keeps the per-chain liquidity ledger, LP shares (it is also the xLP token), insurance, and starts rebalances | — | Pay out more on a chain than that chain is known to hold |
| **Spokes** (Base, Arbitrum) | One contract per L2. Hold that chain's tokens, take deposits, send checkpoints, pay releases | Pay only on a message proven to come from HubCore | Pay the same release twice |
| **Groth16 verifier** (Ethereum) | Checks withdrawal proofs. Generated by tooling from the circuit, never hand-edited | — | Be swapped out (immutable) |

## 4. Where things live

```
                 ETHEREUM (the hub)
   HubCore  DepositManager  StakeManager  LiquidityManager (L1 vault)
   Groth16Verifier  Poseidon hash libs  two bridge adapters
          |                                          |
   Base's built-in bridge                  Arbitrum's built-in bridge
          |                                          |
     BASE: Spoke                              ARBITRUM: Spoke
     (holds Base tokens)                      (holds Arbitrum tokens)
```

Testnet = Ethereum Sepolia (11155111), Base Sepolia (84532), Arbitrum Sepolia (421614). Mainnet would be
Ethereum, Base and Arbitrum One. There is **one pool per token**: each pool is a separate set of
contracts with its own tree and its own anonymity set. All were deployed by the same EOA
`0x137D61d2899ab1cf1003649C04c4549B1f5B6Db5` through a CREATE3 factory
(`0x4A4246939dBb20d7D53C8dF8e5a506C4Ac8aBC44`), so addresses are predictable across chains.

| Contract | USDC pool | DAI pool v2 | DAI pool v1 (legacy) |
|---|---|---|---|
| Chains | Sepolia + Base + Arbitrum | Sepolia + Base | Sepolia + Base |
| HubCore | `0x060F273d2844585A1814Ba7f41ffa876d8a6048D` | `0x1E9237E03B8044512CCe32b90e056Fecc81ccD99` | `0x204D51ef33E295925464fA2E0565607f39CDd9A5` |
| DepositManager | `0x3839e7D608e46D8563f34EA18dCde1D837727838` | `0xC0e2D0B8D628f0e1934e24F186892C93e1C6BeC8` | `0x7C593d95eBE4fF06E0a52a60118B0533720DeADf` |
| StakeManager | `0x85Af2A1d4C19A20d4FA1f6E8A35B3f7d1f1e9606` | `0x564719c4A9c932De5c2E4BcC5846c8B00d195066` | `0xC202031eE71a105138C47F4AAf754295eb6A9634` |
| LiquidityManager | `0x99D206623eF7eeA147551780DfD84921c6ca6277` | `0x94E7a4Adc051786142362ADd0BFd0f903352d471` | `0xCE63ee7c5d3a0aE32eb6dA2430501D8b993ff1dB` |
| Groth16Verifier | `0x23Fd314454d38bCaedf9d484DCb2bE7eBB13A69F` | `0xBA2cdc11f040012B6bca96DCBcECE0A4b8bfb84f` | `0x39fC7C7D757aD849E09C665f92B7B3DE4f7Ee91A` |
| OpStackHubAdapter | `0xEE785956481104069c329D7249d7Da9A2a8cF6A1` | `0xbEdcF9741FD76827315217956412ce4F275d349f` | `0x3bCA31797E2c68F22CcCa547d7C9B90d6d1D444E` |
| ArbitrumHubAdapter | `0x4E1cD50C7539f46Ec01cf9EB1c7C5Ad3375F497a` | — | — |
| Base Spoke | `0xD92406E70Cf210e3bcec7616973C7388Fd3944c7` | `0xEb8c3aEF65E277daA7dC85A3C15902D66B74b20B` | `0x87bB2C3b8B1FcA2Fc7E8010C01899FE5b832ddc7` |
| Arbitrum Spoke | `0xB5398DD9D8Ff451dDF247B104B9e41460a6cD214` | — | — |
| Token (Sepolia / Base / Arb) | Circle test USDC `0x1c7D…7238` / `0x036C…CF7e` / `0x75fa…AA4d` | team test DAI `0x36e0…0aFe` / `0x60df…8EE4` | same DAI |
| Mover between chains | Circle CCTP V2 | LockReleaseMessenger: Sepolia `0x6f975f17ABc22218D6675d6bE3e23144e1f72E2D`, Base `0x80474970AC2c422A56D31a1971D80F0300E95A9b` | none |

**DAI v1 is legacy and withdraw-only.** It had no way to move DAI between chains, so each chain could
only pay out DAI deposited on that chain. v2 replaced it. The web app hides v1 for new deposits but still
accepts old `txdai1…` codes for withdrawal. Live addresses are in `deployments/testnet*.json`.

## 5. Life of a deposit

### 5.1 The withdrawal code (web app)

- The code is **32 random bytes** from the operating system's secure random generator.
- It is written in **bech32m**, a text format with a built-in checksum, so typos are caught before anything is looked up.
- The prefix says which pool it belongs to: `txnote1…` (USDC), `txdai21…` (DAI v2), `txdai1…` (legacy DAI). Mainnet drops the `t`; local uses `l`.
- The app stretches the code (HKDF) into the same keys the CLI wallet uses: a *spending key* and an *encryption key*. A code is a tiny one-purpose wallet.
- The app stores nothing and sends the code nowhere. **Lose the code and the money is gone.** Nobody, including the team, can recover it.

### 5.2 Note, commitment, tree

- A **note** is a private record: amount, token, owner key, and a random *blinding* number.
- Its **commitment** is a hash of the note (Poseidon hash, a hash designed for zero-knowledge circuits). The commitment reveals nothing about the owner.
- Every commitment goes into one **Merkle tree** on Ethereum: a structure that lets you prove "my commitment is in here" with a short path of hashes. Depth 24, so about 16.7 million leaves. The hub remembers the last 100 *roots* (the tree's top hash).
- The note itself is encrypted to the code's key and published, so the code holder can find it later.
- **The hub computes every deposit commitment itself** from the amount actually received. A depositor or validator can never insert a commitment worth more than what was deposited.

### 5.3 (a) Deposit on Ethereum

1. The app creates a note, encrypts it, and asks your wallet to approve exactly the amount (no unlimited approvals).
2. Your wallet calls `DepositManager.deposit`. Tokens go into the LiquidityManager vault.
3. In the same transaction the hub computes the commitment and inserts it into the tree. Ethereum liquidity goes up by the amount.
4. Spendable after one block. Wallets that read only finalized blocks (mainnet, the CLI) see it after about 15 minutes.

### 5.4 (b) Deposit on Base or Arbitrum

1. Your wallet calls `Spoke.deposit` on the L2. The spoke pulls the amount plus a fixed *settlement fee* (0.10 USDC on testnet, 1.00 on mainnet) and records the deposit. The tokens now sit in the spoke.
2. The deposit must now reach the tree on Ethereum. There are two lanes, and the slow one always runs:

```
 L2 deposit ──► FAST LANE: validators sign ──► hub inserts leaf      (~15–30 min)
     │                                              │
     │                                   exposure held until confirmed
     ▼                                              ▼
 SLOW LANE: checkpoint via the rollup's bridge ──► hub confirms (fast) or inserts (slow)
                                                   Base: ~7 days   Arbitrum: ~6.4 days (mainnet)
```

- **Fast lane.** Validators wait until the L2 block is final, check the deposit on their own node, and sign a batch. When enough stake has signed (section 9, item 5), anyone submits the batch to DepositManager and the leaf goes in. The money is spendable. The chain's liquidity counter does **not** go up yet.
- **Slow lane.** A finalizer calls `Spoke.sendCheckpoint`, which sends a list of deposits to Ethereum through the rollup's bridge. When it arrives, anyone calls `processCheckpoint`. Each item is either *confirmed* (it matches what validators signed: their exposure clears) or *inserted* (validators never signed it). Only now does the chain's liquidity counter go up.
- **The "rollup bridge" is not a third-party bridge.** Base and Arbitrum are rollups: they post their data to Ethereum, and each ships its own official messaging system between Ethereum and itself (OP Stack messengers for Base; inbox, retryable tickets and outbox for Arbitrum). xpool trusts it exactly as much as anyone holding funds on that rollup already does. No extra party, signer set or token is involved.
- **Why Base takes days.** Messages from Ethereum *down* to an L2 arrive in minutes, because the L2 reads Ethereum directly. Messages from an L2 *up* to Ethereum must wait out the rollup's challenge window: someone posts a claim about the L2's state, and anyone has about 7 days to dispute it with a fault proof. Ethereum accepts the message only after that. Arbitrum's window is about 6.4 days. On testnet: Base Sepolia takes days, Arbitrum Sepolia closer to an hour or two (approx.).
- A deposit can never get stuck. If validators are offline, full, or the deposit is too big for the fast lane, the slow lane inserts it.

## 6. Life of a withdrawal

```
 browser: paste code → scan 3 chains → build proof (~1 s) → random wait → relayer
                                                                          │
 Ethereum HubCore.transact: checks → mark spent → insert change → pay ◄───┘
        │                                                 │
   destination = Ethereum: paid in the same tx     destination = Base/Arbitrum:
                                                   release message via rollup bridge
                                                   → spoke pays (Base ~1–3 min, Arb ~10–15 min)
```

1. **Paste the code.** No wallet needed.
2. **Scan.** The browser downloads every relevant event from all three chains and tries to decrypt each note with the code's key. It never asks a server about a specific note. Everything stays in memory.
3. **Check liquidity.** The app checks the destination chain can pay that amount, and gets a fee quote from the relayer.
4. **Prove.** The browser builds a Groth16 proof. In one sentence, it proves: *"I know the secret key for unspent notes in this tree worth at least this much, and here are their one-time spend tags, without revealing which notes they are."* The proof also locks in the recipient, chain, amount, fees and deadline. Any leftover goes back to the same code as a new *change* note.
5. **Wait a random few seconds** (up to 15 s testnet, 2 min mainnet), then send to the relayer.
6. **Relayer submits** `HubCore.transact` on Ethereum, after simulating it.
7. **HubCore checks**, in order: spends aren't paused; the deadline and hub address are right; fees match the rules (protocol fee exactly 0.10%, relayer fee a multiple of the bucket); the tree root is a recent one; both *nullifiers* (one-time spend tags, see 9.1) are unused; the proof's hash of the extra data matches; the proof verifies; the destination chain has enough liquidity. Any failure reverts and nothing is spent.
8. **Pay.** To Ethereum: paid from the vault in the same transaction. To Base or Arbitrum: the hub logs a numbered *release* and sends it through the rollup bridge. The spoke checks the message really came from HubCore and pays. If the spoke is briefly short (a rebalance is in flight), the release waits in a queue and pays when the tokens land.
9. If a release message gets lost, anyone can re-send it (`resendRelease`). A spoke pays each release number at most once, so re-sending is always safe.

## 7. How money moves

```
            ETHEREUM: LiquidityManager vault (Eth deposits, LP money, insurance)
            ledger L[ETH]   L[BASE]   L[ARB]
               ▲    │ rebalance (CCTP for USDC; LockReleaseMessenger for test DAI)
               │    ▼
     BASE Spoke ◄────────────► ARBITRUM Spoke
     tokens deposited on Base   tokens deposited on Arbitrum
```

- Tokens physically stay where they were deposited: the Ethereum vault, the Base spoke or the Arbitrum spoke. Withdrawals don't move them across chains; the hub just tells a chain to pay from what it holds.
- **The ledger `L[c]`** is the hub's conservative count of free tokens on chain c. It rises on Ethereum deposits, LP deposits, slashed stake, rebalances in, and L2 deposits **once a checkpoint confirms them**. It falls when a withdrawal reserves funds, on Ethereum payouts, and on rebalances out.
- **A chain can only pay what it holds.** `transact` reserves the amount from `L[dst]` or reverts with `InsufficientLiquidity`. Since the ledger never counts unconfirmed or missing tokens, a release can wait at most for a rebalance already in flight, never for money that doesn't exist. The web app greys out chains that can't pay.
- **Rebalancing.** Each chain has a target share (USDC: 30% Ethereum, 35% Base, 35% Arbitrum; DAI v2: 50/50). Anyone may call `rebalance`, but only from a chain above target to one below, and only above a minimum size. A keeper does this in practice.
  - **USDC:** Circle's CCTP. The source burns USDC, Circle signs an attestation, the keeper submits it, USDC is minted at the destination vault. CCTP only moves pool liquidity in bulk, never a user's withdrawal.
  - **DAI (testnet v2):** CCTP doesn't support DAI. `LockReleaseMessenger` copies CCTP's interface so the same pool code works: "burn" locks DAI in the messenger on the source chain; "mint" releases DAI from the messenger's own stock on the destination when our `test-attester` service signs the message. Whoever holds the attester key can release that stock. Fine for testnet, not for mainnet.

## 8. Who pays gas, at each step

| Step | Who pays gas | Paid back by |
|---|---|---|
| Deposit (Ethereum or L2) | User | Nobody (it's the user's cost) |
| Withdrawal / transfer (`transact` on Ethereum) | Relayer | `relayerFee`, taken from the note inside the proof |
| Arbitrum release message (retryable ticket ETH) | Relayer, as ETH sent with `transact` | Built into the relayer's fee quote |
| Fast-lane attestation (`submitAttestation`) | Validator / submitter | Settlement fee "insert" part (0.075 of 0.10 on testnet), once the batch is confirmed |
| `sendCheckpoint` on L2 | Finalizer | Nobody (cheap) |
| Proving/finalizing the checkpoint on Ethereum, `processCheckpoint` | Finalizer / processor | Settlement fee "final" part (0.025), plus "insert" for slow-lane items |
| Rebalancing and completing mints | Keeper | Nobody in v1 (team-run) |
| Fraud proofs | Anyone | Up to 10% of the slashed stake |

**Fees the user pays**

| Fee | Amount | Where it goes |
|---|---|---|
| Protocol fee | 0.10% of each withdrawal (none on transfers) | 30% validators, 60% LPs, 10% insurance |
| Relayer fee | Quoted by the relayer; must be a multiple of a fixed bucket (testnet 0.01, mainnet 0.25 USDC) so odd amounts can't fingerprint you | The relayer, paid on Ethereum |
| L2 settlement fee | Fixed per chain: 0.10 USDC testnet, 1.00 mainnet (DAI v2: 0.10 DAI) | Whoever inserts and confirms the deposit |

## 9. Why it's secure

Each line: **claim → why it holds.**

1. **No one can spend twice.** → Every spend reveals a *nullifier*, a tag computed from the owner's secret key and the note's position. Same note always gives the same tag. HubCore keeps **one** spent-tag set for all chains, on Ethereum. A second spend, even aimed at a different chain, is rejected (`NullifierSpent`). Payouts on L2s come only from HubCore's log, so a second payout can't exist.
2. **No one can steal a note.** → A valid proof needs the note's secret key. Without the code, nobody can produce one. The math can't create value either: inputs must equal outputs plus what leaves, with range checks on every amount.
3. **No one can redirect a withdrawal.** → The recipient, chain, amount, relayer, fees, deadline and encrypted outputs are hashed into the proof's public input (`extDataHash`). Change any of them and the proof fails.
4. **The relayer can't cheat.** → All it can change is whether and when to submit. Its fee is fixed in the proof. The deadline stops it from sitting on a proof. If it drops you, use another relayer; nothing was spent.
5. **Validators can't profit from lying.** → Three rules:
   - A batch needs signers with stake ≥ 1.5× its value and ≥ 2/3 of the stake on that chain.
   - Each signer's *exposure* (vouched-for, unconfirmed value) must stay ≤ its stake ÷ 1.5. Exposure clears **only** when the rollup bridge's checkpoint shows the exact same data. Never on a timer. Stake backing open exposure can't be withdrawn.
   - A lie is always caught: a wrong deposit shows up as a *mismatch* when the checkpoint is processed, a made-up one as an *absence* anyone can prove, and signing two versions as *equivocation*. Every signer of a bad batch loses **all** its stake and is banned for good.

   **Theorem 9.4 in one paragraph.** Any group of validators, even all of them, can insert fake value of at
   most their stake ÷ 1.5, because every fake batch stays on their exposure and exposure is capped. The
   rollup bridge eventually delivers the real deposit list, which exposes every fake batch. Then all of
   those validators' stake is taken: at least 1.5× what they faked. The prover's reward is capped so the
   rest always covers the loss, and it goes to insurance. So liars lose more than they take and the pool
   ends up whole. The worst case is a temporary shortage until the proof lands, capped by a safety rule:
   unconfirmed fast-lane value ≤ half of (LP assets + insurance).
6. **It works with every validator offline.** → The slow lane needs only the rollup bridge and anyone willing to run a finalizer. Ethereum deposits and all withdrawals need no validators. Tested end to end ("validators offline → slow lane").
7. **The admin is boxed in.** → The guardian can pause new inflows (deposits, fast lane, LP adds) for as long as it wants, and pause spends for 72 hours, at most once per 30 days, auto-expiring. It can tweak caps only inside hard limits set at deploy. It can't move funds, change the verifier, fees or bridge adapters, or block release delivery, LP exits or unbonding. It can renounce itself permanently.
8. **No upgrades.** → No proxies, no upgrade functions. Every cross-contract reference is fixed at deploy. What was deployed is what runs.

What xpool does trust: Ethereum, each rollup's own bridge (as every user of that rollup does), the
cryptography (Poseidon, Groth16, with an honest trusted setup), and Circle for USDC. Circle can freeze
USDC, including the pool's vaults. That risk is accepted and stated.

## 10. What's private and what isn't

| Public | Private |
|---|---|
| Deposits: chain, depositor address, amount, time, the encrypted note | Which deposit funded which withdrawal |
| Withdrawals: chain, recipient, amount, fees, relayer, time | Balances held inside the pool |
| That an address used xpool at all | Private transfers: sender, recipient, amount |
| Totals per chain and rebalances | Which notes a code or wallet owns |
| Your IP, to the RPC and relayer, unless you use Tor | — |

The cryptography hides the link. Metadata can still give it away: depositing 1,234.56 and withdrawing
1,234.56 an hour later on a quiet day is easy to match. So the wallet warns by default. The web app shows
these warnings and needs explicit confirmation to continue:

- **Recent deposit:** under 24 hours since your deposit.
- **Small crowd:** fewer than 20 deposits since yours.
- **Own wallet:** the recipient is the wallet you have connected.
- **Exact amount:** within 1% of what you deposited.

The CLI goes further: it blocks withdrawals under 1 hour or with fewer than 5 later deposits unless you
override, uses a fresh recipient address every time, and routes through Tor when available. Pools are
separate: USDC users and DAI users don't share a crowd.

## 11. Testnet shortcuts vs mainnet

| Area | Testnet today | Mainnet requirement |
|---|---|---|
| Trusted setup | Test setup: public phase 1 + one team contribution + beacon. Marked NOT FOR MAINNET | Multi-party ceremony with outside contributors, transcripts published |
| Guardian | The deployer EOA | Team Safe, ≥ 3 signers, at least one external (config value is unset today) |
| Deployer key | Was pasted into a chat. Treated as **burned**: anyone holding it can act as testnet guardian (still within the limits in 9.7) | Fresh key, never shared |
| Validator signing point | DAI validators sign at latest − 5 L2 blocks, not finalized (Base Sepolia's finalized head lags hours). The validator carries the reorg risk | L2 finalized only; the code refuses the shortcut on mainnet |
| Web app reads | Latest blocks (`VITE_SYNC_TAG=latest`) | Finalized blocks only (forced in code) |
| DAI mover | LockReleaseMessenger trusts one attester key | Real CCTP (USDC) or a canonical bridge |
| Validator minimum bond | 5 USDC / 5 DAI | 10,000 USDC |
| Minimum rebalance | 5 USDC, 2 DAI | 50 USDC |
| Epoch (validator set changes) | 1 hour (USDC, DAI v1), **5 minutes (DAI v2)** | 24 hours |
| Unbonding delay | 8 days | 14 days |
| Fees | Settlement 0.10, relayer bucket 0.01 | Settlement 1.00, bucket 0.25 USDC |
| Operators | One team, one machine, one relayer per pool; the script runs validators only for the DAI pools | Many independent operators |

**Mainnet gates (PRD §16), none met yet:** two independent audits (contracts, circuit, adapters, Poseidon
libraries, signers); the MPC trusted-setup ceremony; a 2-week testnet soak plus a public "break it"
period; conservative caps; monitoring, an incident runbook and the guardian Safe; legal review of
operator roles; a live bug bounty.

## 12. Numbers

| Item | Value |
|---|---|
| Circuit | `Transaction(24,2,2,1)`: tree depth 24, 2 notes in, 2 out, 1 token. 16,126 constraints, 7 public inputs |
| Proving time | approx. 1.2 s (witness + proof, Node, Apple M4). Browser is slower; not measured |
| Proof size | 256 bytes |
| Proof check on-chain | ~229k gas |
| `transact` gas | ~1.2M measured locally (one Poseidon hash ≈ 32k gas; inserting two leaves ≈ 816k). On Sepolia, with Amsterdam (EIP-8037) state-gas pricing, ~2–3M; the relayer quotes 3M |
| Withdraw arrival | Ethereum same tx; Base ~1–3 min; Arbitrum ~10–15 min |
| Validator rules | stake ≥ 1.5× vouched value, quorum 2/3 of stake, max 32 validators, prover reward ≤ 10% |
| Contract tests | approx. 265 Foundry test functions (unit, fuzz, adversarial, cross-implementation), incl. 14 invariants; the deep profile runs each invariant ~1M calls (7,813 runs × depth 128) |
| Other tests (approx.) | SDK ~112 (incl. a real Groth16 proof), services ~122, circuit ~36, CLI 7, web 8 |
| Local end-to-end | 14/14 scenarios pass (real CLI, relayer, validators, mock bridges) |
| Deploy verification | USDC 91/91 Sepolia, 26/26 Base, 26/26 Arbitrum; DAI v2 86/86 Sepolia, 26/26 Base |

## 13. Repo map and how to run

| Path | What |
|---|---|
| `contracts/` | Solidity (Foundry): hub, spokes, bridge adapters, mocks, `testnet/LockReleaseMessenger.sol`, deploy scripts, tests |
| `circuits/` | The circom circuit, tests, test trusted setup, committed artifacts (`circuits/artifacts/`) |
| `packages/sdk` | `@xpool/sdk`: keys, notes, encryption, tree, sync, prover, transaction builder, relayer client, privacy rules |
| `packages/cli` | `xpool` command-line wallet |
| `apps/web` | Web app: deposit → code → withdraw anywhere |
| `services/` | `relayer`, `validator`, `finalizer`, `keeper`, `test-attester` (testnet DAI), `mock-bridge` (local only), `common` |
| `config/`, `deployments/` | Per-pool settings and live addresses (`testnet`, `testnet-dai`, `testnet-dai2`, `mainnet`, `local`) |
| `scripts/` | `local-stack.sh`, `e2e.sh`, `deploy-testnet.sh`, `testnet-services.sh` |
| `infra/`, `fixtures/`, `docs/` | Docker local env, cross-implementation test vectors, these docs |

**Local** (three Anvil chains with mock bridges; needs Node 22, pnpm 10, Foundry):

```bash
pnpm install && pnpm --filter @xpool/sdk --filter @xpool/cli build
scripts/local-stack.sh up      # deploy, seed, start every service
scripts/e2e.sh                 # the 14-scenario end-to-end run, real proofs
VITE_XPOOL_ENV=local pnpm --filter @xpool/web dev
scripts/local-stack.sh down
```

**Testnet services** (keys in the git-ignored `.xpool/testnet.env`):

```bash
scripts/testnet-services.sh start    # relayers, finalizers, keepers, validators, DAI attester, web app
scripts/testnet-services.sh status   # logs in .xpool/testnet/logs/
scripts/testnet-services.sh stop
```

It runs relayer + finalizer + keeper for USDC (port 8080), relayer + finalizer + validator for legacy DAI
(8081), the full set plus the attester (8095) for DAI v2 (8082), and the web app at
`http://localhost:5173`. Step-by-step manual tests: `docs/TESTNET_GUIDE.md`.

## 14. FAQ for a senior engineer

**Why Groth16 on BN254?** Cheapest proof to check on Ethereum (~229k gas, uses Ethereum's built-in BN254
precompiles), tiny proofs, mature tooling (circom, snarkjs), and it builds on Tornado Nova's audited
circuit design. The cost is a per-circuit trusted setup, hence the mainnet MPC ceremony. A setup-free
system (PLONK-family) is a v2 option.

**Why put the hub on Ethereum instead of a cheaper L2?** Every rollup can verify messages from Ethereum
with no added trust, and Ethereum sees one ordering of all spends, so one nullifier set covers all three
chains. There is no extra hub chain to secure. The price is ~1.2M+ gas per spend on L1, paid via the
relayer fee.

**What if a validator lies?** Its fake deposit gets in, and its exposure stays open. The rollup bridge's
checkpoint later shows the real data. Mismatch is detected automatically when the checkpoint is
processed; absence and double-signing are proven by anyone. All signers lose all stake (≥ 1.5× the fake
value). The fake note stays in the tree, backed by the slashed stake. See section 9, item 5.

**What if the relayer disappears?** Nothing is lost. Its only power is not submitting. Send the withdrawal
through another relayer; an unsubmitted proof spent nothing, and if both end up submitting, the second
fails on the already-spent nullifier. The CLI can also self-submit,
which links your address (it requires an explicit flag).

**What stops the guardian?** The contract code. Its only functions are: pause inflows, a 72-hour spend
pause with a 30-day cooldown, caps within fixed bounds, renounce. No function moves funds or swaps
contracts, and nothing is upgradeable.

**Can the team freeze funds?** Not for good. The worst it can do is stop new deposits and pause spends for
72 hours once a month. Circle can freeze USDC, including the vault; that is a stated USDC risk, not a team
power.

**Why one pool per token?** The circuit treats all notes in a tree as one token (token id is a circuit
constant in v1), and each token needs its own liquidity ledger, rebalancing and fees. So each token gets
its own contracts, tree and anonymity set. Adding a token = new config, deploy, rebuild the web app.

**Why does DAI need a different mover?** Circle's CCTP moves only USDC. Without a mover, DAI v1 could pay
on a chain only what was deposited there. The testnet LockReleaseMessenger mimics CCTP's interface so the
pool code is unchanged, but it trusts one attester key. A mainnet non-USDC pool needs a canonical bridge.

**Why does a withdrawal to Base take minutes but a deposit from Base take days to confirm?** Ethereum → L2
messages are read directly by the L2 (minutes). L2 → Ethereum messages must wait out the rollup's ~7-day
challenge window. The fast lane exists to hide that wait, backed by validator stake.

**What happens on an L2 reorg?** On mainnet validators sign only finalized L2 blocks, which don't reorg.
The slow lane uses only data the rollup bridge has proven to Ethereum. On testnet validators sign 5 blocks
behind the tip. If a signed deposit reorgs away, the checkpoint shows the difference, the validator is
slashed, and Theorem 9.4 still keeps the pool whole.

**What if a user loses the code?** The money is gone. The app stores nothing, nobody else holds the key,
and no admin can move funds. Funds are not "frozen for the team"; they are simply unspendable.

**What if the destination chain is short of money?** The wallet checks first and the hub refuses to reserve
more than the chain holds, so nothing is spent. If tokens are mid-rebalance, a release queues on the spoke
and pays when they arrive.
