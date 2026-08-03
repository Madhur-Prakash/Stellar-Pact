#!/usr/bin/env bash
#
# Drive a complete deal through the deployed contracts and record every
# transaction hash.
#
#   bash scripts/demo.sh
#
# This is the on-chain counterpart to the integration test suite: it proves the
# same cross-contract paths work against a live network rather than the local
# host, and it produces the verifiable transaction hashes cited in the README.
#
# Reads addresses from deployments/<network>.json, so run scripts/deploy.sh
# first.

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENT="$ROOT/deployments/$NETWORK.json"
OUT_FILE="$ROOT/deployments/$NETWORK-demo.json"

# Same project-local identity store deploy.sh uses — see the note there.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$ROOT/.config}"
mkdir -p "$XDG_CONFIG_HOME/stellar"

[ -f "$DEPLOYMENT" ] || { echo "No deployment found at $DEPLOYMENT — run scripts/deploy.sh first." >&2; exit 1; }

# Minimal JSON field reader so the script has no jq dependency.
field() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" "$DEPLOYMENT" | head -1 | sed -E 's/.*"([^"]+)"$/\1/'; }

REGISTRY_ID="$(field registry)"
REPUTATION_ID="$(field reputation)"

CLIENT_KEY="${CLIENT_KEY:-pact-client}"
WORKER_KEY="${WORKER_KEY:-pact-worker}"

TOTAL_STROOPS=300000000   # 30 XLM
MILESTONES=2
DEADLINE=$(( $(date +%s) + 604800 ))   # one week out

# Progress goes to stderr so that command substitution around `invoke` captures
# only the contract's return value.
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1" >&2; }
info() { printf '    %s\n' "$1" >&2; }

# Collected hashes go to a file rather than a shell array: `invoke` is sometimes
# called inside a command substitution, and a subshell's array writes would be
# discarded when it exits.
HASHES_FILE="$(mktemp)"
trap 'rm -f "$HASHES_FILE"' EXIT

# Runs an invocation, prints its transaction hash, and returns the contract's
# result on stdout. The CLI writes progress to stderr and the return value to
# stdout, which is what makes this separation possible.
invoke() {
  local label="$1"; shift
  local log result hash
  log="$(mktemp)"
  result="$(stellar contract invoke --network "$NETWORK" "$@" 2>"$log")" || {
    echo "--- $label failed ---" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 1
  }
  hash="$(grep -oE 'Signing transaction: [0-9a-f]{64}' "$log" | head -1 | cut -d' ' -f3 || true)"
  rm -f "$log"

  if [ -n "$hash" ]; then
    printf '%s %s\n' "$label" "$hash" >> "$HASHES_FILE"
    info "$label  tx $hash"
  fi
  printf '%s' "$result"
}

ensure_key() {
  if ! stellar keys address "$1" >/dev/null 2>&1; then
    stellar keys generate "$1" --network "$NETWORK"
  fi
  stellar keys fund "$1" --network "$NETWORK" >/dev/null 2>&1 || true
  stellar keys address "$1"
}

# ── Cast ─────────────────────────────────────────────────────────────────────
step "Preparing accounts"
CLIENT="$(ensure_key "$CLIENT_KEY")"
WORKER="$(ensure_key "$WORKER_KEY")"
info "client  $CLIENT"
info "worker  $WORKER"

# ── 1. The registry deploys a dedicated escrow for this deal ─────────────────
step "Creating the deal  (registry -> deploy_v2 -> new escrow)"
ESCROW_ID="$(invoke create_deal \
  --id "$REGISTRY_ID" --source-account "$CLIENT_KEY" \
  -- create_deal \
  --client "$CLIENT" \
  --worker "$WORKER" \
  --title "Landing page redesign" \
  --total_amount "$TOTAL_STROOPS" \
  --milestone_count "$MILESTONES" \
  --deadline "$DEADLINE" | tr -d '"')"
info "escrow  $ESCROW_ID"

# ── 2. Money in, through the native asset contract ──────────────────────────
step "Funding the escrow  (escrow -> SAC transfer)"
invoke fund --id "$ESCROW_ID" --source-account "$CLIENT_KEY" -- fund >/dev/null

# ── 3. First milestone: paid, but the deal stays open ───────────────────────
step "Milestone 1  (submit, then approve)"
invoke submit_milestone_1 --id "$ESCROW_ID" --source-account "$WORKER_KEY" \
  -- submit_milestone --index 0 --note "Wireframes and design system delivered" >/dev/null
invoke approve_milestone_1 --id "$ESCROW_ID" --source-account "$CLIENT_KEY" \
  -- approve_milestone --index 0 >/dev/null

# ── 4. Final milestone: pays out *and* writes reputation ────────────────────
# This is the two-hop call — escrow -> reputation -> registry — in one tx.
step "Milestone 2  (final: settles the deal and writes reputation)"
invoke submit_milestone_2 --id "$ESCROW_ID" --source-account "$WORKER_KEY" \
  -- submit_milestone --index 1 --note "Responsive build shipped and deployed" >/dev/null
invoke approve_milestone_2 --id "$ESCROW_ID" --source-account "$CLIENT_KEY" \
  -- approve_milestone --index 1 >/dev/null

# ── 5. Read back the results ────────────────────────────────────────────────
step "Verifying on-chain state"
LOCKED="$(stellar contract invoke --network "$NETWORK" --id "$ESCROW_ID" \
  --source-account "$CLIENT_KEY" -- locked_amount 2>/dev/null)"
info "escrow still holding: $LOCKED stroops"

REPUTATION="$(stellar contract invoke --network "$NETWORK" --id "$REPUTATION_ID" \
  --source-account "$CLIENT_KEY" -- get --who "$WORKER" 2>/dev/null)"
info "worker reputation:   $REPUTATION"

SCORE="$(stellar contract invoke --network "$NETWORK" --id "$REPUTATION_ID" \
  --source-account "$CLIENT_KEY" -- score --who "$WORKER" 2>/dev/null)"
info "worker score:        $SCORE / 100"

IS_ESCROW="$(stellar contract invoke --network "$NETWORK" --id "$REGISTRY_ID" \
  --source-account "$CLIENT_KEY" -- is_escrow --addr "$ESCROW_ID" 2>/dev/null)"
info "registry recognises escrow: $IS_ESCROW"

# ── 6. Record ────────────────────────────────────────────────────────────────
step "Writing demo record"
TOTAL_TX="$(wc -l < "$HASHES_FILE" | tr -d ' ')"
{
  echo "{"
  echo "  \"network\": \"$NETWORK\","
  echo "  \"escrow\": \"$ESCROW_ID\","
  echo "  \"client\": \"$CLIENT\","
  echo "  \"worker\": \"$WORKER\","
  echo "  \"transactions\": {"
  n=0
  while read -r label hash; do
    n=$(( n + 1 ))
    sep=","
    [ "$n" -eq "$TOTAL_TX" ] && sep=""
    echo "    \"$label\": \"$hash\"$sep"
  done < "$HASHES_FILE"
  echo "  }"
  echo "}"
} > "$OUT_FILE"
info "$OUT_FILE"

step "Done"
cat <<SUMMARY

  Escrow      $ESCROW_ID
  Explorer    https://stellar.expert/explorer/$NETWORK/contract/$ESCROW_ID

SUMMARY
