# deployments/

`<env>.json` is written by the deploy scripts in `contracts/script/` and read by the SDK, the CLI and the
services. `local.json` is regenerated on every local run (git-ignored). `testnet.json` / `mainnet.json`
are committed after a deployment passes verification (PRD 14.5 step 7).

## Schema

```jsonc
{
  "environment": "testnet",
  "deployer": "0x…",            // the EOA that deployed on ALL three chains
  "create3Factory": "0x…",      // same address on every chain
  "hub": {
    "chainId": 11155111,
    "deployBlock": 0,           // block the hub deploy started at (start log scans here)
    "usdc": "0x…",
    "contracts": {
      "HubCore": "0x…", "DepositManager": "0x…", "StakeManager": "0x…", "LiquidityManager": "0x…",
      "Groth16Verifier": "0x…", "PoseidonT3": "0x…", "PoseidonT4": "0x…",
      "OpStackHubAdapter": "0x…", "ArbitrumHubAdapter": "0x…"
    }
  },
  "spokes": {
    "84532":  { "name": "base",     "stack": "opstack",  "deployBlock": 0, "usdc": "0x…", "contracts": { "Spoke": "0x…" } },
    "421614": { "name": "arbitrum", "stack": "arbitrum", "deployBlock": 0, "usdc": "0x…", "contracts": { "Spoke": "0x…" } }
  },
  "mocks": { /* local only, see below */ }
}
```

- Spoke `deployBlock` uses the spoke's own clock (`ArbSys.arbBlockNumber()` on Arbitrum), the same one
  `Spoke.l2BlockNumber()` uses. `deployBlock` is taken when the script runs, i.e. at or slightly before
  the real deploy block. Before a spoke is deployed its entry holds the predicted address and `deployBlock: 0`.
- `mocks` (local only), keyed by chain id:
  `31337`: `MockUSDC`, `MockL1CrossDomainMessenger`, `MockInbox`, `MockBridge`, `MockOutbox`,
  `MockTokenMessengerV2`, `MockMessageTransmitterV2`;
  `31338`: `MockUSDC`, `MockL2CrossDomainMessenger`, `MockTokenMessengerV2`, `MockMessageTransmitterV2`;
  `31339`: `MockUSDC`, `MockArbSys` (`0x…64`), `MockTokenMessengerV2`, `MockMessageTransmitterV2`.
- Testnet / mainnet external addresses (bridges, CCTP) are not repeated here; they come from `config/<env>.json`.

## Addresses: CREATE3

Every protocol contract is deployed through `Create3Factory` (itself deployed with CREATE2 through
`0x4e59b44847b379578588920cA78FbF26c0B4956C`). Address = f(factory, deployer, salt) with
salt = `keccak256("<config.salt>/<Name>")` and names `PoseidonT3`, `PoseidonT4`, `Groth16Verifier`,
`StakeManager`, `LiquidityManager`, `DepositManager`, `HubCore`, `OpStackHubAdapter`,
`ArbitrumHubAdapter`, `BaseSpoke`, `ArbitrumSpoke`. The factory namespaces salts by `msg.sender`, so
**the same deployer EOA must be used on Sepolia, Base Sepolia and Arbitrum Sepolia** — otherwise the
spokes land at addresses the hub adapters don't know (and nothing can fix that without a redeploy).
Never deploy anything else from that EOA through the factory with these salts, and never put code at the
spoke addresses on Ethereum (the Arbitrum adapter uses the spoke address as the retryable beneficiary).

## Testnet deployment (PRD 14.5)

All commands run from `contracts/`. Every script reads `config/testnet.json`.

| Env var | Needed by | Value |
|---|---|---|
| `XPOOL_ENV=testnet` | all | selects `config/testnet.json` |
| `DEPLOYER_PRIVATE_KEY` | DeployHub, DeploySpoke, Seed `advance()` | the one deployer EOA, funded with ETH on all 3 chains |
| `GUARDIAN` | DeployHub, VerifyDeployment | team Safe on Sepolia (or set `params.guardian` in the config) |
| `DEPLOYER` | PredictAddresses (optional) | the deployer address, if you don't want to pass the key |
| `SEED_OPERATOR_KEYS`, `SEED_SIGNERS`, `SEED_LP_KEY` | Seed | comma-separated operator keys / signer addresses; LP key (accounts hold Sepolia USDC + ETH) |
| `SEED_BOND`, `SEED_LP_AMOUNT` | Seed (optional) | USDC units (6 decimals) |
| `SEPOLIA_RPC`, `BASE_SEPOLIA_RPC`, `ARB_SEPOLIA_RPC` | — | RPC URLs used below |

Before step 2, confirm every external address in `config/testnet.json` against the official docs
(Base L1 messenger / portal and CCTP V2 were filled from memory) and that the Groth16 verifier from the
circuits workstream is in `contracts/src/verifier/Groth16Verifier.sol` (`forge build` must include it).

```bash
export XPOOL_ENV=testnet
# 1. predict (no RPC). Writes deployments/testnet.predicted.json
DEPLOYER=0xYourDeployer forge script script/PredictAddresses.s.sol

# 2. hub on Ethereum Sepolia: Create3Factory (if absent), PoseidonT3/T4, Groth16Verifier, StakeManager,
#    LiquidityManager, DepositManager, HubCore, OpStackHubAdapter, ArbitrumHubAdapter. Writes deployments/testnet.json
forge script script/DeployHub.s.sol   --rpc-url $SEPOLIA_RPC      --broadcast --slow

# 3. spokes: OpStackSpoke on Base Sepolia, ArbitrumSpoke on Arbitrum Sepolia (stack picked by chain id)
forge script script/DeploySpoke.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast --slow
forge script script/DeploySpoke.s.sol --rpc-url $ARB_SEPOLIA_RPC  --broadcast --slow

# 4. verify each chain (read-only; must print "failed 0" on all three before any funds go in)
forge script script/VerifyDeployment.s.sol --rpc-url $SEPOLIA_RPC
forge script script/VerifyDeployment.s.sol --rpc-url $BASE_SEPOLIA_RPC
forge script script/VerifyDeployment.s.sol --rpc-url $ARB_SEPOLIA_RPC
#    + off-chain: verification-key hash vs the zkey (circuits/artifacts/hashes.json), explorer source verification.

# 5. seed on Sepolia, then (after epochSeconds) advance the epoch
forge script script/Seed.s.sol --rpc-url $SEPOLIA_RPC --broadcast
forge script script/Seed.s.sol --sig "advance()" --rpc-url $SEPOLIA_RPC --broadcast

# 6. smoke test (E2E script, small amounts)   7. commit deployments/testnet.json
```

All deploy steps are idempotent (a contract already at its predicted address is skipped), so a failed
or timed-out run can simply be re-run. Re-running a step never wipes the sections written by the others.

## Local

```bash
ETH_RPC=http://127.0.0.1:8545 BASE_RPC=http://127.0.0.1:8546 ARB_RPC=http://127.0.0.1:8547 \
  contracts/script/deploy-local.sh       # SEED=0 to skip seeding
```

Needs three fresh Anvil nodes with chain ids 31337 / 31338 / 31339. The helper funds Anvil mnemonic
accounts 0–19, installs `MockArbSys` at `address(100)` on 31339 (`anvil_setCode`), deploys mocks + all
contracts (`DeployLocal.s.sol` `hub()` / `base()` / `arbitrum()`), grants the mock CCTP contracts the
MockUSDC minter role, verifies all three chains, then seeds (4 validators: operators 5–8, signers 9–12;
LP 13) and advances one epoch. Account 1 is the mock-bridge relayer and the mock CCTP attester.
