#!/usr/bin/env bash
set -euo pipefail

# Deploy Garaga verifier stack and switch DarkPool to use it.
#
# Prerequisites:
# - `starkli` configured (account/keystore/env) for the DarkPool owner account.
# - Garaga verifier project already generated (default: contracts/garaga_intent_verifier).
# - `contracts/IntentVerifier.cairo` already built (scarb build).
#
# Required env:
# - OWNER_ADDRESS: owner account address used as constructor arg for IntentVerifier.
# - DARK_POOL_ADDRESS: deployed DarkPool contract address.
#
# Optional env:
# - GARAGA_PROJECT_DIR (default: contracts/garaga_intent_verifier)
# - GARAGA_SIERRA_PATH (auto-detected if unset)
# - INTENT_SIERRA_PATH (default: contracts/target/dev/starkshield_contracts_IntentVerifier.contract_class.json)
# - SKIP_DECLARE=1 (if class hashes are already declared)
# - GARAGA_CLASS_HASH, INTENT_ADAPTER_CLASS_HASH (used when SKIP_DECLARE=1)
# - STARKNET_RPC (recommended: https://api.zan.top/public/starknet-sepolia/rpc/v0_8)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Missing required command: $1" >&2
    exit 1
  fi
}

extract_hex() {
  # Return the last 0x... token from stdin.
  grep -Eo '0x[0-9a-fA-F]+' | tail -n 1
}

extract_class_hash() {
  # Prefer lines mentioning class hash; fallback to last hex.
  local out="$1"
  local h=""
  h="$(printf "%s" "$out" | grep -Ei 'class hash' | grep -Eo '0x[0-9a-fA-F]+' | tail -n 1 || true)"
  if [ -n "$h" ]; then
    printf "%s" "$h"
    return 0
  fi
  printf "%s" "$out" | extract_hex
}

extract_contract_address() {
  # Prefer lines mentioning contract address; fallback to last hex.
  local out="$1"
  local h=""
  h="$(printf "%s" "$out" | grep -Ei 'contract address|deployed at' | grep -Eo '0x[0-9a-fA-F]+' | tail -n 1 || true)"
  if [ -n "$h" ]; then
    printf "%s" "$h"
    return 0
  fi
  printf "%s" "$out" | extract_hex
}

extract_expected_casm_hash() {
  local out="$1"
  printf "%s" "$out" | grep -Eo 'Expected: 0x[0-9a-fA-F]+' | awk '{print $2}' | tail -n 1
}

current_nonce() {
  starkli nonce "$OWNER_ADDRESS" 2>/dev/null || true
}

retry_wait_seconds() {
  local attempt="$1"
  # 2, 4, 6, ...
  printf "%s" "$((attempt * 2))"
}

is_rate_limited() {
  local out="$1"
  printf "%s" "$out" | grep -Eqi 'cu limit exceeded|too fast|rate limit|429'
}

is_nonce_error() {
  local out="$1"
  printf "%s" "$out" | grep -qi 'InvalidTransactionNonce'
}

declare_with_retries() {
  local sierra_path="$1"
  local label="$2"

  local out code attempt nonce casm_expected
  local max_attempts="${TX_RETRY_ATTEMPTS:-6}"
  attempt=1
  casm_expected=""

  while [ "$attempt" -le "$max_attempts" ]; do
    echo "🔨 Declaring ${label} (attempt ${attempt}/${max_attempts})..."

    set +e
    if [ -n "$casm_expected" ]; then
      nonce="$(current_nonce)"
      if [ -n "$nonce" ]; then
        out="$(starkli declare --nonce "$nonce" --casm-hash "$casm_expected" "$sierra_path" 2>&1)"
      else
        out="$(starkli declare --casm-hash "$casm_expected" "$sierra_path" 2>&1)"
      fi
    else
      out="$(starkli declare "$sierra_path" 2>&1)"
    fi
    code=$?
    set -e

    echo "$out"

    if [ "$code" -eq 0 ]; then
      return 0
    fi

    if printf "%s" "$out" | grep -qi 'already declared'; then
      return 0
    fi

    if is_nonce_error "$out"; then
      echo "⚠️  Nonce mismatch while declaring ${label}; retrying with latest nonce..."
      attempt=$((attempt + 1))
      continue
    fi

    if is_rate_limited "$out"; then
      local wait_s
      wait_s="$(retry_wait_seconds "$attempt")"
      echo "⚠️  RPC rate-limited while declaring ${label}; retrying in ${wait_s}s..."
      sleep "$wait_s"
      attempt=$((attempt + 1))
      continue
    fi

    if [ -z "$casm_expected" ]; then
      casm_expected="$(extract_expected_casm_hash "$out")"
      if [ -n "$casm_expected" ]; then
        echo "⚠️  CASM hash mismatch detected; retrying with expected CASM hash: $casm_expected"
        attempt=$((attempt + 1))
        continue
      fi
    fi

    return "$code"
  done

  return 1
}

