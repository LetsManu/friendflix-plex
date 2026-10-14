#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Rebuilds one FriendFlix image from git, bit for bit, and prints its image manifest digest. With --compare it checks the
# result against a published image (ghcr.io/…:tag or …@sha256:…). Used by the CI job `reproducible` and by anyone who
# wants to check a release: docs/reproducible-builds.md.
#
#   scripts/reproduce-image.sh SERVICE [--ref REF] [--compare IMAGE] [--out FILE]
#   scripts/reproduce-image.sh --diff A.oci.tar B.oci.tar   (explains a mismatch: config + per-layer file listings)
#     SERVICE    backend | gateway | web
#     --ref      commit / tag to build (default HEAD). The build context is `git archive REF`, so local changes,
#                untracked files, file mtimes and the umask of your checkout cannot leak into the image.
#     --compare  published image to compare with. Its labels and the build-arg ENVs (GIT_SHA, BUILD_TIME, APP_VERSION,
#                APP_CODENAME) are copied into the rebuild: they are metadata the release pipeline added; everything
#                else (layers, rest of the config) must come out identical. Exit 1 on a digest mismatch.
#     --out      where to write the OCI tarball (default: a temp file, deleted at the end)
#
# Needs: git, jq, docker with buildx. Builds in a fresh, throw-away docker-container builder running the BuildKit image
# pinned in .github/workflows/ci.yml (BUILDKIT_IMAGE), with --no-cache, SOURCE_DATE_EPOCH = commit time,
# rewrite-timestamp=true and without SBOM/provenance (those attestations carry build times; they are separate manifests
# and never part of the compared image manifest). BUILDER=<name> uses an existing builder instead (it must run the
# same BuildKit version, or the result may legitimately differ).
set -euo pipefail

usage() { awk 'NR >= 5 && /^#/ { sub(/^# ?/, ""); print } /^set -euo/ { exit }' "$0" >&2; exit 2; }
log() { echo "reproduce-image: $*" >&2; }

# --diff: which part of two OCI tarballs (from --out) differs - config, and for each differing layer the file listing
# (mode, owner, size, mtime, name), which is where non-determinism shows up
if [ "${1:-}" = --diff ]; then
  [ $# -eq 3 ] || usage
  A=$2 B=$3
  blob() { tar -xOf "$1" "blobs/${2%%:*}/${2#*:}"; }
  manifest() { local d; d=$(tar -xOf "$1" index.json | jq -r '.manifests[0].digest'); blob "$1" "$d"; }
  ma=$(manifest "$A"); mb=$(manifest "$B")
  ca=$(blob "$A" "$(jq -r .config.digest <<< "$ma")"); cb=$(blob "$B" "$(jq -r .config.digest <<< "$mb")")
  echo "== config (A vs B)"; diff <(jq -S . <<< "$ca") <(jq -S . <<< "$cb") || true
  n=$(jq '.layers | length' <<< "$ma")
  for i in $(seq 0 $((n - 1))); do
    la=$(jq -r ".layers[$i].digest" <<< "$ma"); lb=$(jq -r ".layers[$i].digest // empty" <<< "$mb")
    [ "$la" = "$lb" ] && continue
    echo "== layer $i differs: $la vs ${lb:-<missing>} ($(jq -r ".history | map(select(.empty_layer != true))[$i].created_by // \"?\"" <<< "$ca"))"
    [ -n "$lb" ] || continue
    diff <(blob "$A" "$la" | tar -tvzf - --full-time | sort -k6) <(blob "$B" "$lb" | tar -tvzf - --full-time | sort -k6) | head -n 60 || true
  done
  exit 0
fi
SERVICE="${1:-}"; [ -n "$SERVICE" ] || usage; shift
case "$SERVICE" in backend|gateway|web) ;; *) usage ;; esac
REF=HEAD COMPARE='' OUT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --compare) COMPARE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel)
SHA=$(git -C "$ROOT" rev-parse --verify "$REF^{commit}")
SOURCE_DATE_EPOCH=$(git -C "$ROOT" log -1 --format=%ct "$SHA")
export SOURCE_DATE_EPOCH
BUILD_TIME=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
WORK=$(mktemp -d)
BUILDER_CREATED=
cleanup() {
  if [ -n "$BUILDER_CREATED" ]; then docker buildx rm "$BUILDER_CREATED" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# build context = the committed tree only; git archive stamps every entry with the commit time (= SOURCE_DATE_EPOCH)
umask 022
mkdir "$WORK/ctx"
git -C "$ROOT" -c tar.umask=0022 archive --format=tar "$SHA" | tar -x -C "$WORK/ctx"

ctx_file() { cat "$WORK/ctx/$1"; }
GIT_SHA_ARG=$SHA
APP_VERSION=$(ctx_file version.json | jq -er .version)
APP_CODENAME=$(ctx_file version.json | jq -er .codename)
LABELS=()
EXPECTED=

if [ -n "$COMPARE" ]; then
  raw=$(docker buildx imagetools inspect --raw "$COMPARE")
  case "$(jq -r '.mediaType // empty' <<< "$raw")" in
    application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
      EXPECTED=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest' <<< "$raw") ;;
    *)
      EXPECTED=$(docker buildx imagetools inspect "$COMPARE" --format '{{.Manifest.Digest}}') ;;
  esac
  cfg=$(docker buildx imagetools inspect "$COMPARE" --format '{{json .Image}}')
  jq -e 'has("rootfs")' <<< "$cfg" >/dev/null || cfg=$(jq -e '."linux/amd64"' <<< "$cfg")
  envval() { jq -r --arg k "$1" '(.config.Env // [])[] | select(startswith($k + "=")) | sub("^[^=]*="; "")' <<< "$cfg"; }
  GIT_SHA_ARG=$(envval GIT_SHA); BUILD_TIME=$(envval BUILD_TIME)
  APP_VERSION=$(envval APP_VERSION); APP_CODENAME=$(envval APP_CODENAME)
  [ "$GIT_SHA_ARG" = "$SHA" ] || log "warning: $COMPARE was built from GIT_SHA=$GIT_SHA_ARG, you are rebuilding $SHA (use --ref $GIT_SHA_ARG)"
  while IFS= read -r l; do [ -n "$l" ] && LABELS+=(--label "$l"); done < <(jq -r '(.config.Labels // {}) | to_entries[] | "\(.key)=\(.value)"' <<< "$cfg")
  log "comparing with $COMPARE -> linux/amd64 manifest $EXPECTED"
