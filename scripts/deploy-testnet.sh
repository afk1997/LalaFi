#!/usr/bin/env bash
# Deploys one xpool pool to Sepolia (hub) + Base Sepolia (+ Arbitrum Sepolia if the config has an
# Arbitrum spoke) and verifies every chain.
#   1. put DEPLOYER_PRIVATE_KEY=0x<64 hex> in contracts/.env   (git-ignored; never paste it anywhere else)
#   2. scripts/deploy-testnet.sh             # USDC pool: config/testnet.json -> deployments/testnet.json
#      POOL=dai scripts/deploy-testnet.sh    # DAI pool:  config/testnet-dai.json -> deployments/testnet-dai.json
# Optional env: POOL (usdc | dai | any config/testnet-<pool>.json), SEPOLIA_RPC, BASE_SEPOLIA_RPC,
#               ARB_SEPOLIA_RPC, EXPECTED_DEPLOYER.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT/contracts"

SEPOLIA_RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
BASE_SEPOLIA_RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
ARB_SEPOLIA_RPC="${ARB_SEPOLIA_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"
EXPECTED_DEPLOYER="${EXPECTED_DEPLOYER:-0x137D61d2899ab1cf1003649C04c4549B1f5B6Db5}"
export XPOOL_ENV=testnet
POOL="${POOL:-usdc}"
if [ "$POOL" = usdc ]; then XPOOL_CONFIG=testnet; else XPOOL_CONFIG="testnet-$POOL"; fi
export XPOOL_CONFIG
CONFIG="$ROOT/config/$XPOOL_CONFIG.json"
[ -f "$CONFIG" ] || { echo "no config $CONFIG for POOL=$POOL"; exit 1; }
# deploy / verify the Arbitrum spoke only if the config has one
if grep -q '"stack": *"arbitrum"' "$CONFIG"; then HAS_ARB=1; else HAS_ARB=0; fi
echo "pool $POOL: config/$XPOOL_CONFIG.json (arbitrum spoke: $([ $HAS_ARB = 1 ] && echo yes || echo no))"

[ -f .env ] || { echo "contracts/.env missing (DEPLOYER_PRIVATE_KEY=0x...)"; exit 1; }
set -a; . ./.env; set +a
[ "${#DEPLOYER_PRIVATE_KEY}" = 66 ] || { echo "DEPLOYER_PRIVATE_KEY must be 0x + 64 hex chars (a 40-char value is an address, not a key)"; exit 1; }
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
if [ "$(echo "$DEPLOYER" | tr A-F a-f)" != "$(echo "$EXPECTED_DEPLOYER" | tr A-F a-f)" ]; then
  echo "key controls $DEPLOYER, expected $EXPECTED_DEPLOYER — refusing (CREATE3 addresses depend on the deployer)"; exit 1
fi
CHAINS=("$SEPOLIA_RPC:11155111" "$BASE_SEPOLIA_RPC:84532")
[ "$HAS_ARB" = 1 ] && CHAINS+=("$ARB_SEPOLIA_RPC:421614")
for r in "${CHAINS[@]}"; do
  url="${r%:*}" id="${r##*:}"
  [ "$(cast chain-id --rpc-url "$url")" = "$id" ] || { echo "RPC $url is not chain $id"; exit 1; }
  echo "chain $id: deployer balance $(cast balance --ether --rpc-url "$url" "$DEPLOYER") ETH"
done

forge build >/dev/null
echo "== 1/4 predict addresses";   DEPLOYER=$DEPLOYER forge script script/PredictAddresses.s.sol | sed -n "/== Logs ==/,$ p"
echo "== 2/4 hub on Sepolia";      forge script script/DeployHub.s.sol   --rpc-url "$SEPOLIA_RPC"      --broadcast --slow
echo "== 3/4 spoke on Base Sepolia";     forge script script/DeploySpoke.s.sol --rpc-url "$BASE_SEPOLIA_RPC" --broadcast --slow
if [ "$HAS_ARB" = 1 ]; then
  echo "== 3/4 spoke on Arbitrum Sepolia"; forge script script/DeploySpoke.s.sol --rpc-url "$ARB_SEPOLIA_RPC"  --broadcast --slow
fi
echo "== 4/4 verify"
for r in "${CHAINS[@]}"; do
  forge script script/VerifyDeployment.s.sol --rpc-url "${r%:*}" | grep -E "failed|passed|FAIL" || true
done
echo "deployments/$XPOOL_CONFIG.json:"; cat "$ROOT/deployments/$XPOOL_CONFIG.json"
