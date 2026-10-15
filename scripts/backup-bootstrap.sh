#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Backs up the `bootstrap` volume (generated secrets: database and Redis passwords, APP_ENC_KEY, INTERNAL_SECRET) into a tarball.
# Backup = database dump (scripts/backup.sh or the backup sidecar) + this file. Keep it apart from the dumps: the encryption key
# next to the data it protects defeats the separation. Without it, a restored database loses its encrypted settings and stored
# Jellyfin passwords. The gateway's volume needs no backup (the bootstrap service copies internal_secret into it on every start).
#   ./scripts/backup-bootstrap.sh                 -> ./backups/friendflix-bootstrap-<UTC time>.tgz (mode 0600, owned by the caller)
# Restore into a fresh (empty) volume before the first `docker compose up`:
#   docker volume create friendflix_bootstrap
#   docker run --rm -v friendflix_bootstrap:/s -v "$PWD/backups":/b:ro \
#     alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 tar xzf /b/<file>.tgz -C /s
# Env: BACKUP_DIR (default ./backups), COMPOSE_PROJECT_NAME (default friendflix).
set -euo pipefail
# pinned by digest like the Dockerfiles (it runs as root against the secrets volume); bump tag + digest by hand
IMAGE="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
DIR="${BACKUP_DIR:-./backups}"
VOLUME="${COMPOSE_PROJECT_NAME:-friendflix}_bootstrap"
umask 077
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
NAME="friendflix-bootstrap-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || { echo "volume $VOLUME not found (start the stack once, or set COMPOSE_PROJECT_NAME)" >&2; exit 1; }
# tar runs as root in the helper container (the files are root:10001, 0440; the archive keeps owners and modes), then hands
# the archive to the caller's uid/gid, so a non-root operator in the docker group can read, copy and delete it
docker run --rm --network none -e OWNER="$(id -u):$(id -g)" -e NAME="$NAME" -v "$VOLUME":/s:ro -v "$DIR":/b "$IMAGE" \
  sh -c 'tar czf "/b/$NAME.tmp" -C /s . && chown "$OWNER" "/b/$NAME.tmp" && chmod 600 "/b/$NAME.tmp" && mv "/b/$NAME.tmp" "/b/$NAME"'
[ -s "$DIR/$NAME" ] || { echo "backup is empty" >&2; rm -f "$DIR/$NAME"; exit 1; }
echo "$DIR/$NAME"
