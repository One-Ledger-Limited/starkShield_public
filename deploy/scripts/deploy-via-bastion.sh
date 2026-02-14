#!/bin/bash

set -euo pipefail

echo "🚀 StarkShield Deployment (via bastion)"
echo "======================================"

LOCAL_DIR="${LOCAL_DIR:-$(pwd)}"
REMOTE_DIR="${REMOTE_DIR:-/vol2/develop/starkshield}"

BASTION_HOST="${BASTION_HOST:-}"
BASTION_USER="${BASTION_USER:-}"

TARGET_HOST="${TARGET_HOST:-}"
TARGET_USER="${TARGET_USER:-}"

# Optional password-based auth (prefer SSH keys if possible).
# - If unset/empty, normal ssh/scp will be used.
# - If set, passwords are passed via env (not on the command line).
BASTION_SSHPASS="${BASTION_SSHPASS:-}"
TARGET_SSHPASS="${TARGET_SSHPASS:-}"

# If you need password auth, prefer prompting (TTY) over exporting env vars.
PROMPT_FOR_PASSWORDS="${PROMPT_FOR_PASSWORDS:-0}"

# Optional sudo support on the target host (set to "1" to use sudo).
USE_SUDO_ON_TARGET="${USE_SUDO_ON_TARGET:-0}"
TARGET_SUDOPASS="${TARGET_SUDOPASS:-}"

if [ ! -f "$LOCAL_DIR/docker-compose.prod.yml" ]; then
  echo "❌ docker-compose.prod.yml not found under: $LOCAL_DIR"
  exit 1
fi

if [ -z "$BASTION_HOST" ] || [ -z "$BASTION_USER" ] || [ -z "$TARGET_HOST" ] || [ -z "$TARGET_USER" ]; then
  echo "❌ Missing bastion/target configuration."
  echo "Set: BASTION_HOST, BASTION_USER, TARGET_HOST, TARGET_USER"
  echo "Example:"
  echo "  BASTION_HOST=bastion.example.com BASTION_USER=jump \\"
  echo "  TARGET_HOST=10.0.0.10 TARGET_USER=deploy \\"
  echo "  ./deploy/scripts/deploy-via-bastion.sh"
  exit 1
fi

if [ ! -d "$LOCAL_DIR/deploy/scripts" ]; then
  echo "❌ deploy/scripts not found under: $LOCAL_DIR"
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "❌ tar is required"
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "❌ ssh is required"
  exit 1
fi

if [ "$PROMPT_FOR_PASSWORDS" = "1" ]; then
  if [ -z "$BASTION_SSHPASS" ]; then
    read -r -s -p "Bastion SSH password: " BASTION_SSHPASS
    echo ""
  fi
  if [ -z "$TARGET_SSHPASS" ]; then
    read -r -s -p "Target SSH password: " TARGET_SSHPASS
    echo ""
  fi
  if [ "$USE_SUDO_ON_TARGET" = "1" ] && [ -z "$TARGET_SUDOPASS" ]; then
    read -r -s -p "Target sudo password (leave empty if passwordless sudo): " TARGET_SUDOPASS
    echo ""
  fi
fi