send_tx_with_retries() {
  local label="$1"
  shift
  local out code attempt nonce
  local max_attempts="${TX_RETRY_ATTEMPTS:-6}"
  attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    set +e
    out="$("$@" 2>&1)"
    code=$?
    set -e

    echo "$out"

    if [ "$code" -eq 0 ]; then
      return 0
    fi

    if is_nonce_error "$out"; then
      nonce="$(current_nonce)"
      if [ -n "$nonce" ]; then
        echo "⚠️  Nonce mismatch during ${label}; retrying with nonce ${nonce}..."
        set +e
        out="$("$@" --nonce "$nonce" 2>&1)"
        code=$?
        set -e
        echo "$out"
        if [ "$code" -eq 0 ]; then
          return 0
        fi
      fi
    fi

    if is_rate_limited "$out"; then
      local wait_s
      wait_s="$(retry_wait_seconds "$attempt")"
      echo "⚠️  RPC rate-limited during ${label}; retrying in ${wait_s}s..."
      sleep "$wait_s"
      attempt=$((attempt + 1))
      continue
    fi

    return "$code"
  done

  return 1
}

require_cmd starkli
require_cmd scarb

OWNER_ADDRESS="${OWNER_ADDRESS:-}"
DARK_POOL_ADDRESS="${DARK_POOL_ADDRESS:-}"
if [ -z "$OWNER_ADDRESS" ] || [ -z "$DARK_POOL_ADDRESS" ]; then
  echo "❌ OWNER_ADDRESS and DARK_POOL_ADDRESS are required." >&2
  exit 1
fi

GARAGA_PROJECT_DIR="${GARAGA_PROJECT_DIR:-contracts/garaga_intent_verifier}"
INTENT_SIERRA_PATH="${INTENT_SIERRA_PATH:-contracts/target/dev/starkshield_contracts_IntentVerifier.contract_class.json}"

if [ ! -f "$INTENT_SIERRA_PATH" ]; then
  echo "❌ Missing IntentVerifier Sierra artifact: $INTENT_SIERRA_PATH" >&2
  echo "Run: (cd contracts && scarb build)" >&2
  exit 1
fi

if [ ! -d "$GARAGA_PROJECT_DIR" ]; then
  echo "❌ Missing Garaga project: $GARAGA_PROJECT_DIR" >&2
  echo "Run: bash circuits/scripts/generate_garaga_verifier_on_server.sh" >&2
  exit 1
fi

GARAGA_SIERRA_PATH="${GARAGA_SIERRA_PATH:-}"
if [ -z "$GARAGA_SIERRA_PATH" ]; then
  GARAGA_SIERRA_PATH="$(find "$GARAGA_PROJECT_DIR/target/dev" -maxdepth 1 -type f -name '*.contract_class.json' | head -n 1 || true)"
fi
if [ -z "$GARAGA_SIERRA_PATH" ] || [ ! -f "$GARAGA_SIERRA_PATH" ]; then
  echo "❌ Could not find Garaga Sierra artifact under $GARAGA_PROJECT_DIR/target/dev" >&2
  echo "Run: (cd $GARAGA_PROJECT_DIR && scarb build)" >&2
  exit 1
fi

SKIP_DECLARE="${SKIP_DECLARE:-0}"
GARAGA_CLASS_HASH="${GARAGA_CLASS_HASH:-}"
INTENT_ADAPTER_CLASS_HASH="${INTENT_ADAPTER_CLASS_HASH:-}"

