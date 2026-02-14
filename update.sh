#!/bin/bash

# Update StarkShield Deployment
# Use this to update to the latest code

set -e

echo "🔄 Updating StarkShield..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

$COMPOSE_CMD down
$COMPOSE_CMD build --no-cache
$COMPOSE_CMD up -d

echo "⏳ Waiting for services..."
sleep 10

echo "✅ Update complete!"
echo ""
$COMPOSE_CMD ps
