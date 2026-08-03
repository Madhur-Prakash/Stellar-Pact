#!/usr/bin/env bash
#
# Deploy the full StellarPact contract system.
#
#   bash scripts/deploy.sh                 # testnet, default identity
#   NETWORK=testnet IDENTITY=me bash scripts/deploy.sh
#
# Deployment order is not arbitrary. The registry needs the escrow's WASM hash
# and the reputation contract's address before it can be constructed, while the
# reputation contract needs the registry's address before it will accept any
# writes. That cycle is broken by deploying reputation first with only an admin,
# then wiring it once the registry exists.
#
# The script is safe to re-run: it produces a brand new deployment each time and
# rewrites deployments/<network>.json, which is the single source of truth the
# frontend reads its addresses from.

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-pact-deployer}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
WASM_DIR="$CONTRACTS/target/wasm32v1-none/release"
OUT_DIR="$ROOT/deployments"
OUT_FILE="$OUT_DIR/$NETWORK.json"
ENV_FILE="$ROOT/frontend/.env.local"

# Keep Stellar CLI identities inside the project instead of the machine account.
# The CLI reads $XDG_CONFIG_HOME/stellar, so this puts the deployer at
# .config/stellar/identity/<name>.toml — a checkout carries its own keys, and
# nothing is written to a shared home directory.
#
# SECURITY: that file holds the admin's 24-word seed phrase in plaintext. It is
# gitignored, but a gitignore only stops git — do not zip, sync, or screen-share
# this folder, and back the file up somewhere safe. Losing it means losing the
# ability to pause the registry, rotate the admin, or settle any dispute.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$ROOT/.config}"
mkdir -p "$XDG_CONFIG_HOME/stellar"

case "$NETWORK" in
  testnet)
    PASSPHRASE="Test SDF Network ; September 2015"
    RPC_DEFAULT="https://soroban-testnet.stellar.org"
    HORIZON_DEFAULT="https://horizon-testnet.stellar.org"
    ;;
  futurenet)
    PASSPHRASE="Test SDF Future Network ; October 2022"
    RPC_DEFAULT="https://rpc-futurenet.stellar.org"
    HORIZON_DEFAULT="https://horizon-futurenet.stellar.org"
    ;;
  mainnet|public)
    PASSPHRASE="Public Global Stellar Network ; September 2015"
    RPC_DEFAULT="https://mainnet.sorobanrpc.com"
    HORIZON_DEFAULT="https://horizon.stellar.org"
    ;;
  *) echo "Unsupported network: $NETWORK" >&2; exit 1 ;;
esac

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

# ── 1. Identity ──────────────────────────────────────────────────────────────
step "Preparing identity '$IDENTITY'"
if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  stellar keys generate "$IDENTITY" --network "$NETWORK"
  info "generated a new key"
fi
DEPLOYER="$(stellar keys address "$IDENTITY")"
info "$DEPLOYER"

if [ "$NETWORK" = "testnet" ] || [ "$NETWORK" = "futurenet" ]; then
  step "Funding from friendbot"
  # Already-funded accounts return an error friendbot considers fatal; the
  # account existing is exactly the outcome we want, so don't fail the run.
  stellar keys fund "$IDENTITY" --network "$NETWORK" 2>/dev/null || info "already funded"
fi

# ── 2. Build ─────────────────────────────────────────────────────────────────
step "Building contracts"
(cd "$CONTRACTS" && stellar contract build)

for name in registry escrow reputation; do
  [ -f "$WASM_DIR/$name.wasm" ] || { echo "missing $WASM_DIR/$name.wasm" >&2; exit 1; }
done

# ── 3. Upload the escrow implementation ──────────────────────────────────────
# The registry stores this hash and mints escrow instances from it on demand,
# so the escrow is uploaded but never itself deployed here.
step "Uploading escrow WASM"
ESCROW_WASM_HASH="$(stellar contract upload \
  --wasm "$WASM_DIR/escrow.wasm" \
  --source-account "$IDENTITY" \
  --network "$NETWORK" 2>/dev/null | tail -1)"
info "escrow wasm hash: $ESCROW_WASM_HASH"

# ── 4. Reputation ────────────────────────────────────────────────────────────
step "Deploying ReputationContract"
REPUTATION_ID="$(stellar contract deploy \
  --wasm "$WASM_DIR/reputation.wasm" \
  --source-account "$IDENTITY" \
  --network "$NETWORK" \
  -- --admin "$DEPLOYER" 2>/dev/null | tail -1)"
info "$REPUTATION_ID"

