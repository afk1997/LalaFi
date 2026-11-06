#!/usr/bin/env bash
# xpool v1 TEST trusted setup. NOT FOR MAINNET (PRD 6.7).
# 1. compile (r1cs, wasm, sym) into build/
# 2. phase 1 ptau (hash-checked), groth16 setup, 1 CSPRNG contribution, beacon, zkey verify
# 3. export verification_key.json and contracts/src/verifier/Groth16Verifier.sol
# 4. copy wasm/zkey/vkey to artifacts/ (committed) and write artifacts/hashes.json
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
export PATH="$HOME/.cargo/bin:$PATH"

bash scripts/compile.sh
if command -v circom >/dev/null 2>&1; then
  XPOOL_CIRCOM_VERSION="$(circom --version)"
else
  XPOOL_CIRCOM_VERSION="$(node_modules/.bin/circom2 --version | tail -1)"
fi
export XPOOL_CIRCOM_VERSION

node_modules/.bin/tsx scripts/setup.ts
