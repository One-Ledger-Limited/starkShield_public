#!/bin/bash

set -euo pipefail

echo "🚀 StarkShield Secure Auto-Deployment"
echo "====================================="

SERVER_HOST="${SERVER_HOST:-${SERVER_IP:-}}"
USERNAME="${USERNAME:-}"
REMOTE_DIR="${REMOTE_DIR:-/vol2/develop/starkshield}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_rsa}"
LOCAL_DIR="${LOCAL_DIR:-$(pwd)}"
RSYNC_DELETE="${RSYNC_DELETE:-0}"
RSYNC_DRYRUN="${RSYNC_DRYRUN:-0}"

if [ -z "${SERVER_HOST}" ] || [ -z "${USERNAME}" ]; then
  echo "❌ Missing deployment target."
  echo "Set SERVER_HOST (or legacy SERVER_IP) and USERNAME."
  echo "Example:"
  echo "  SERVER_HOST=your-server.example.com USERNAME=deploy ./auto-deploy.sh"
  exit 1
fi

if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "❌ SSH key not found: $SSH_KEY_PATH"
  echo "Set SSH_KEY_PATH or provision key-based login first."
  exit 1
fi

if [ ! -f "$LOCAL_DIR/docker-compose.prod.yml" ]; then
  echo "❌ docker-compose.prod.yml not found under $LOCAL_DIR"
  exit 1
fi

REMOTE="$USERNAME@$SERVER_HOST"
RSYNC_SSH="ssh -i $SSH_KEY_PATH -o StrictHostKeyChecking=accept-new"

echo "📦 Syncing project files..."
RSYNC_FLAGS=( -avz )
if [ "$RSYNC_DELETE" = "1" ]; then
  RSYNC_FLAGS+=( --delete )
else
  echo "ℹ️  RSYNC_DELETE=0 (default) — remote-only files will be preserved (recommended for rollback/logs/SSL)."
fi

if [ "$RSYNC_DRYRUN" = "1" ]; then
  RSYNC_FLAGS+=( --dry-run )
  echo "ℹ️  RSYNC_DRYRUN=1 — not making any changes on the remote."
fi

rsync "${RSYNC_FLAGS[@]}" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='target' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='*.log' \
  --exclude='logs' \
  --exclude='backups' \
  --exclude='nginx/ssl' \
  --exclude='.env' \
  -e "$RSYNC_SSH" \
  "$LOCAL_DIR/" "$REMOTE:$REMOTE_DIR/"

echo "🔐 Ensuring remote scripts are executable..."
ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE" \
  "cd $REMOTE_DIR && chmod +x deploy.sh update.sh backup.sh deploy/scripts/*.sh 2>/dev/null || true"

echo "💾 Creating remote backup..."
ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE" \
  "cd $REMOTE_DIR && mkdir -p backups && ts=\$(date +%Y%m%d%H%M%S) && tar -czf backups/predeploy-\$ts.tar.gz docker-compose.prod.yml .env deploy.sh update.sh backup.sh 2>/dev/null || true"

echo "🚀 Deploying containers..."
if ! ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE" \
  "cd $REMOTE_DIR && bash deploy.sh"; then
  echo "❌ Deployment failed — attempting rollback..."
  ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE" \
    "cd $REMOTE_DIR && bash deploy/scripts/rollback.sh" || true
  exit 1
fi

echo "🔎 Verifying deployment (explicit)..."
if ! ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE" \
  "cd $REMOTE_DIR && bash deploy/scripts/verify-prod.sh"; then
  echo "❌ Verification failed — attempting rollback..."
  ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE" \
    "cd $REMOTE_DIR && bash deploy/scripts/rollback.sh" || true
  exit 1
fi

echo "✅ Deployment completed"
