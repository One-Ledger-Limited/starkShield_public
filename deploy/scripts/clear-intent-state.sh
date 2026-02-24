#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

cd "$DEPLOY_DIR"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ Neither docker compose nor docker-compose is installed"
  exit 1
fi

echo "🧹 Clearing solver intent/match state from Redis..."

# Remove state keys used by pending/matched/cancelled intent lifecycle.
# This intentionally wipes persisted solver intent history so each deployment
# starts from a clean runtime state.
PATTERNS=(
  "intent:*"
  "intents:pending"
  "intents:matched"
  "intents:user:*"
  "intents:pair:*"
  "matched:*"
  "match:retry:*"
)

for pattern in "${PATTERNS[@]}"; do
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    $COMPOSE_CMD -f "$COMPOSE_FILE" exec -T redis redis-cli DEL "$key" >/dev/null
  done < <($COMPOSE_CMD -f "$COMPOSE_FILE" exec -T redis redis-cli --scan --pattern "$pattern")
done

echo "✅ Redis intent/match state cleared"
