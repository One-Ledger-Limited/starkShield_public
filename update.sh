#!/bin/bash

# Update StarkShield Deployment
# Use this to update to the latest code

set -euo pipefail

echo "🔄 Updating StarkShield..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

# Pull latest changes (if using git)
# git pull origin main

# Rebuild and restart
echo "🔨 Rebuilding containers..."
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ Neither docker compose nor docker-compose is installed"
  exit 1
fi

$COMPOSE_CMD -f "$COMPOSE_FILE" down --remove-orphans
$COMPOSE_CMD -f "$COMPOSE_FILE" build --no-cache
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d

echo "⏳ Waiting for services..."
sleep 10

echo "✅ Update complete!"
echo ""
$COMPOSE_CMD -f "$COMPOSE_FILE" ps
