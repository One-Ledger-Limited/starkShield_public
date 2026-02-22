#!/bin/bash

set -euo pipefail

echo "🚀 StarkShield Secure Auto-Deployment"
echo "====================================="

SERVER_HOST="${SERVER_HOST:-${SERVER_IP:-}}"
DEPLOY_USER="${DEPLOY_USER:-${USERNAME:-}}"
REMOTE_DIR="${REMOTE_DIR:-/vol2/develop/starkshield}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"
LOCAL_DIR="${LOCAL_DIR:-$(pwd)}"
RSYNC_DELETE="${RSYNC_DELETE:-0}"
RSYNC_DRYRUN="${RSYNC_DRYRUN:-0}"

if [ -z "${SERVER_HOST}" ] || [ -z "${DEPLOY_USER}" ]; then
  echo "❌ Missing deployment target."
  echo "Set SERVER_HOST (or legacy SERVER_IP) and DEPLOY_USER (or legacy USERNAME)."
  echo "Example:"
  echo "  SERVER_HOST=your-server.example.com DEPLOY_USER=deploy ./auto-deploy.sh"
  exit 1
fi

SSH_OPTS=(
  -o StrictHostKeyChecking=accept-new
  -o BatchMode=yes
  -o PreferredAuthentications=publickey
  -o PasswordAuthentication=no
)
if [ -n "${SSH_KEY_PATH}" ]; then
  if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "❌ SSH key not found: $SSH_KEY_PATH"
    echo "Set SSH_KEY_PATH to a valid key file, or leave it empty to use your SSH config/agent."
    exit 1
  fi
  SSH_OPTS+=(-i "$SSH_KEY_PATH")
fi

if [ ! -f "$LOCAL_DIR/docker-compose.prod.yml" ]; then
  echo "❌ docker-compose.prod.yml not found under $LOCAL_DIR"
  exit 1
fi

REMOTE="$DEPLOY_USER@$SERVER_HOST"
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

# Build a deploy version string from git if available.
GIT_SHA=""
if command -v git >/dev/null 2>&1 && git -C "$LOCAL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_SHA="$(git -C "$LOCAL_DIR" rev-parse --short HEAD 2>/dev/null || true)"
fi
DEPLOY_VERSION="${DEPLOY_VERSION:-${GIT_SHA:-unknown}-$(date +%Y%m%d%H%M%S)}"

echo "📦 Syncing project files..."
echo "🎯 Target: $REMOTE:$REMOTE_DIR"
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

if [ "$RSYNC_DRYRUN" = "1" ]; then
  echo "✅ Dry-run complete (skipping remote backup/deploy/verify)"
  exit 0
fi

echo "🔐 Ensuring remote scripts are executable..."
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "cd $REMOTE_DIR && chmod +x deploy.sh update.sh backup.sh deploy/scripts/*.sh 2>/dev/null || true"

echo "💾 Creating remote backup..."
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "cd $REMOTE_DIR && mkdir -p backups && ts=\$(date +%Y%m%d%H%M%S) && tar -czf backups/predeploy-\$ts.tar.gz docker-compose.prod.yml .env deploy.sh update.sh backup.sh 2>/dev/null || true"

echo "🏷️  Writing release version on remote: $DEPLOY_VERSION"
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "cd $REMOTE_DIR && echo '$DEPLOY_VERSION' > RELEASE_VERSION"

echo "🚀 Deploying containers..."
if ! ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "cd $REMOTE_DIR && bash deploy.sh"; then
  echo "❌ Deployment failed — attempting rollback..."
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd $REMOTE_DIR && bash deploy/scripts/rollback.sh" || true
  exit 1
fi

echo "🔎 Verifying deployment (explicit)..."
if ! ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "cd $REMOTE_DIR && bash deploy/scripts/verify-prod.sh"; then
  echo "❌ Verification failed — attempting rollback..."
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd $REMOTE_DIR && bash deploy/scripts/rollback.sh" || true
  exit 1
fi

echo "✅ Deployment completed"
