#!/bin/bash

# Backup StarkShield data
# Run this before updates or periodically

BACKUP_DIR="/vol2/develop/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="starkshield_backup_$TIMESTAMP.tar.gz"

echo "💾 Creating backup..."

mkdir -p $BACKUP_DIR

# Backup Redis data
docker exec starkshield-redis-1 redis-cli SAVE 2>/dev/null || true

# Create backup archive
cd /vol2/develop
tar -czf $BACKUP_DIR/$BACKUP_FILE starkshield/

echo "✅ Backup created: $BACKUP_DIR/$BACKUP_FILE"
echo ""
ls -lh $BACKUP_DIR/$BACKUP_FILE
