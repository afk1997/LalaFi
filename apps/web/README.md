# xpool web

One sentence is the whole interface:

- **Deposit** `[amount] [USDC] on [chain]` → you get a **withdrawal code** (`txnote1…` on testnet).
- **Withdraw** with the code → `[amount] USDC to [address] on [chain]`. A relayer submits it, so no
  address of yours touches the pool. Anything left stays on the same code.

## Run

```bash
pnpm install
# testnet (contracts in deployments/testnet.json), relayer running on :8080 with CORS for this origin
VITE_XPOOL_ENV=testnet VITE_RELAYER_URL=http://127.0.0.1:8080 pnpm --filter @xpool/web dev   # http://localhost:5173

# local 3-chain stack (scripts/local-stack.sh up)
VITE_XPOOL_ENV=local pnpm --filter @xpool/web dev

# static build for hosting (dist/ + public/circuits)
VITE_XPOOL_ENV=testnet VITE_RELAYER_URL=https://relayer.example pnpm --filter @xpool/web build
```

The relayer must allow the site's origin: `RELAYER_CORS_ORIGINS=http://localhost:5173` (comma-separated;
local env allows localhost:5173 by default). A site served over https needs an https relayer URL.

## How it works

| Piece | File |
|---|---|
| Codes: 32 CSPRNG bytes, bech32m with a network prefix + checksum, HKDF → wallet keys | `src/lib/code.ts` |
| Deposit: note owned by the code's key, encrypted to it, exact-amount approve, deposit | `src/lib/deposit.ts` |
| Balance: full event sync of all chains in memory (no per-note RPC queries) | `src/lib/scan.ts` |
| Proof: snarkjs in a Web Worker, circuit files checked against the sha256 pins in config | `src/lib/prover*.ts` |
| Withdraw: liquidity check, relayer quote, proof, random delay, relay, track | `src/lib/withdraw.ts` |
| Wallets: EIP-6963 discovery + viem, no wallet SDK | `src/lib/wallet.ts` |
| Privacy warnings (recent deposit, small crowd, own wallet, exact amount) | `src/lib/privacy.ts` |

Nothing about a code is stored or sent. The only network calls are the chain RPCs in config and the relayer.
