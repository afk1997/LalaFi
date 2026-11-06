# xpool v1 — cross-chain privacy pool (RagaSwap)

One shielded USDC pool shared by Ethereum, Base and Arbitrum. Deposit on any of the three, spend from
one global anonymity set, withdraw to any of the three. Spec: [`2026-11-06-xpool-v1-prd.md`](2026-11-06-xpool-v1-prd.md).
Decisions and deviations taken while building: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

> **Status:** v1 code complete for local + testnet. **Not for mainnet**: the trusted setup is a test
> setup and mainnet launch is gated by PRD §16 (audits, MPC ceremony, soak, legal).

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry. Hub (`HubCore`, `DepositManager`, `StakeManager`, `LiquidityManager`, adapters), spokes (`OpStackSpoke`, `ArbitrumSpoke`), mocks, deploy scripts |
| `circuits/` | circom `Transaction(24,2,2,1)`, tests, test trusted setup; committed artifacts in `circuits/artifacts/` |
| `packages/sdk` | `@xpool/sdk` — keys, notes, encryption, tree, sync, prover, tx builder, relayer client, privacy rules |
| `packages/cli` | `xpool` CLI wallet |
| `services/` | relayer, validator, finalizer, keeper, mock-bridge (local only), shared `common` |
| `infra/` | `docker-compose.yml` local environment |
| `scripts/` | `local-stack.sh` (host-native local env), `e2e.sh` (local E2E matrix) |
| `config/`, `deployments/` | per-environment config and deployed addresses ([deploy runbook](deployments/README.md)) |

## Where it deploys

| | Hub (all hub contracts) | Spoke | Spoke |
|---|---|---|---|
| testnet | Ethereum Sepolia | Base Sepolia (`OpStackSpoke`) | Arbitrum Sepolia (`ArbitrumSpoke`) |
| mainnet | Ethereum | Base | Arbitrum One |

Use the **same deployer EOA on all three chains** (CREATE3 addresses depend on it). Full steps:
[`deployments/README.md`](deployments/README.md).

## Quick start (local)

Requirements: Node 22, pnpm 10, Foundry, circom 2.2 (only to rebuild the circuit), bash.

```bash
pnpm install
pnpm --filter @xpool/sdk --filter @xpool/cli build
scripts/local-stack.sh up        # 3 Anvil chains, deploy + seed, all services (or: cd infra && make up)
scripts/e2e.sh                   # full local matrix with real proofs
scripts/local-stack.sh down
```

CLI against the local stack:

```bash
export XPOOL_HOME=/tmp/alice XPOOL_PASSWORD='...'
node packages/cli/dist/index.js --no-tor init
XPOOL_EOA_KEY=0x... node packages/cli/dist/index.js --no-tor deposit --chain base --amount 100
node packages/cli/dist/index.js --no-tor sync && node packages/cli/dist/index.js --no-tor balance
node packages/cli/dist/index.js --no-tor withdraw --to-chain arb --amount 20
```

## Tests

| Suite | Command |
|---|---|
| Contracts (unit, fuzz, invariants, adversarial, cross-implementation vectors) | `cd contracts && forge test` |
| Contracts, acceptance depth (≥1M calls per invariant, PRD 1.4 #5) | `cd contracts && FOUNDRY_PROFILE=deep forge test --match-contract Invariant` |
| Circuit (positive / negative / proving) | `pnpm --filter @xpool/circuits test` |
| SDK (incl. real Groth16 proof, Poseidon = circuit, ABIs = compiled contracts) | `pnpm --filter @xpool/sdk test` |
| CLI | `pnpm --filter @xpool/cli test` |
| Services | `pnpm -r --filter './services/**' test` |
| Local E2E (PRD 15.4) | `scripts/local-stack.sh up && scripts/e2e.sh` |

## Security claims → where they're tested

| Claim (PRD §4.4) | Tests |
|---|---|
| S1 Balance / no inflation | circuit range + balance negatives (`circuits/test`), `contracts/test/core` invariant I2 |
| S2 Spend authority | circuit "wrong sk" negative |
| S3 Global single spend | core invariant I1; E2E "same note proven for two destinations" |
| S4 Non-malleability | `HubCore` transact checks + circuit tampered-extDataHash negative + r1cs public-signal check |
| S5 Bounded validator damage (Thm 9.4) | `contracts/test/fastlane` adversarial suite (100% collusion), invariants I6, I10, I12 |
| S6 Release integrity | `contracts/test/bridges` adapter auth negatives, I7, I8 |
| S7 Liveness without validators | E2E "validators offline → slow lane" |
| S8 Bounded admin | core invariant I9, guardian tests |
| Poseidon circuit = SDK = Solidity | `contracts/test/integration/CrossVectors.t.sol`, `packages/sdk/test/cross-impl.test.ts` |

## Known limitations

See PRD §12.5 (what v1 does not hide), §11.7 (USDC/Circle risks), §19 (open questions), and the
deviations list in `docs/IMPLEMENTATION.md`. Measured numbers: `circuits/MEASUREMENTS.md`.
