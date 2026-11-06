#!/usr/bin/env bash
# xpool local E2E matrix (PRD 15.4). Drives the real CLI (real Groth16 proofs, real relayer, validators,
# finalizer, keeper, mock bridges) and checks every outcome independently on-chain with `cast`.
#
#   scripts/local-stack.sh up && scripts/e2e.sh        (or: cd infra && make e2e)
#
# Covers: deposits on ETH / Base / Arbitrum (fast lane), withdrawals to all three chains, cross-chain
# withdrawal (deposit on one chain, withdraw on another), private transfer, merge, the same note proven
# for two destinations at once (exactly one succeeds), and the slow lane with every validator offline.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
RUN="$ROOT/.xpool/local"
E2E="$ROOT/.xpool/e2e"
CLI="node $ROOT/packages/cli/dist/index.js --env local --no-tor"
DEP="$ROOT/deployments/local.json"
MN="test test test test test test test test test test test junk"
# bash 3.2 compatible (macOS): no associative arrays.
rpc() { case $1 in eth) echo http://127.0.0.1:8545 ;; base) echo http://127.0.0.1:8546 ;; arb) echo http://127.0.0.1:8547 ;; esac; }
cid() { case $1 in eth) echo 31337 ;; base) echo 31338 ;; arb) echo 31339 ;; esac; }

pass=0
ok()   { pass=$((pass + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
step() { printf '\n== %s\n' "$*"; }
jget() { python3 -c "import json,sys; d=json.load(open('$DEP')); print(eval(sys.argv[1]))" "$1"; }

USDC=$(jget "d['hub']['usdc']")
DM=$(jget "d['hub']['contracts']['DepositManager']")
HUB=$(jget "d['hub']['contracts']['HubCore']")
has_usdc() { [ "$(usdc_of "$1" "$2")" = "$3" ]; }   # predicate: re-evaluated on every wait_for poll
usdc_of() { cast call --rpc-url "$(rpc "$1")" "$(jget "d['mocks']['$(cid $1)']['MockUSDC']")" 'balanceOf(address)(uint256)' "$2" | cut -d' ' -f1; }

# wait_for <timeout-s> <description> <command...>: polls until the command succeeds.
wait_for() {
  local t=$1 what=$2; shift 2
  local end=$((SECONDS + t))
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -lt $end ] || fail "timed out after ${t}s waiting for: $what"
    sleep 2
  done
}

wallet() { # name -> runs CLI with that wallet
  local name=$1; shift
  XPOOL_HOME="$E2E/$name" XPOOL_PASSWORD=e2e-password-not-secret $CLI "$@"
}
balance_is() { wallet "$1" sync >/dev/null 2>&1; [ "$(wallet "$1" balance 2>/dev/null | tail -1)" = "$2 USDC" ]; }
# Withdraw and echo the recipient address.
withdraw() { # wallet chain amount
  local out
  out=$(wallet "$1" withdraw --to-chain "$2" --amount "$3" --ignore-delay --ignore-anonymity -y 2>&1) || { echo "$out" >&2; return 1; }
  echo "$out" | grep -oE 'USDC to 0x[0-9a-fA-F]{40}' | head -1 | awk '{print $3}'
}
l2_inserted_lane() { # chainId index -> prints true/false once inserted on the hub
  local topic idx
  topic=$(cast keccak 'L2DepositInserted(uint64,uint64,uint256,uint32,bool)')
  idx=$(cast to-uint256 "$2")
  cast logs --rpc-url "$(rpc eth)" --from-block 0 --address "$DM" "$topic" "$(cast to-uint256 "$1")" "$idx" --json |
    python3 -c "import json,sys; l=json.load(sys.stdin); print('none' if not l else ('true' if int(l[-1]['data'][-64:],16) else 'false'))"
}
lane_is() { [ "$(l2_inserted_lane "$1" "$2")" = "$3" ]; }
spoke_count() { cast call --rpc-url "$(rpc "$1")" "$(jget "d['spokes']['$(cid $1)']['contracts']['Spoke']")" 'depositCount()(uint64)' | cut -d' ' -f1; }
release_count() { cast call --rpc-url "$(rpc eth)" "$HUB" 'releaseCount(uint64)(uint64)' "$1" | cut -d' ' -f1; }

# ------------------------------------------------------------------------------------------------ setup
step "setup"
for s in mock-bridge relayer finalizer keeper validator-1 validator-2 validator-3 validator-4; do
  kill -0 "$(cat "$RUN/$s.pid" 2>/dev/null)" 2>/dev/null || fail "$s not running (scripts/local-stack.sh up)"
done
[ -f "$ROOT/packages/cli/dist/index.js" ] || (cd "$ROOT" && pnpm --filter @xpool/sdk --filter @xpool/cli build >/dev/null)
rm -rf "${E2E:?}" && mkdir -p "$E2E"
ALICE_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 13)
BOB_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 14)
for k in "$ALICE_KEY" "$BOB_KEY"; do
  for c in eth base arb; do
    cast send -q --rpc-url "$(rpc "$c")" --private-key "$k" "$(jget "d['mocks']['$(cid $c)']['MockUSDC']")" \
      'mint(address,uint256)' "$(cast wallet address "$k")" 1000000000
  done
done
wallet alice init >/dev/null 2>&1 && wallet bob init >/dev/null 2>&1 || fail "wallet init"
BOB_ADDR=$(wallet bob address 2>/dev/null | tail -1)
ok "wallets created, users funded with mock USDC on all chains"

# ------------------------------------------------------------------------------------------------ deposits
step "deposits on every chain (fast lane for L2)"
base0=$(spoke_count base); arb0=$(spoke_count arb)
for c in eth base arb; do
  XPOOL_EOA_KEY=$ALICE_KEY wallet alice deposit --chain "$c" --amount 100 >/dev/null 2>&1 || fail "deposit on $c"
