#!/bin/bash

set -euo pipefail

echo "🚀 Starting StarkShield deployment..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$SCRIPT_DIR}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

if [ ! -d "$DEPLOY_DIR" ]; then
  echo "❌ Deploy directory missing: $DEPLOY_DIR"
  exit 1
fi

cd "$DEPLOY_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Docker is not installed"
  exit 1
fi

# Some environments have a non-writable $HOME (e.g. home owned by root).
# Docker CLI writes config under $DOCKER_CONFIG (or $HOME/.docker by default),
# so force it to a writable location to prevent build failures.
export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/starkshield-docker-config}"
mkdir -p "$DOCKER_CONFIG" || true

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ Neither docker compose nor docker-compose is installed"
  exit 1
fi

mkdir -p backups
BACKUP_FILE="backups/release-$(date +%Y%m%d%H%M%S).tar.gz"
tar -czf "$BACKUP_FILE" "$COMPOSE_FILE" .env deploy.sh update.sh backup.sh 2>/dev/null || true
echo "💾 Backup created: $BACKUP_FILE"

echo "🛑 Stopping existing containers..."
$COMPOSE_CMD -f "$COMPOSE_FILE" down || true

echo "🔨 Building and starting services..."
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --build

echo "⏳ Waiting for services..."
sleep 15

echo "🔎 Running deployment verification..."
bash deploy/scripts/verify-prod.sh

echo "✅ Deployment complete"