if [ "$SKIP_DECLARE" != "1" ]; then
  GARAGA_DECLARE_OUT="$(declare_with_retries "$GARAGA_SIERRA_PATH" "Garaga verifier class" 2>&1 || true)"
  echo "$GARAGA_DECLARE_OUT"
  if ! printf "%s" "$GARAGA_DECLARE_OUT" | grep -Eqi 'class hash|already declared|Contract declaration transaction'; then
    echo "❌ Failed to declare Garaga verifier class." >&2
    exit 1
  fi
  GARAGA_CLASS_HASH="$(extract_class_hash "$GARAGA_DECLARE_OUT")"
  if [ -z "$GARAGA_CLASS_HASH" ]; then
    GARAGA_CLASS_HASH="$(starkli class-hash "$GARAGA_SIERRA_PATH" 2>/dev/null || true)"
  fi
  if [ -z "$GARAGA_CLASS_HASH" ]; then
    echo "❌ Could not parse Garaga class hash from declare output." >&2
    exit 1
  fi

  INTENT_DECLARE_OUT="$(declare_with_retries "$INTENT_SIERRA_PATH" "IntentVerifier adapter class" 2>&1 || true)"
  echo "$INTENT_DECLARE_OUT"
  if ! printf "%s" "$INTENT_DECLARE_OUT" | grep -Eqi 'class hash|already declared|Contract declaration transaction'; then
    echo "❌ Failed to declare IntentVerifier adapter class." >&2
    exit 1
  fi
  INTENT_ADAPTER_CLASS_HASH="$(extract_class_hash "$INTENT_DECLARE_OUT")"
  if [ -z "$INTENT_ADAPTER_CLASS_HASH" ]; then
    INTENT_ADAPTER_CLASS_HASH="$(starkli class-hash "$INTENT_SIERRA_PATH" 2>/dev/null || true)"
  fi
  if [ -z "$INTENT_ADAPTER_CLASS_HASH" ]; then
    echo "❌ Could not parse IntentVerifier class hash from declare output." >&2
    exit 1
  fi
else
  if [ -z "$GARAGA_CLASS_HASH" ] || [ -z "$INTENT_ADAPTER_CLASS_HASH" ]; then
    echo "❌ SKIP_DECLARE=1 requires GARAGA_CLASS_HASH and INTENT_ADAPTER_CLASS_HASH." >&2
    exit 1
  fi
fi

echo "🚀 Deploying Garaga verifier..."
GARAGA_DEPLOY_OUT="$(send_tx_with_retries "Garaga deploy" starkli deploy "$GARAGA_CLASS_HASH" 2>&1 || true)"
echo "$GARAGA_DEPLOY_OUT"
if [ -z "$GARAGA_DEPLOY_OUT" ] || printf "%s" "$GARAGA_DEPLOY_OUT" | grep -qi '^Error:'; then
  echo "❌ Failed to deploy Garaga verifier." >&2
  exit 1
fi
GARAGA_VERIFIER_ADDRESS="$(extract_contract_address "$GARAGA_DEPLOY_OUT")"
if [ -z "$GARAGA_VERIFIER_ADDRESS" ]; then
  echo "❌ Could not parse Garaga verifier address from deploy output." >&2
  exit 1
fi

echo "🚀 Deploying IntentVerifier adapter..."
INTENT_DEPLOY_OUT="$(send_tx_with_retries "Intent adapter deploy" starkli deploy "$INTENT_ADAPTER_CLASS_HASH" "$OWNER_ADDRESS" "$GARAGA_VERIFIER_ADDRESS" 2>&1 || true)"
echo "$INTENT_DEPLOY_OUT"
if [ -z "$INTENT_DEPLOY_OUT" ] || printf "%s" "$INTENT_DEPLOY_OUT" | grep -qi '^Error:'; then
  echo "❌ Failed to deploy IntentVerifier adapter." >&2
  exit 1
fi
INTENT_VERIFIER_ADDRESS="$(extract_contract_address "$INTENT_DEPLOY_OUT")"
if [ -z "$INTENT_VERIFIER_ADDRESS" ]; then
  echo "❌ Could not parse IntentVerifier adapter address from deploy output." >&2
  exit 1
fi

echo "🔁 Updating DarkPool verifier pointer..."
if ! send_tx_with_retries "DarkPool.update_verifier" starkli invoke "$DARK_POOL_ADDRESS" update_verifier "$INTENT_VERIFIER_ADDRESS"; then
  echo "❌ Failed to invoke DarkPool.update_verifier." >&2
  exit 1
fi

cat <<EOF
✅ Garaga verifier stack deployed
- GARAGA_CLASS_HASH=$GARAGA_CLASS_HASH
- GARAGA_VERIFIER_ADDRESS=$GARAGA_VERIFIER_ADDRESS
- INTENT_ADAPTER_CLASS_HASH=$INTENT_ADAPTER_CLASS_HASH
- INTENT_VERIFIER_ADDRESS=$INTENT_VERIFIER_ADDRESS
- DARK_POOL_ADDRESS=$DARK_POOL_ADDRESS (updated)
EOF