fi

BUILDER_ARGS=()
if [ -n "${BUILDER:-}" ]; then
  BUILDER_ARGS=(--builder "$BUILDER")
else
  BK_IMAGE=$(ctx_file .github/workflows/ci.yml | sed -n 's/^ *BUILDKIT_IMAGE: *\([^ #]*\).*/\1/p' | head -n1)
  [ -n "$BK_IMAGE" ] || { log "BUILDKIT_IMAGE not found in .github/workflows/ci.yml at $SHA"; exit 1; }
  BUILDER_CREATED="ff-repro-$$-$RANDOM"
  docker buildx create --name "$BUILDER_CREATED" --driver docker-container --driver-opt "image=$BK_IMAGE" >/dev/null
  BUILDER_ARGS=(--builder "$BUILDER_CREATED")
  log "fresh builder $BUILDER_CREATED ($BK_IMAGE)"
fi

[ -n "$OUT" ] || OUT="$WORK/image.oci.tar"
log "building $SERVICE at $SHA (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH, BUILD_TIME=$BUILD_TIME)"
docker buildx build "${BUILDER_ARGS[@]}" \
  --no-cache --pull --platform linux/amd64 \
  --provenance=false --sbom=false \
  --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
  --build-arg "GIT_SHA=$GIT_SHA_ARG" \
  --build-arg "BUILD_TIME=$BUILD_TIME" \
  --build-arg "APP_VERSION=$APP_VERSION" \
  --build-arg "APP_CODENAME=$APP_CODENAME" \
  ${LABELS[@]+"${LABELS[@]}"} \
  --file "$WORK/ctx/$SERVICE/Dockerfile" \
  --output "type=oci,dest=$OUT,oci-mediatypes=true,compression=gzip,rewrite-timestamp=true" \
  "$WORK/ctx" >&2

blob() { tar -xOf "$OUT" "blobs/${1%%:*}/${1#*:}"; }
# index.json -> the image manifest (descend through a nested index, should the exporter write one)
desc=$(tar -xOf "$OUT" index.json | jq -ec '.manifests[0]')
while [ "$(jq -r .mediaType <<< "$desc")" = application/vnd.oci.image.index.v1+json ]; do
  desc=$(blob "$(jq -r .digest <<< "$desc")" | jq -ec '[.manifests[] | select(.platform.architecture == "amd64")][0]')
done
DIGEST=$(jq -er .digest <<< "$desc")
echo "$DIGEST"

if [ -n "$EXPECTED" ]; then
  if [ "$DIGEST" = "$EXPECTED" ]; then
    log "OK: rebuilt $SERVICE is identical to $COMPARE ($DIGEST)"
  else
    log "MISMATCH: rebuilt $DIGEST, published $EXPECTED"
    mine=$(blob "$(blob "$DIGEST" | jq -r .config.digest)")
    diff <(jq -S '{config: .config, rootfs: .rootfs, created: .created}' <<< "$cfg") \
         <(jq -S '{config: .config, rootfs: .rootfs, created: .created}' <<< "$mine") >&2 || true
    exit 1
  fi
fi
