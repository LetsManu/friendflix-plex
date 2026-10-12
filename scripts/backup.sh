#!/usr/bin/env bash
# Postgres backup (custom format, restorable with pg_restore). Run daily from cron:
#   0 3 * * * cd /opt/friendflix && ./scripts/backup.sh >> backups/backup.log 2>&1
# Docker mode (default): pg_dump inside the `postgres` compose service.
# Local mode: BACKUP_PGURL=postgres://user:pw@host:5432/friendflix ./scripts/backup.sh
set -euo pipefail
DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
umask 077
mkdir -p "$DIR"
OUT="$DIR/friendflix-$(date -u +%Y%m%dT%H%M%SZ).dump"
if [ -n "${BACKUP_PGURL:-}" ]; then
  pg_dump -Fc "$BACKUP_PGURL" > "$OUT.tmp"
else
  docker compose exec -T postgres pg_dump -U friendflix -Fc friendflix > "$OUT.tmp"
fi
[ -s "$OUT.tmp" ] || { echo "backup is empty" >&2; rm -f "$OUT.tmp"; exit 1; }
mv "$OUT.tmp" "$OUT"
find "$DIR" -name 'friendflix-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$OUT"