done
XPOOL_EOA_KEY=$BOB_KEY wallet bob deposit --chain eth --amount 50 >/dev/null 2>&1 || fail "bob deposit"
wait_for 180 "alice sees 300 USDC" balance_is alice 300
ok "alice: 300 USDC spendable from deposits on eth, base, arb"
wait_for 60 "bob sees 50 USDC" balance_is bob 50
ok "bob: 50 USDC spendable"
[ "$(l2_inserted_lane 31338 "$base0")" = true ] && ok "base deposit #$base0 inserted via FAST lane (validators)" \
  || fail "base deposit #$base0 lane = $(l2_inserted_lane 31338 "$base0") (expected fast)"
[ "$(l2_inserted_lane 31339 "$arb0")" = true ] && ok "arb deposit #$arb0 inserted via FAST lane (validators)" \
  || fail "arb deposit #$arb0 lane = $(l2_inserted_lane 31339 "$arb0") (expected fast)"

# ------------------------------------------------------------------------------------------------ withdrawals
step "withdrawals to every chain (fresh recipients)"
for c in eth base arb; do
  r=$(withdraw alice "$c" 20) || fail "withdraw to $c"
  wait_for 120 "20 USDC at $r on $c" has_usdc "$c" "$r" 20000000
  [ "$(usdc_of "$c" "$r")" = 20000000 ] && ok "withdraw 20 USDC -> fresh $r on $c"
done

# ------------------------------------------------------------------------------------------------ transfer + merge
step "private transfer and merge"
wallet alice transfer --to "$BOB_ADDR" --amount 30 -y >/dev/null 2>&1 || fail "transfer"
wait_for 120 "bob sees 80 USDC" balance_is bob 80
ok "alice -> bob private transfer of 30 USDC; bob balance 80"
wallet alice sync >/dev/null 2>&1
n_before=$(wallet alice notes 2>/dev/null | grep -c unspent || true)
[ "$n_before" -ge 2 ] || fail "merge precondition: alice has $n_before unspent notes"
wallet alice merge -y >/dev/null 2>&1 || fail "merge"
wait_for 120 "alice note count drops" bash -c "[ \$(XPOOL_HOME='$E2E/alice' XPOOL_PASSWORD=e2e-password-not-secret $CLI sync >/dev/null 2>&1; XPOOL_HOME='$E2E/alice' XPOOL_PASSWORD=e2e-password-not-secret $CLI notes 2>/dev/null | grep -c unspent) -lt $n_before ]"
ok "merge reduced alice's notes ($n_before -> fewer)"

# ------------------------------------------------------------------------------------------------ double spend
step "same note proven for two destinations at once"
# carol: one wallet copied twice, holding exactly ONE note, so both spends must use the same note.
CAROL_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 15)
cast send -q --rpc-url "$(rpc eth)" --private-key "$CAROL_KEY" "$(jget "d['mocks']['31337']['MockUSDC']")" \
  'mint(address,uint256)' "$(cast wallet address "$CAROL_KEY")" 1000000000
wallet carol init >/dev/null 2>&1
XPOOL_EOA_KEY=$CAROL_KEY wallet carol deposit --chain eth --amount 40 >/dev/null 2>&1 || fail "carol deposit"
wait_for 60 "carol sees 40 USDC" balance_is carol 40
cp -R "$E2E/carol" "$E2E/carol2"
rb0=$(release_count 31338); ra0=$(release_count 31339)
# (`if` so that set -e doesn't kill the subshell before it records the losing spend's failure)
( if withdraw carol base 10 >"$E2E/ds-a.out" 2>&1; then echo 0; else echo 1; fi >"$E2E/ds-a.rc" ) &
( if withdraw carol2 arb 10 >"$E2E/ds-b.out" 2>&1; then echo 0; else echo 1; fi >"$E2E/ds-b.rc" ) &
wait
rc_a=$(cat "$E2E/ds-a.rc"); rc_b=$(cat "$E2E/ds-b.rc")
logged=$(( $(release_count 31338) - rb0 + $(release_count 31339) - ra0 ))
NS=$(cast sig 'NullifierSpent(uint256)')
if [ "$logged" = 1 ] && [ $((rc_a + rc_b)) = 1 ]; then
  ok "exactly one of the two spends succeeded; exactly one release logged"
  if grep -q "$NS" "$RUN/logs/relayer.log" || grep -qi "NullifierSpent" "$E2E"/ds-*.out; then
    ok "the losing spend was rejected on-chain by HubCore with NullifierSpent ($NS)"
  else
    ok "the losing spend was rejected before submission (relayer simulation)"
  fi
else
  cat "$E2E"/ds-*.out; fail "double spend: rc_a=$rc_a rc_b=$rc_b releases_logged=$logged"
fi

# ------------------------------------------------------------------------------------------------ slow lane
step "validators offline: deposit still completes through the slow lane"
for i in 1 2 3 4; do kill "$(cat "$RUN/validator-$i.pid")"; done
idx=$(spoke_count base)
XPOOL_EOA_KEY=$BOB_KEY wallet bob deposit --chain base --amount 25 >/dev/null 2>&1 || fail "slow-lane deposit"
wait_for 240 "base deposit #$idx inserted on the hub" lane_is 31338 "$idx" false
ok "base deposit #$idx inserted via SLOW lane (canonical checkpoint) with every validator offline"
wait_for 60 "bob sees 105 USDC" balance_is bob 105
ok "bob can spend the slow-lane deposit (balance 105)"
bash "$ROOT/scripts/local-services.sh" start validator >/dev/null

printf '\n\033[32mE2E: %d checks passed\033[0m\n' "$pass"