# ── 5. Native asset contract ─────────────────────────────────────────────────
step "Resolving the native XLM asset contract"
TOKEN_ID="$(stellar contract id asset --asset native --network "$NETWORK")"
info "$TOKEN_ID"

# ── 6. Registry ──────────────────────────────────────────────────────────────
step "Deploying RegistryContract"
REGISTRY_ID="$(stellar contract deploy \
  --wasm "$WASM_DIR/registry.wasm" \
  --source-account "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$DEPLOYER" \
  --escrow_wasm "$ESCROW_WASM_HASH" \
  --reputation "$REPUTATION_ID" \
  --token "$TOKEN_ID" 2>/dev/null | tail -1)"
info "$REGISTRY_ID"

# ── 7. Close the loop ────────────────────────────────────────────────────────
step "Wiring reputation -> registry"
stellar contract invoke \
  --id "$REPUTATION_ID" \
  --source-account "$IDENTITY" \
  --network "$NETWORK" \
  -- set_registry --registry "$REGISTRY_ID" >/dev/null
info "reputation now verifies callers against $REGISTRY_ID"

# ── 8. Record the deployment ─────────────────────────────────────────────────
step "Writing deployment record"
mkdir -p "$OUT_DIR"

# Snapshot the outgoing record before it is overwritten. Step 9 needs the old
# addresses to find and replace them in the README and the contract reference,
# where they sit inside tables, links and badge URLs rather than next to a key
# that names them.
PREVIOUS_RECORD=""
if [ -f "$OUT_FILE" ]; then
  PREVIOUS_RECORD="$(mktemp)"
  cp "$OUT_FILE" "$PREVIOUS_RECORD"
  trap 'rm -f "$PREVIOUS_RECORD"' EXIT
fi

cat > "$OUT_FILE" <<JSON
{
  "network": "$NETWORK",
  "networkPassphrase": "$PASSPHRASE",
  "deployer": "$DEPLOYER",
  "contracts": {
    "registry": "$REGISTRY_ID",
    "reputation": "$REPUTATION_ID",
    "token": "$TOKEN_ID"
  },
  "escrowWasmHash": "$ESCROW_WASM_HASH"
}
JSON
info "$OUT_FILE"

mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<ENV
# Generated by scripts/deploy.sh — do not edit by hand.
#
# Every NEXT_PUBLIC_* value is inlined into the client bundle at BUILD time, so
# changing one means rebuilding, not restarting.

NEXT_PUBLIC_STELLAR_NETWORK=$NETWORK

# Leave the semicolon unquoted and unescaped — this is the exact passphrase the
# network expects, and a truncated one produces signatures the network rejects.
NEXT_PUBLIC_NETWORK_PASSPHRASE=$PASSPHRASE

NEXT_PUBLIC_REGISTRY_ID=$REGISTRY_ID
NEXT_PUBLIC_REPUTATION_ID=$REPUTATION_ID
NEXT_PUBLIC_TOKEN_ID=$TOKEN_ID

# Optional — these defaults are compiled in, so the app runs without them.
# Set them to point at a private or self-hosted endpoint; the public testnet
# RPC is rate limited and can drop polls under load.
# NEXT_PUBLIC_RPC_URL=$RPC_DEFAULT
# NEXT_PUBLIC_HORIZON_URL=$HORIZON_DEFAULT
ENV
info "$ENV_FILE"

# ── 9. Propagate the addresses everywhere else ───────────────────────────────
# Four more files hardcode these: the committed env example, both env blocks in
# the CI workflow, the README and the contract reference. Nothing breaks if they
# go stale — the old contracts keep working — so the drift is silent, which is
# exactly why it is fixed automatically here rather than left as a checklist.
step "Syncing addresses into the repo"
if command -v node >/dev/null 2>&1; then
  if [ -n "$PREVIOUS_RECORD" ]; then
    node "$ROOT/scripts/sync-addresses.mjs" --network "$NETWORK" --previous "$PREVIOUS_RECORD"
  else
    node "$ROOT/scripts/sync-addresses.mjs" --network "$NETWORK"
  fi
else
  info "node not found — skipped. Run it yourself once node is available:"
  info "  node scripts/sync-addresses.mjs --network $NETWORK"
fi

step "Done"
cat <<SUMMARY

  Registry    $REGISTRY_ID
  Reputation  $REPUTATION_ID
  Token (XLM) $TOKEN_ID
  Escrow WASM $ESCROW_WASM_HASH

  Explorer    https://stellar.expert/explorer/$NETWORK/contract/$REGISTRY_ID

SUMMARY
