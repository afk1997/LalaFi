#!/usr/bin/env bash
# Runs every off-chain service for the testnet pools + the web app, on this machine.
#   scripts/testnet-services.sh start | stop | status
# Keys come from .xpool/testnet.env (git-ignored, chmod 600). Logs: .xpool/testnet/logs/<name>.log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P="$ROOT/.xpool/testnet"; L="$P/logs"; mkdir -p "$L"
CORS="http://localhost:5173,http://127.0.0.1:5173"

svc() { # name dir VAR=VAL...
  local name=$1 dir=$2; shift 2
  ( cd "$ROOT/services/$dir" || exit 1
    env XPOOL_ENV=testnet XPOOL_ROOT="$ROOT" STATE_DIR="$P/$name" "$@" nohup node --import tsx src/index.ts >>"$L/$name.log" 2>&1 &
    echo $! >"$P/$name.pid" )
}

case "${1:-start}" in
  start)
    set -a; . "$ROOT/.xpool/testnet.env"; set +a
    # USDC pool (Sepolia hub, Base + Arbitrum spokes, Circle CCTP)
    svc relayer relayer METRICS_PORT=9301 RELAYER_TRANSACT_GAS=3000000 RELAYER_CORS_ORIGINS=$CORS RELAYER_PRIVATE_KEY=$RELAYER_PRIVATE_KEY
    svc finalizer finalizer METRICS_PORT=9303 FINALIZER_PRIVATE_KEY=$FINALIZER_PRIVATE_KEY
    svc keeper keeper METRICS_PORT=9304 KEEPER_PRIVATE_KEY=$KEEPER_PRIVATE_KEY
    # legacy DAI pool (withdrawals of existing txdai1 codes only)
    svc relayer-dai relayer XPOOL_CONFIG=testnet-dai METRICS_PORT=9311 RELAYER_PORT=8081 RELAYER_TRANSACT_GAS=3000000 RELAYER_CORS_ORIGINS=$CORS RELAYER_PRIVATE_KEY=$DAI_RELAYER_PRIVATE_KEY
    svc finalizer-dai finalizer XPOOL_CONFIG=testnet-dai METRICS_PORT=9313 FINALIZER_PRIVATE_KEY=$DAI_FINALIZER_PRIVATE_KEY
    svc validator-dai validator XPOOL_CONFIG=testnet-dai METRICS_PORT=9312 VALIDATOR_PORT=7011 VALIDATOR_OPERATOR_KEY=$DAI_VAL_OPERATOR_KEY VALIDATOR_SIGNER_KEY=$DAI_VAL_SIGNER_KEY VALIDATOR_L2_CONFIRMATIONS=5 VALIDATOR_SUBMIT_STAGGER_MS=0 VALIDATOR_TICK_MS=4000
    # DAI pool v2 (Sepolia hub + Base spoke, rebalanced through the testnet LockReleaseMessenger)
    svc attester-dai2 test-attester XPOOL_CONFIG=testnet-dai2 ATTESTER_PORT=8095 ATTESTER_PRIVATE_KEY=$DAI_ATTESTER_PRIVATE_KEY
    svc relayer-dai2 relayer XPOOL_CONFIG=testnet-dai2 METRICS_PORT=9321 RELAYER_PORT=8082 RELAYER_TRANSACT_GAS=3000000 RELAYER_CORS_ORIGINS=$CORS RELAYER_PRIVATE_KEY=$DAI2_RELAYER_PRIVATE_KEY
    svc finalizer-dai2 finalizer XPOOL_CONFIG=testnet-dai2 METRICS_PORT=9323 FINALIZER_PRIVATE_KEY=$DAI2_FINALIZER_PRIVATE_KEY
    svc keeper-dai2 keeper XPOOL_CONFIG=testnet-dai2 METRICS_PORT=9324 KEEPER_IRIS_URL=http://127.0.0.1:8095 KEEPER_REBALANCE_COOLDOWN_SEC=60 KEEPER_TICK_MS=15000 KEEPER_PRIVATE_KEY=$DAI2_KEEPER_PRIVATE_KEY
    svc validator-dai2 validator XPOOL_CONFIG=testnet-dai2 METRICS_PORT=9322 VALIDATOR_PORT=7012 VALIDATOR_OPERATOR_KEY=$DAI2_VAL_OPERATOR_PRIVATE_KEY VALIDATOR_SIGNER_KEY=$DAI2_VAL_SIGNER_PRIVATE_KEY VALIDATOR_BOOTSTRAP_BOND=20000000000000000000 VALIDATOR_BOOTSTRAP_ALLOCATIONS=84532:20000000000000000000 VALIDATOR_L2_CONFIRMATIONS=5 VALIDATOR_SUBMIT_STAGGER_MS=0 VALIDATOR_TICK_MS=4000
    # web app (testnet, reads latest blocks)
    ( cd "$ROOT/apps/web" || exit 1; node scripts/copy-artifacts.mjs >/dev/null
      env VITE_XPOOL_ENV=testnet VITE_SYNC_TAG=latest VITE_RELAYER_URLS="usdc=http://127.0.0.1:8080,dai=http://127.0.0.1:8081,dai2=http://127.0.0.1:8082" \
        nohup ./node_modules/.bin/vite --port 5173 --strictPort >>"$L/web.log" 2>&1 &
      echo $! >"$P/web.pid" )
    echo "started; web at http://localhost:5173"
    ;;
  stop)
    for f in "$P"/*.pid; do [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }; done; echo stopped ;;
  status)
    for f in "$P"/*.pid; do n=$(basename "$f" .pid); kill -0 "$(cat "$f")" 2>/dev/null && echo "$n up" || echo "$n DOWN"; done ;;
esac
