# xpool v1 — implementation notes

The spec is `2026-11-06-xpool-v1-prd.md` (the PRD). This file records the decisions taken while
building it and the repository layout. If this file and the PRD disagree, this file wins (each
deviation is listed with its reason).

## Repository layout

| Path | What | Toolchain |
|---|---|---|
| `contracts/` | All Solidity: hub (Ethereum), spokes (Base, Arbitrum), adapters, mocks, deploy scripts, tests | Foundry, solc 0.8.28 |
| `circuits/` | `Transaction(24,2,2,1)` circuit, tests, test trusted setup, verifier export | circom 2.2, snarkjs |
| `packages/sdk` | `@xpool/sdk`: keys, crypto, notes, sync, prover, tx, relayer client, privacy, chains | TypeScript, viem |
| `packages/cli` | `xpool` CLI wallet | TypeScript |
| `services/relayer` | Relayer HTTP service | TypeScript |
| `services/validator` | Validator node (watcher, attester, slashing-protection DB, gossip, submitter, watchtower) | TypeScript |
| `services/finalizer` | Checkpoint sender/prover/finalizer, release re-delivery | TypeScript |
| `services/keeper` | Rebalancer + CCTP mint completion + processQueue | TypeScript |
| `services/mock-bridge` | LOCAL ONLY: relays mock OP / Arbitrum messages and mock CCTP | TypeScript |
| `config/` | `local.json`, `testnet.json`, `mainnet.json` (PRD 14.6) | — |
| `deployments/` | `<env>.json` written by deploy scripts | — |
| `fixtures/` | Cross-implementation test vectors (Poseidon, commitments, nullifiers, extDataHash) | — |
| `infra/` | `docker-compose.yml` for the local 3-chain environment | Docker |

## Deployment targets

| Env | Hub (all hub contracts) | Spoke 1 | Spoke 2 |
|---|---|---|---|
| local | Anvil 31337 | Anvil 31338 (OP-style) | Anvil 31339 (Arbitrum-style) |
| testnet | **Ethereum Sepolia (11155111)** | **Base Sepolia (84532)** — `OpStackSpoke` | **Arbitrum Sepolia (421614)** — `ArbitrumSpoke` |
| mainnet | Ethereum (1) | Base (8453) | Arbitrum One (42161) — gated by PRD §16 |

Hub contracts on Sepolia: `PoseidonT3`, `PoseidonT4`, `Groth16Verifier`, `StakeManager`,
`LiquidityManager`, `DepositManager`, `HubCore`, `OpStackHubAdapter`, `ArbitrumHubAdapter`.

## Cross-cutting decisions

1. **CREATE3 for every protocol contract** (deviation from "CREATE2 via 0x4e59…" in PRD 14.5).
   Hub ↔ adapters ↔ spokes and HubCore ↔ DepositManager ↔ LiquidityManager ↔ StakeManager reference
   each other as `immutable`s, which is a cycle under CREATE2 (address depends on init code). With
   CREATE3, address = f(factory, deployer, salt), so all addresses are predicted first and every
   cross-reference stays immutable. The CREATE3 factory itself is deployed through the deterministic
   deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` (same address on every chain); salts are
   namespaced by `msg.sender`, so **the same deployer EOA must be used on all three chains**.
2. **Poseidon** is `poseidon-solidity` `PoseidonT3`/`PoseidonT4`, deployed as libraries and called by
   `STATICCALL` through `IPoseidonT3/IPoseidonT4` at immutable addresses (no linking).
3. **Validator ids are `uint32`** (registry-wide, never reused), not `uint8`; see `IStakeManager`.
   Batches store their signer id list, so slashing always hits the right validators.
4. **Guardian and the inflow-pause flag live in `HubCore`.** `DepositManager`, `LiquidityManager`
   read `hub.guardian()` / `hub.inflowsPaused()`. One `renounceGuardian()` renounces everything.
5. **Spoke caps** (`minDeposit`, `maxDeposit`, TVL cap, settle fees) are spoke constructor
   immutables. The guardian controls spoke deposits only through `MSG_PAUSE`.
6. **Slashing loss coverage:** `slashBatch` slashes each signer `v` with `coveredLoss = x_v(B)` (its
   share of the batch). Since `Σ_v ≥ k·e_v ≥ k·x_v`, insurance receives at least `A_B` in total.
7. **Zero hashes** `Z[0..24]` are hard-coded constants in `contracts/src/libraries/ZeroHashes.sol`,
   checked by a test against `PoseidonT3` and against `fixtures/zero-hashes.json` from the SDK.
8. **Messages:** envelope `abi.encode(uint8 kind, bytes body)`; bodies per `Types.sol`
   (`Release`, `RebalanceOrder`, `bool`, `Checkpoint`). Item hash = `keccak256(abi.encode(L2Deposit))`.
9. **Local bridges** keep the real authentication semantics: the mock OP L2 messenger exposes
   `xDomainMessageSender()`; mock Arbitrum delivery impersonates the aliased adapter address on Anvil;
   a `MockArbSys` is placed at `address(100)` with `anvil_setCode`.
10. **Trusted setup** for local/testnet: Hermez `powersOfTau28_hez_final_16.ptau` + team contribution +
    beacon, marked NOT FOR MAINNET. The verifier is generated, never hand-edited.

## Ownership (parallel build)

Each workstream only creates/edits files under its own paths. Shared files
(`contracts/src/libraries/Types.sol`, `contracts/src/interfaces/**`, `config/**`) are frozen; a
workstream that needs a change reports it instead of editing.

| Workstream | Owns |
|---|---|
| circuits | `circuits/**`, `contracts/src/verifier/Groth16Verifier.sol`, `fixtures/circuit-*.json` |
| contracts-core | `contracts/src/hub/HubCore.sol`, `contracts/src/hub/LiquidityManager.sol`, `contracts/src/libraries/{MerkleTreeWithHistory,ZeroHashes,Field}.sol`, `contracts/test/core/**` |
| contracts-fastlane | `contracts/src/hub/DepositManager.sol`, `contracts/src/hub/StakeManager.sol`, `contracts/test/fastlane/**` |
| contracts-bridges | `contracts/src/hub/adapters/**`, `contracts/src/spoke/**`, `contracts/src/mocks/**` (except MockUSDC/MockVerifier), `contracts/src/utils/**`, `contracts/script/**`, `contracts/test/bridges/**` |
| sdk-cli | `packages/**`, `fixtures/sdk-*.json`, `fixtures/zero-hashes.json` |
| services | `services/**`, `infra/**` |
