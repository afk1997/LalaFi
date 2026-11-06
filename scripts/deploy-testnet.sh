#!/usr/bin/env bash
# Deploys xpool to Sepolia (hub) + Base Sepolia + Arbitrum Sepolia (spokes) and verifies all three.
#   1. put DEPLOYER_PRIVATE_KEY=0x<64 hex> in contracts/.env   (git-ignored; never paste it anywhere else)
#   2. scripts/deploy-testnet.sh
# Optional env: SEPOLIA_RPC, BASE_SEPOLIA_RPC, ARB_SEPOLIA_RPC, EXPECTED_DEPLOYER.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT/contracts"

SEPOLIA_RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
BASE_SEPOLIA_RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
ARB_SEPOLIA_RPC="${ARB_SEPOLIA_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"
EXPECTED_DEPLOYER="${EXPECTED_DEPLOYER:-0x137D61d2899ab1cf1003649C04c4549B1f5B6Db5}"
export XPOOL_ENV=testnet

[ -f .env ] || { echo "contracts/.env missing (DEPLOYER_PRIVATE_KEY=0x...)"; exit 1; }
set -a; . ./.env; set +a
[ "${#DEPLOYER_PRIVATE_KEY}" = 66 ] || { echo "DEPLOYER_PRIVATE_KEY must be 0x + 64 hex chars (a 40-char value is an address, not a key)"; exit 1; }
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
if [ "$(echo "$DEPLOYER" | tr A-F a-f)" != "$(echo "$EXPECTED_DEPLOYER" | tr A-F a-f)" ]; then
  echo "key controls $DEPLOYER, expected $EXPECTED_DEPLOYER — refusing (CREATE3 addresses depend on the deployer)"; exit 1
fi
for r in "$SEPOLIA_RPC:11155111" "$BASE_SEPOLIA_RPC:84532" "$ARB_SEPOLIA_RPC:421614"; do
  url="${r%:*}" id="${r##*:}"
  [ "$(cast chain-id --rpc-url "$url")" = "$id" ] || { echo "RPC $url is not chain $id"; exit 1; }
  echo "chain $id: deployer balance $(cast balance --ether --rpc-url "$url" "$DEPLOYER") ETH"
done

forge build >/dev/null
echo "== 1/4 predict addresses";   DEPLOYER=$DEPLOYER forge script script/PredictAddresses.s.sol | sed -n "/== Logs ==/,$ p"
echo "== 2/4 hub on Sepolia";      forge script script/DeployHub.s.sol   --rpc-url "$SEPOLIA_RPC"      --broadcast --slow
echo "== 3/4 spoke on Base Sepolia";     forge script script/DeploySpoke.s.sol --rpc-url "$BASE_SEPOLIA_RPC" --broadcast --slow
echo "== 3/4 spoke on Arbitrum Sepolia"; forge script script/DeploySpoke.s.sol --rpc-url "$ARB_SEPOLIA_RPC"  --broadcast --slow
echo "== 4/4 verify"
for url in "$SEPOLIA_RPC" "$BASE_SEPOLIA_RPC" "$ARB_SEPOLIA_RPC"; do
  forge script script/VerifyDeployment.s.sol --rpc-url "$url" | grep -E "failed|passed|FAIL" || true
done
echo "deployments/testnet.json:"; cat "$ROOT/deployments/testnet.json"
