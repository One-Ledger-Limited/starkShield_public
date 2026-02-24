#!/usr/bin/env bash
set -euo pipefail

# End-to-end Garaga rollout on server:
# 1) Ensure verifier project exists
# 2) Build main contracts
# 3) Retry build for generated Garaga verifier
# 4) Deploy verifier stack and update DarkPool verifier pointer

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd scarb
require_cmd starkli

if [ ! -f ".env" ]; then
  echo "Missing .env in $ROOT_DIR" >&2
  exit 1
fi

get_env_value() {
  local key="$1"
  grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true
}

SOLVER_ADDRESS="$(get_env_value SOLVER_ADDRESS)"
DARK_POOL_ADDRESS="$(get_env_value DARK_POOL_ADDRESS)"
SOLVER_PRIVATE_KEY="$(get_env_value SOLVER_PRIVATE_KEY)"
ENV_RPC="$(get_env_value STARKNET_RPC)"

if [ -z "${SOLVER_ADDRESS:-}" ] || [ -z "${DARK_POOL_ADDRESS:-}" ] || [ -z "${SOLVER_PRIVATE_KEY:-}" ]; then
  echo "Required .env keys are missing: SOLVER_ADDRESS, DARK_POOL_ADDRESS, SOLVER_PRIVATE_KEY" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/.starkli-owner-account.json" ]; then
  echo "Missing $ROOT_DIR/.starkli-owner-account.json" >&2
  exit 1
fi

export OWNER_ADDRESS="${OWNER_ADDRESS:-$SOLVER_ADDRESS}"
export STARKNET_ACCOUNT="${STARKNET_ACCOUNT:-$ROOT_DIR/.starkli-owner-account.json}"
export STARKNET_PRIVATE_KEY="${STARKNET_PRIVATE_KEY:-$SOLVER_PRIVATE_KEY}"
export DARK_POOL_ADDRESS
# Use ZAN v0_8 by default; this endpoint supports pending block IDs required by starkli 0.4.x.
if [ -z "${STARKNET_RPC:-}" ]; then
  if [ -n "$ENV_RPC" ] && printf "%s" "$ENV_RPC" | grep -qi '/rpc/v0_8'; then
    export STARKNET_RPC="$ENV_RPC"
  else
    export STARKNET_RPC="https://api.zan.top/public/starknet-sepolia/rpc/v0_8"
  fi
fi

echo "Generating Garaga verifier project (if needed)..."
bash circuits/scripts/generate_garaga_verifier_on_server.sh

echo "Building main contracts..."
(cd contracts && scarb build)

GARAGA_DIR="$ROOT_DIR/contracts/garaga_intent_verifier"
if [ ! -d "$GARAGA_DIR" ]; then
  echo "Missing $GARAGA_DIR" >&2
  exit 1
fi

ARTIFACT_FILE=""
ATTEMPT=0
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  ARTIFACT_FILE="$(find "$GARAGA_DIR/target/dev" -maxdepth 1 -type f -name '*.contract_class.json' | head -n 1 || true)"
  if [ -n "$ARTIFACT_FILE" ] && [ -f "$ARTIFACT_FILE" ]; then
    break
  fi

  ATTEMPT=$((ATTEMPT + 1))
  echo "Building generated Garaga verifier (attempt ${ATTEMPT}/${MAX_ATTEMPTS})..."
  if command -v timeout >/dev/null 2>&1; then
    (cd "$GARAGA_DIR" && timeout "${GARAGA_BUILD_TIMEOUT:-1800}" scarb build)
  else
    (cd "$GARAGA_DIR" && scarb build)
  fi
done

ARTIFACT_FILE="$(find "$GARAGA_DIR/target/dev" -maxdepth 1 -type f -name '*.contract_class.json' | head -n 1 || true)"
if [ -z "$ARTIFACT_FILE" ] || [ ! -f "$ARTIFACT_FILE" ]; then
  echo "Failed to produce Garaga verifier artifact after ${MAX_ATTEMPTS} attempts." >&2
  exit 1
fi

echo "Artifact ready: $ARTIFACT_FILE"
echo "Deploying Garaga stack..."
bash deploy/scripts/zk/deploy_garaga_stack_starkli.sh

echo "Garaga rollout completed."
