#!/usr/bin/env bash
# Deploys mocks + every xpool contract onto the three local Anvil chains and writes deployments/local.json.
# Infra-agnostic: only needs three running Anvil nodes (chain ids 31337 / 31338 / 31339).
#
#   ETH_RPC=http://127.0.0.1:8545 BASE_RPC=http://127.0.0.1:8546 ARB_RPC=http://127.0.0.1:8547 \
#     contracts/script/deploy-local.sh            # SEED=0 to skip seeding
set -euo pipefail

cd "$(dirname "$0")/.."   # contracts/
ETH_RPC="${ETH_RPC:-http://127.0.0.1:8545}"
BASE_RPC="${BASE_RPC:-http://127.0.0.1:8546}"
ARB_RPC="${ARB_RPC:-http://127.0.0.1:8547}"
SEED="${SEED:-1}"
export XPOOL_ENV=local

CREATE2_DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
# Runtime code of the deterministic deployment proxy (Arachnid), in case an Anvil runs without it.
CREATE2_DEPLOYER_CODE=0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3

forge build

MNEMONIC="test test test test test test test test test test test junk"
# Anvil funds only 10 accounts by default; docs/IMPLEMENTATION.md uses indices 0..19.
ACCOUNTS=()
for i in $(seq 0 19); do
  ACCOUNTS+=("$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$i")")
done

for rpc in "$ETH_RPC" "$BASE_RPC" "$ARB_RPC"; do
  if [ "$(cast code --rpc-url "$rpc" "$CREATE2_DEPLOYER")" = "0x" ]; then
    cast rpc --rpc-url "$rpc" anvil_setCode "$CREATE2_DEPLOYER" "$CREATE2_DEPLOYER_CODE" >/dev/null
  fi
  for a in "${ACCOUNTS[@]}"; do
    if [ "$(cast balance --rpc-url "$rpc" "$a")" = "0" ]; then
      cast rpc --rpc-url "$rpc" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null # 100 ETH
    fi
  done
done

# MockArbSys at address(100) on the Arbitrum-style chain.
ARBSYS_CODE="$(forge inspect src/mocks/MockArbSys.sol:MockArbSys deployedBytecode)"
cast rpc --rpc-url "$ARB_RPC" anvil_setCode 0x0000000000000000000000000000000000000064 "$ARBSYS_CODE" >/dev/null

forge script script/DeployLocal.s.sol:DeployLocal --sig "hub()"      --rpc-url "$ETH_RPC"  --broadcast --start-fresh
forge script script/DeployLocal.s.sol:DeployLocal --sig "base()"     --rpc-url "$BASE_RPC" --broadcast --start-fresh
forge script script/DeployLocal.s.sol:DeployLocal --sig "arbitrum()" --rpc-url "$ARB_RPC"  --broadcast --start-fresh

forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url "$ETH_RPC"
forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url "$BASE_RPC"
forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url "$ARB_RPC"

if [ "$SEED" = "1" ]; then
  forge script script/Seed.s.sol:Seed --rpc-url "$ETH_RPC" --broadcast --start-fresh
  EPOCH_SECONDS="$(jq -r .params.epochSeconds ../config/local.json)"
  cast rpc --rpc-url "$ETH_RPC" evm_increaseTime "$EPOCH_SECONDS" >/dev/null
  cast rpc --rpc-url "$ETH_RPC" evm_mine >/dev/null
  forge script script/Seed.s.sol:Seed --sig "advance()" --rpc-url "$ETH_RPC" --broadcast --start-fresh
fi

echo "deployments/local.json written"
