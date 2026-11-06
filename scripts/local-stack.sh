#!/usr/bin/env bash
# Host-native local stack (no Docker): 3 Anvil chains -> deploy + seed -> all services.
#   scripts/local-stack.sh up | down
# Same topology as infra/docker-compose.yml; use whichever you prefer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.xpool/local"
export PATH="$HOME/.foundry/bin:$PATH"
mkdir -p "$RUN/logs"

chains=("8545:31337" "8546:31338" "8547:31339")

case "${1:-up}" in
  up)
    for c in "${chains[@]}"; do
      port="${c%%:*}" id="${c##*:}"
      # --slots-in-an-epoch 1: the `finalized` tag trails the head by ~2 blocks, so the fast lane
      # (validators attest at L2 finality) is faster than the 60 s mock slow lane, as on testnet.
      ( nohup anvil --port "$port" --chain-id "$id" --accounts 20 --block-time 1 --slots-in-an-epoch 1 --silent \
          >"$RUN/logs/anvil-$id.log" 2>&1 & echo $! >"$RUN/anvil-$id.pid" )
    done
    for c in "${chains[@]}"; do
      until cast chain-id --rpc-url "http://127.0.0.1:${c%%:*}" >/dev/null 2>&1; do sleep 0.5; done
    done
    echo "anvils up"
    bash "$ROOT/contracts/script/deploy-local.sh" >"$RUN/logs/deploy.log" 2>&1 || { echo "deploy failed: $RUN/logs/deploy.log"; exit 1; }
    echo "deployed (deployments/local.json)"
    bash "$ROOT/scripts/local-services.sh" start
    ;;
  down)
    bash "$ROOT/scripts/local-services.sh" stop || true
    for f in "$RUN"/anvil-*.pid; do [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }; done
    rm -rf "${RUN:?}/state"
    echo "down"
    ;;
esac
