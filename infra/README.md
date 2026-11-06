# xpool local environment

`docker compose` stack for PRD 14.1: three Anvil chains, a one-shot deployer, the LOCAL-ONLY
mock bridge / mock CCTP attester, four validators, a relayer, a finalizer and a keeper.

```sh
cd infra
make up                 # pnpm install (if needed) → build images → start everything
make logs S=relayer     # follow one service (omit S for all)
make status             # mock-bridge queue / failed deliveries / failure injection
make down               # stop and wipe all state (chains restart from genesis)
make e2e                # scenario matrix (scripts/e2e.sh, added after merge)
```

## Topology

| Service | Image | Host port | Role / key (Anvil default mnemonic) |
|---|---|---|---|
| `anvil-hub` | foundry | 8545 | "Ethereum", chain 31337 |
| `anvil-base` | foundry | 8546 | OP-style spoke, chain 31338 |
| `anvil-arb` | foundry | 8547 | Arbitrum-style spoke, chain 31339 |
| `deployer` | foundry | — | one-shot `contracts/script/deploy-local.sh` → `deployments/local.json` (acct 0) |
| `mock-bridge` | `services/mock-bridge` | 8090 | relays mock messages + signs mock CCTP (acct 1); Iris-compatible API + `/admin/*` |
| `validator-1..4` | `services/validator` | — | operators acct 5–8, signers acct 9–12, gossip on :7000 inside the network |
| `relayer` | `services/relayer` | 8080 | `/v1/info`, `/v1/quote`, `/v1/relay`, `/v1/status/:id` (acct 2) |
| `finalizer` | `services/finalizer` | — | checkpoints, processing, release re-delivery (acct 3) |
| `keeper` | `services/keeper` | — | rebalancing, CCTP mint completion, `processQueue` (acct 4) |

Every Node service exposes `/metrics` and `/healthz` on container port 9100 (not published).
Start order: anvils healthy → deployer completed → services (keeper also waits for mock-bridge).

Anvil runs with `--block-time 1 --slots-in-an-epoch 1` so the `finalized` tag trails `latest` by
2 blocks — the validators watch deposits at `finalized`, exactly as on testnet — and with
`--accounts 20` (accounts up to 12 are used).

## Configuration

All services read `config/<XPOOL_ENV>.json` and `deployments/<XPOOL_ENV>.json` (mounted read-only).
`DEPLOYED_MOCK` placeholders in `config/local.json` are resolved from `deployments.mocks`.

| Variable | Used by | Meaning |
|---|---|---|
| `XPOOL_ENV` | all | `local` / `testnet` / `mainnet` |
| `XPOOL_ROOT` | all | directory holding `config/` and `deployments/` |
| `XPOOL_RPC_<chainId>` | all | comma-separated RPC override (≥2 per chain on testnet/mainnet for validators) |
| `STATE_DIR` | all | sqlite state (slashing protection, cursors, request status) |
| `METRICS_PORT` | all | ops server (`/metrics`, `/healthz`) |
| `LOG_LEVEL` | all | `debug` / `info` / `warn` / `error` |
| `RELAYER_PRIVATE_KEY`, `RELAYER_PORT`, `RELAYER_ETH_PRICE_USDC`, `RELAYER_FEE_MARGIN_BPS`, `RELAYER_ARB_MARGIN_BPS` (≥3000) | relayer | key / API port / fee inputs |
| `VALIDATOR_OPERATOR_KEY`, `VALIDATOR_SIGNER_KEY` | validator | two different keys: operator pays gas + holds stake; signer only signs |
| `VALIDATOR_PEERS`, `VALIDATOR_PORT` | validator | gossip peers (comma-separated URLs) / gossip port |
| `VALIDATOR_BOOTSTRAP_BOND`, `VALIDATOR_BOOTSTRAP_ALLOCATIONS` | validator | optional register → bond → allocate (`31338:x,31339:y`; default equal split). Locally mints MockUSDC if short |
| `FINALIZER_PRIVATE_KEY`, `FINALIZER_CHECKPOINT_EVERY_N`, `FINALIZER_CHECKPOINT_EVERY_SEC` | finalizer | key / checkpoint schedule |
| `KEEPER_PRIVATE_KEY`, `KEEPER_IRIS_URL` | keeper | key / Iris base (default: sandbox on testnet, production on mainnet) |
| `MOCK_BRIDGE_PRIVATE_KEY`, `MOCK_*_DELAY_SEC`, `MOCK_FAIL_NEXT` | mock-bridge | relayer+attester key / delays (default `config/local.json` → `mocks`) / failure injection |

Keys are read from environment variables only and removed from `process.env` after loading.

## Failure simulation (retry tests, PRD 15.4)

`MOCK_FAIL_NEXT=op-l1-to-l2:1,arb-l1-to-l2:1` (or `make fail-next ROUTE=arb-l1-to-l2 N=1`) makes
the next delivery on a route run with too little gas:

- `op-l1-to-l2` / `op-l2-to-l1`: the mock messenger records the message as failed (replayable).
- `arb-l1-to-l2`: the impersonated retryable execution reverts (like an un-redeemed ticket).

Then either `POST /admin/redeliver {"key": "<key from /admin/status>"}` (manual redeem / OP replay)
or let the relayer/finalizer fall back to `HubCore.resendRelease`.

## Cross-check after merge

- `contracts/script/deploy-local.sh`: the deployer passes `HUB_RPC_URL`, `BASE_RPC_URL`,
  `ARB_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `MOCK_RELAYER_ADDRESS`, `CCTP_ATTESTER_ADDRESS`,
  `DEPLOYMENTS_OUT`; align names with the script. It must exit 0 and write `deployments/local.json`.
- Validator seeding: the validators self-register/bond/allocate (`VALIDATOR_BOOTSTRAP_BOND`); if
  the deploy script seeds them too, drop that variable. LP seeding is left to the deploy script / e2e.
