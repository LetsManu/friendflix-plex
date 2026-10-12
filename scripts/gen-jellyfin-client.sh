#!/usr/bin/env bash
# Generates typed Jellyfin API paths from YOUR instance's OpenAPI spec.
# Usage: JELLYFIN_URL=http://jellyfin:8096 ./scripts/gen-jellyfin-client.sh
# Jellyfin >= 10.9 serves the spec at /api-docs/openapi.json (Swagger UI: /api-docs/swagger/index.html).
set -euo pipefail
: "${JELLYFIN_URL:?set JELLYFIN_URL}"
npx --yes openapi-typescript "${JELLYFIN_URL%/}/api-docs/openapi.json" -o backend/src/jellyfin/schema.d.ts
echo "Wrote backend/src/jellyfin/schema.d.ts - commit it and review diffs between Jellyfin versions."
