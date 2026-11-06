#!/usr/bin/env bash
# Compile the xpool v1 circuits into circuits/build/.
#   build/transaction.{r1cs,wasm,sym}   main circuit Transaction(24, 2, 2, 1)
#   build/test/poseidon{1,2,3}.wasm      test-only Poseidon(n) circuits (cross-impl vectors)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
export PATH="$HOME/.cargo/bin:$PATH"

if command -v circom >/dev/null 2>&1; then
  CIRCOM=(circom)
elif [ -x node_modules/.bin/circom2 ]; then
  CIRCOM=(node_modules/.bin/circom2)
else
  echo "circom not found (install circom 2.2.x)" >&2
  exit 1
fi
echo "using $("${CIRCOM[@]}" --version)"

mkdir -p build/test
TMP="$(mktemp -d build/.compile.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

"${CIRCOM[@]}" src/main.circom --O2 --r1cs --wasm --sym -l node_modules -o "$TMP"
mv "$TMP/main.r1cs" build/transaction.r1cs
mv "$TMP/main.sym" build/transaction.sym
mv "$TMP/main_js/main.wasm" build/transaction.wasm

for n in 1 2 3; do
  "${CIRCOM[@]}" "test/circuits/poseidon$n.circom" --wasm -l node_modules -o "$TMP" >/dev/null
  mv "$TMP/poseidon${n}_js/poseidon$n.wasm" "build/test/poseidon$n.wasm"
done

echo "compiled into $HERE/build"
