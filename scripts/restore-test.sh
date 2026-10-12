#!/usr/bin/env bash
# Proves that the newest backup is restorable: restores it into a throw-away Postgres and sanity-checks it.
# Docker mode (default): temporary postgres:17-alpine container without published ports.
# Local mode: RESTORE_ADMIN_URL=postgres://postgres@localhost:5432/postgres (creates + drops ff_restore_test)
# Optional: BACKUP_PGURL=<source db url> additionally compares row counts with the live database.
set -euo pipefail
DIR="${BACKUP_DIR:-./backups}"
DUMP="${1:-$(ls -1t "$DIR"/friendflix-*.dump 2>/dev/null | head -n1)}"
[ -n "${DUMP:-}" ] && [ -s "$DUMP" ] || { echo "no backup found in $DIR" >&2; exit 1; }
TABLES="users invites devices audit_log polls ratings play_seconds"

if [ -n "${RESTORE_ADMIN_URL:-}" ]; then
  DB=ff_restore_test
  psql "$RESTORE_ADMIN_URL" -qc "drop database if exists $DB" -c "create database $DB"
  TARGET="${RESTORE_ADMIN_URL%/*}/$DB"
  trap 'psql "$RESTORE_ADMIN_URL" -qc "drop database if exists $DB" >/dev/null' EXIT
  SQL() { psql -At "$TARGET" -c "$1"; }
  pg_restore --no-owner -d "$TARGET" "$DUMP"
else
  NAME="ff-restore-test-$$"
  docker run -d --rm --name "$NAME" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=friendflix postgres:17-alpine >/dev/null
  trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres -d friendflix >/dev/null 2>&1 && break; sleep 1; done
  SQL() { docker exec "$NAME" psql -At -U postgres -d friendflix -c "$1"; }
  docker exec -i "$NAME" pg_restore --no-owner -U postgres -d friendflix < "$DUMP"
fi

MIG=$(SQL "select count(*) from schema_migrations")
[ "$MIG" -gt 0 ] || { echo "RESTORE FAILED: no migrations in backup" >&2; exit 1; }
for t in $TABLES; do
  RESTORED=$(SQL "select count(*) from $t")
  if [ -n "${BACKUP_PGURL:-}" ]; then
    LIVE=$(psql -At "$BACKUP_PGURL" -c "select count(*) from $t")
    # allow rows that were written after the dump
    [ "$RESTORED" -le "$LIVE" ] || { echo "RESTORE FAILED: $t has more rows than live" >&2; exit 1; }
  fi
  echo "  $t: $RESTORED rows"
done
echo "RESTORE OK ($DUMP, $MIG migrations)"