if [ -n "$BASTION_SSHPASS" ] || [ -n "$TARGET_SSHPASS" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "❌ sshpass is required for password auth"
    exit 1
  fi
fi

REMOTE="${TARGET_USER}@${TARGET_HOST}"

PROXY_CMD="ssh -o StrictHostKeyChecking=accept-new -W %h:%p ${BASTION_USER}@${BASTION_HOST}"
if [ -n "$BASTION_SSHPASS" ]; then
  PROXY_CMD="env SSHPASS=\"${BASTION_SSHPASS}\" sshpass -e ssh -o StrictHostKeyChecking=accept-new -W %h:%p ${BASTION_USER}@${BASTION_HOST}"
fi

SSH_CMD=(ssh -o StrictHostKeyChecking=accept-new -o "ProxyCommand=${PROXY_CMD}")
SCP_CMD=(scp -o StrictHostKeyChecking=accept-new -o "ProxyCommand=${PROXY_CMD}")

if [ -n "$TARGET_SSHPASS" ]; then
  SSH_CMD=(env SSHPASS="${TARGET_SSHPASS}" sshpass -e ssh -o StrictHostKeyChecking=accept-new -o "ProxyCommand=${PROXY_CMD}")
  SCP_CMD=(env SSHPASS="${TARGET_SSHPASS}" sshpass -e scp -o StrictHostKeyChecking=accept-new -o "ProxyCommand=${PROXY_CMD}")
fi

TARBALL="$(mktemp /tmp/starkshield-deploy.XXXXXX.tar.gz)"
cleanup() {
  rm -f "$TARBALL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "📦 Creating release tarball..."
tar -czf "$TARBALL" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='target' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='*.log' \
  --exclude='.env' \
  -C "$LOCAL_DIR" \
  .

echo "📤 Uploading tarball to target via bastion..."
REMOTE_TARBALL="/tmp/starkshield-deploy.tar.gz"
"${SCP_CMD[@]}" "$TARBALL" "${REMOTE}:${REMOTE_TARBALL}"

echo "📂 Extracting release on target..."
extract_cmd="mkdir -p \"$REMOTE_DIR\" && tar -xzf \"$REMOTE_TARBALL\" -C \"$REMOTE_DIR\" && rm -f \"$REMOTE_TARBALL\""
if [ "$USE_SUDO_ON_TARGET" = "1" ]; then
  if [ -n "$TARGET_SUDOPASS" ]; then
    "${SSH_CMD[@]}" "$REMOTE" "echo \"$TARGET_SUDOPASS\" | sudo -S sh -lc '$extract_cmd'"
  else
    "${SSH_CMD[@]}" "$REMOTE" "sudo sh -lc '$extract_cmd'"
  fi
else
  "${SSH_CMD[@]}" "$REMOTE" "$extract_cmd"
fi

echo "🔐 Ensuring scripts are executable..."
chmod_cmd="cd \"$REMOTE_DIR\" && chmod +x deploy.sh update.sh backup.sh deploy/scripts/*.sh 2>/dev/null || true"
if [ "$USE_SUDO_ON_TARGET" = "1" ]; then
  if [ -n "$TARGET_SUDOPASS" ]; then
    "${SSH_CMD[@]}" "$REMOTE" "echo \"$TARGET_SUDOPASS\" | sudo -S sh -lc '$chmod_cmd'"
  else
    "${SSH_CMD[@]}" "$REMOTE" "sudo sh -lc '$chmod_cmd'"
  fi
else
  "${SSH_CMD[@]}" "$REMOTE" "$chmod_cmd"
fi

echo "🚀 Running deployment on target..."
if [ "$USE_SUDO_ON_TARGET" = "1" ]; then
  if [ -n "$TARGET_SUDOPASS" ]; then
    "${SSH_CMD[@]}" "$REMOTE" "cd \"$REMOTE_DIR\" && echo \"$TARGET_SUDOPASS\" | sudo -S bash deploy.sh"
  else
    "${SSH_CMD[@]}" "$REMOTE" "cd \"$REMOTE_DIR\" && sudo bash deploy.sh"
  fi
else
  "${SSH_CMD[@]}" "$REMOTE" "cd \"$REMOTE_DIR\" && bash deploy.sh"
fi

echo "🔎 Verifying deployment..."
if [ "$USE_SUDO_ON_TARGET" = "1" ]; then
  if [ -n "$TARGET_SUDOPASS" ]; then
    "${SSH_CMD[@]}" "$REMOTE" "cd \"$REMOTE_DIR\" && echo \"$TARGET_SUDOPASS\" | sudo -S bash deploy/scripts/verify-prod.sh"
  else
    "${SSH_CMD[@]}" "$REMOTE" "cd \"$REMOTE_DIR\" && sudo bash deploy/scripts/verify-prod.sh"
  fi
else
  "${SSH_CMD[@]}" "$REMOTE" "cd \"$REMOTE_DIR\" && bash deploy/scripts/verify-prod.sh"
fi

echo "✅ Deployment completed"
