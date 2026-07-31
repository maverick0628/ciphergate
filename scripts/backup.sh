#!/bin/sh
# CipherGate SQLite backup script
#
# Runs inside the backup container via cron. Uses SQLite's .backup command
# (not file copy) to get a consistent snapshot while the gateway is live —
# this handles WAL mode correctly.
#
# Layout:
#   /data/gateway.db           <- live database (shared volume with gateway)
#   /backups/daily/YYYYMMDD.db <- daily snapshots
#   /backups/weekly/...
#
# Retention:
#   - Keep last 7 daily backups
#   - Keep last 4 weekly backups (Sundays)
#   - Everything older is pruned

set -eu

DB_PATH="${DB_PATH:-/data/gateway.db}"
BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
DAILY_DIR="${BACKUP_ROOT}/daily"
WEEKLY_DIR="${BACKUP_ROOT}/weekly"
PUSHOVER_APP_TOKEN="${PUSHOVER_APP_TOKEN:-}"
PUSHOVER_USER_KEY="${PUSHOVER_USER_KEY:-}"

DATE=$(date -u +%Y%m%d)
DOW=$(date -u +%u)  # 1-7, 7 = Sunday
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Push alerts go to Pushover. Fire-and-forget: a Pushover outage must never
# fail the backup. Skipped entirely if either credential is absent.
notify_failure() {
  MSG="$1"
  { [ -z "$PUSHOVER_APP_TOKEN" ] || [ -z "$PUSHOVER_USER_KEY" ]; } && return 0
  curl -s -X POST https://api.pushover.net/1/messages.json \
    --form-string "token=${PUSHOVER_APP_TOKEN}" \
    --form-string "user=${PUSHOVER_USER_KEY}" \
    --form-string "title=CipherGate backup failed" \
    --form-string "message=${MSG}" \
    --form-string "priority=1" >/dev/null 2>&1 || true
}

notify_success() {
  MSG="$1"
  { [ -z "$PUSHOVER_APP_TOKEN" ] || [ -z "$PUSHOVER_USER_KEY" ]; } && return 0
  curl -s -X POST https://api.pushover.net/1/messages.json \
    --form-string "token=${PUSHOVER_APP_TOKEN}" \
    --form-string "user=${PUSHOVER_USER_KEY}" \
    --form-string "title=CipherGate backup OK" \
    --form-string "message=${MSG}" \
    --form-string "priority=0" >/dev/null 2>&1 || true
}

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

# Pre-flight: verify source DB exists and is readable
if [ ! -f "$DB_PATH" ]; then
  echo "[$TIMESTAMP] ERROR: source database not found at $DB_PATH"
  notify_failure "Source database missing: $DB_PATH"
  exit 1
fi

DAILY_FILE="${DAILY_DIR}/${DATE}.db"

# Use SQLite .backup (handles WAL mode + live writes atomically)
# The `.backup` command is safer than file copy because it uses SQLite's
# online backup API to get a consistent snapshot even while the gateway
# is actively writing.
echo "[$TIMESTAMP] Starting backup → $DAILY_FILE"
if ! sqlite3 "$DB_PATH" ".backup '$DAILY_FILE'"; then
  echo "[$TIMESTAMP] ERROR: sqlite3 .backup failed"
  notify_failure "sqlite3 .backup failed for $DB_PATH"
  exit 1
fi

# Integrity check on the backup
if ! sqlite3 "$DAILY_FILE" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "[$TIMESTAMP] ERROR: backup failed integrity check"
  notify_failure "Backup integrity check failed: $DAILY_FILE"
  rm -f "$DAILY_FILE"
  exit 1
fi

BACKUP_SIZE=$(wc -c < "$DAILY_FILE" | tr -d ' ')
echo "[$TIMESTAMP] Backup complete — size: ${BACKUP_SIZE} bytes"

# Weekly snapshot — copy Sunday's daily into weekly/
if [ "$DOW" = "7" ]; then
  WEEKLY_FILE="${WEEKLY_DIR}/${DATE}.db"
  cp "$DAILY_FILE" "$WEEKLY_FILE"
  echo "[$TIMESTAMP] Weekly snapshot created: $WEEKLY_FILE"
fi

# Pruning
# Daily: keep last 7
find "$DAILY_DIR" -name "*.db" -type f | sort | head -n -7 | while read -r old; do
  echo "[$TIMESTAMP] Pruning old daily backup: $old"
  rm -f "$old"
done

# Weekly: keep last 4
find "$WEEKLY_DIR" -name "*.db" -type f | sort | head -n -4 | while read -r old; do
  echo "[$TIMESTAMP] Pruning old weekly backup: $old"
  rm -f "$old"
done

echo "[$TIMESTAMP] Backup job done"

# Optional: notify on success (disabled by default to reduce noise)
if [ -n "${PUSHOVER_ON_SUCCESS:-}" ]; then
  notify_success "Backup OK — ${BACKUP_SIZE} bytes"
fi
