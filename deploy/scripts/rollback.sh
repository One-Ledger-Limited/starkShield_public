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

# Some environments have a non-writable $HOME (e.g. home owned by root).
# Docker CLI writes config under $DOCKER_CONFIG (or $HOME/.docker by default),
# so force it to a writable location to prevent failures during rollback builds.
export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/starkshield-docker-config}"
mkdir -p "$DOCKER_CONFIG" || true

LATEST_BACKUP="${1:-$(ls -1t backups/release-*.tar.gz 2>/dev/null | head -n 1)}"
if [ -z "${LATEST_BACKUP:-}" ] || [ ! -f "$LATEST_BACKUP" ]; then
  echo "❌ No backup archive found. Pass backup path as first argument."
  exit 1
fi

echo "♻️ Rolling back using: $LATEST_BACKUP"
$COMPOSE_CMD -f "$COMPOSE_FILE" down || true
tar -xzf "$LATEST_BACKUP" -C "$DEPLOY_DIR"
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --build
bash deploy/scripts/verify-prod.sh
echo "✅ Rollback complete"
