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
tar -czf "$BACKUP_FILE" "$COMPOSE_FILE" .env deploy.sh update.sh backup.sh VERSION RELEASE_VERSION 2>/dev/null || true
echo "💾 Backup created: $BACKUP_FILE"

# Record deployed version (for audit/rollback traceability).
# `auto-deploy.sh` writes RELEASE_VERSION; fall back to timestamp if missing.
if [ -f "RELEASE_VERSION" ]; then
  cp -f RELEASE_VERSION VERSION
else
  echo "unknown-$(date +%Y%m%d%H%M%S)" > VERSION
fi
echo "🏷️  Deploy version: $(cat VERSION 2>/dev/null || true)"

echo "🛑 Stopping existing containers..."
$COMPOSE_CMD -f "$COMPOSE_FILE" down --remove-orphans || true

# Ensure frontend `/circuits/*` static files exist before image build.
echo "🧩 Preparing frontend circuit assets..."
bash deploy/scripts/prepare_frontend_circuit_assets.sh

# If compose couldn't fully tear down (common on some hosts), ensure our named resources
# are removed before recreating to avoid "already exists" conflicts.
docker rm -f starkshield-redis starkshield-solver starkshield-frontend >/dev/null 2>&1 || true
docker network rm starkshield_starkshield-network >/dev/null 2>&1 || true

echo "🔨 Building and starting services..."
# Some hosts configure a flaky Docker registry mirror. BuildKit/buildx will attempt to resolve
# base image metadata via the mirror even when images are already cached locally, which can
# fail deployments with transient 5xx errors. Force the legacy builder and disable pulling.
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"
export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-0}"
export COMPOSE_BAKE="${COMPOSE_BAKE:-0}"

$COMPOSE_CMD -f "$COMPOSE_FILE" build --pull=false
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d

echo "⏳ Waiting for services..."
sleep 15

echo "🔎 Running deployment verification..."
bash deploy/scripts/verify-prod.sh

echo "✅ Deployment complete"
