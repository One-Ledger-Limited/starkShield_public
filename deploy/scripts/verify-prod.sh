#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SOLVER_HOST_PORT="${SOLVER_HOST_PORT:-18080}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-15173}"

cd "$DEPLOY_DIR"

if [ -f "VERSION" ]; then
  echo "🏷️  Deployed version: $(cat VERSION 2>/dev/null || true)"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ Neither docker compose nor docker-compose is installed"
  exit 1
fi

echo "📊 Container status"
$COMPOSE_CMD -f "$COMPOSE_FILE" ps

echo "🩺 Health checks"
curl -fsS --max-time 10 "http://localhost:${SOLVER_HOST_PORT}/v1/health" >/dev/null
curl -fsS --max-time 10 "http://localhost:${FRONTEND_HOST_PORT}" >/dev/null
$COMPOSE_CMD -f "$COMPOSE_FILE" exec -T redis redis-cli ping | grep -q PONG

echo "🧪 Starknet JSON-RPC proxy check"
# Avoid browser CORS issues by proxying Starknet JSON-RPC through the solver.
curl -fsS --max-time 15 \
  -H 'Content-Type: application/json' \
  -X POST "http://localhost:${SOLVER_HOST_PORT}/v1/starknet-rpc" \
  -d '{"jsonrpc":"2.0","id":1,"method":"starknet_chainId","params":[]}' \
  | grep -q '"result"'

echo "🧪 Pragma TWAP check"
# TWAP is used for "Minimum exchange rate" and slippage calculations.
curl -fsS --max-time 20 \
  "http://localhost:${SOLVER_HOST_PORT}/v1/prices/pragma/twap?pair_id=ETH/USD&window_seconds=3600" \
  | grep -q '"success"[[:space:]]*:[[:space:]]*true'

echo "🪵 Recent solver logs"
$COMPOSE_CMD -f "$COMPOSE_FILE" logs --tail=50 solver

echo "✅ Verification passed"
