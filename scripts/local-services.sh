#!/usr/bin/env bash
# Runs the off-chain services on the host against local Anvil chains (same wiring as infra/docker-compose.yml).
#   scripts/local-services.sh start | stop | status
# Requires: three Anvil chains on 8545/8546/8547 and deployments/local.json (contracts/script/deploy-local.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.xpool/local"
mkdir -p "$RUN/logs" "$RUN/state"

# Anvil default-mnemonic keys (LOCAL ONLY; docs/IMPLEMENTATION.md account map).
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # mock-bridge relayer + CCTP attester
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # relayer
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6   # finalizer
K4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a   # keeper
OPS=(0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
     0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356 0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97)
SIGS=(0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897
      0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82 0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1)

export XPOOL_ENV=local XPOOL_ROOT="$ROOT" LOG_LEVEL="${LOG_LEVEL:-info}"
export XPOOL_RPC_31337=http://127.0.0.1:8545 XPOOL_RPC_31338=http://127.0.0.1:8546 XPOOL_RPC_31339=http://127.0.0.1:8547

launch() { # name dir metricsPort VAR=VAL...
  local name=$1 dir=$2 mport=$3; shift 3
  mkdir -p "$RUN/state/$name"
  ( cd "$ROOT/services/$dir" && env STATE_DIR="$RUN/state/$name" METRICS_PORT="$mport" "$@" \
      nohup node --import tsx src/index.ts >"$RUN/logs/$name.log" 2>&1 & echo $! >"$RUN/$name.pid" )
  echo "started $name (log: $RUN/logs/$name.log)"
}

case "${1:-start}" in
  start)
    launch mock-bridge mock-bridge 9200 MOCK_BRIDGE_PRIVATE_KEY=$K1 MOCK_BRIDGE_PORT=8090
    peers() { local out=() j; for j in 1 2 3 4; do [ "$j" = "$1" ] || out+=("http://127.0.0.1:700$j"); done; (IFS=,; echo "${out[*]}"); }
    for i in 1 2 3 4; do
      launch "validator-$i" validator "920$i" VALIDATOR_OPERATOR_KEY="${OPS[$((i-1))]}" VALIDATOR_SIGNER_KEY="${SIGS[$((i-1))]}" \
        VALIDATOR_PORT="700$i" VALIDATOR_PEERS="$(peers $i)" VALIDATOR_BOOTSTRAP_BOND=0
    done
    launch relayer relayer 9205 RELAYER_PRIVATE_KEY=$K2 RELAYER_PORT=8080
    launch finalizer finalizer 9206 FINALIZER_PRIVATE_KEY=$K3
    launch keeper keeper 9207 KEEPER_PRIVATE_KEY=$K4 KEEPER_IRIS_URL=http://127.0.0.1:8090
    ;;
  stop)
    for f in "$RUN"/*.pid; do [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }; done; echo stopped ;;
  status)
    for f in "$RUN"/*.pid; do n=$(basename "$f" .pid); if kill -0 "$(cat "$f")" 2>/dev/null; then echo "$n up"; else echo "$n DOWN"; fi; done ;;
esac
