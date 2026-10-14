<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Reproducible builds

The container images (`ghcr.io/letsmanu/friendflix-{backend,gateway,web}`) are built so that building the same commit
again – on another machine, at another time, with an empty cache – gives **the same bytes**: the same image manifest
digest. Anyone can rebuild a release and check that the published image contains exactly what the source says, and
nothing an attacker slipped into the build machine. CI checks it for every pull request and every image it publishes
(job `reproducible` in [ci.yml](../.github/workflows/ci.yml)).

## Check a published image yourself

You need git, jq and Docker with buildx (Linux or macOS; on Apple silicon the amd64 build runs emulated and is slow).

```bash
git clone https://github.com/LetsManu/friendflix && cd friendflix
git checkout v1.4.0                       # the release (or commit) you want to check

IMG=ghcr.io/letsmanu/friendflix-backend:1.4.0       # gateway / web the same way; :latest, :<short sha> work too
scripts/reproduce-image.sh backend --ref v1.4.0 --compare "$IMG"
# reproduce-image: OK: rebuilt backend is identical to ghcr.io/letsmanu/friendflix-backend:1.4.0 (sha256:…)
```

What the script does (it is short – read it before you trust it):

1. Takes the build context from `git archive <ref>`: only committed files, every mtime = commit time, modes 644/755.
   Your local changes, untracked files, umask or `core.autocrlf` cannot leak in.
2. `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct <ref>)` – the commit time is the only "time" in the build.
3. Creates a fresh, throw-away BuildKit builder with the BuildKit image pinned in `ci.yml` (`BUILDKIT_IMAGE`; another
   BuildKit version may legitimately produce different bytes) and builds with `--no-cache --pull`,
   `--provenance=false --sbom=false` and `--output type=oci,…,oci-mediatypes=true,compression=gzip,rewrite-timestamp=true`.
4. With `--compare`, copies the image's labels and the build-arg ENVs (`GIT_SHA`, `BUILD_TIME`, `APP_VERSION`,
   `APP_CODENAME`) from the published image into the rebuild – they are metadata the release pipeline sets – and compares
   the rebuilt manifest digest with the published **linux/amd64 image manifest** digest. Anything else – every layer, the
   rest of the config, `created`, the history – must come out identical.

By hand, without the script, the core of it is:

```bash
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
docker buildx create --name repro --driver docker-container --driver-opt image=<BUILDKIT_IMAGE from ci.yml>
docker buildx build --builder repro --no-cache --pull --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u -d @$SOURCE_DATE_EPOCH +%Y-%m-%dT%H:%M:%SZ) \
  --build-arg APP_VERSION=$(jq -r .version version.json) --build-arg APP_CODENAME=$(jq -r .codename version.json) \
  --label org.opencontainers.image.created=… \
  -f backend/Dockerfile --output type=oci,dest=backend.tar,oci-mediatypes=true,compression=gzip,rewrite-timestamp=true .
tar -xOf backend.tar index.json | jq -r '.manifests[0].digest'
docker buildx imagetools inspect --raw "$IMG" | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
```
Pass every label of the published image as `--label` (`docker buildx imagetools inspect "$IMG" --format '{{json .Image}}' | jq .config.Labels`).
Build from a fresh clone (`git archive` in the script): files whose mtime is older than the commit are not clamped.

## What is compared, and what is not

| Part | Reproducible? | Why |
|---|---|---|
| Image manifest (linux/amd64): config + all layers | **yes – this is the digest that is compared** | see below |
| Image index digest (what `:tag` points to) | no | also lists the attestation manifests |
| BuildKit SBOM + SLSA provenance (in the index), cosign signature, GitHub attestations | no | contain build times, run IDs, signatures; separate manifests that *point to* the image manifest |
| Labels `org.opencontainers.image.*` | yes, with the release's values | `created` = commit time; `version`/`revision`/`source` come from docker/metadata-action and are copied by `--compare` |

## How the build is made deterministic

- **Timestamps:** `SOURCE_DATE_EPOCH` = commit time is passed to every build. BuildKit uses it for the config's `created`
  and history entries, and `rewrite-timestamp=true` clamps every file mtime in every layer to it. `BUILD_TIME` (shown in
  *Admin → Update*) and the `org.opencontainers.image.created` label are derived from it, not from the clock.
- **No cache for what is published:** `rewrite-timestamp` only clamps mtimes *newer* than `SOURCE_DATE_EPOCH`. A layer
  reused from an older commit's cache keeps that build's older mtimes, so the candidate that CI pushes is built with
  `no-cache` (it still exports its layers as cache for PR builds).
- **Pinned toolchain:** base image by digest (`node:26-alpine@sha256:…`, Dependabot), BuildKit by digest
  (`BUILDKIT_IMAGE` in ci.yml, bumped by hand), npm dependencies by `package-lock.json` (`npm ci`). Two clean `npm ci`
  runs produce byte-identical `node_modules` (mtimes are clamped).
- **App build output:** `tsc` (backend, gateway) is deterministic. The web app's SvelteKit `version.name` defaulted to
  `Date.now()` and ended up in `_app/version.json`, the service worker, the prerendered `/offline` page and the server
  chunks; it is now the git sha (else `SOURCE_DATE_EPOCH`) – [kit-version.ts](../web/src/lib/version/kit-version.ts).
  Two `vite build`s of the same commit are byte-identical.
- **Nothing build-time-dependent in the runtime stage:** only `dist`/`build` output, production `node_modules`,
  `package.json` and `version.json` are copied; npm caches stay in the build stages.

## Alpine packages: the one limit (ruling)

The runtime stages install Alpine packages from the network: `ffmpeg` (backend) and security fixes that are newer than
the base image. Alpine keeps **only the newest version** of each package on its mirrors (there is no snapshot archive),
so this decides how long a commit stays reproducible:

- **No blanket `apk upgrade`** (used before): it pulls whatever is newest *today*, so any Alpine update in between makes a
  rebuild differ.
- **No exact pins** (`zlib=1.3.2-r1`): the pinned version disappears from the mirrors with the next Alpine bump, and from
  then on the build – and every rebuild of an older tag – **fails**. A build that stays buildable was preferred.
- **Ruling:** packages come from the **digest-pinned base image** (Dependabot bumps it). A security fix the base image
  does not have yet is pulled in as a **minimum version** (`apk add 'zlib>=1.3.2-r1'`, CVE-2026-85091; the pinned base
  has 1.3.2-r0): no-op once the base image ships it, and then removed from the Dockerfile. `ffmpeg` is installed
  unpinned.
- **`/var/log/apk.log` is deleted in the same `RUN`:** apk 3 appends a timestamped line per install there, the only
  file `apk add` writes that differs between two runs (the package database and `scripts.tar.gz` are deterministic).
- **Consequence:** an image reproduces bit for bit as long as Alpine has not published a newer version of those packages
  (`zlib` while the base still lacks the fix; for the backend `ffmpeg` and its ~100 dependencies) since it was built. CI
  checks within minutes, so this always holds there; a rebuild weeks later may differ *only in that `apk` layer*. To check
  an older release anyway, compare layer by layer: every other layer (application code, `node_modules`, base image) must
  still be identical – `docker buildx imagetools inspect "$IMG" --format '{{json .Image}}' | jq .rootfs.diff_ids` against
  the rebuild (`--out image.tar`; `scripts/reproduce-image.sh --diff a.tar b.tar` lists the files of differing layers),
  and the package versions in the published image are in its SBOM.

## When the `reproducible` check fails

The failing job prints which layer differs and the file listing (mode, owner, size, mtime, name) of that layer in both
builds. Typical causes: a build step that writes the current time, a random value or a machine-specific path into a file
(look at `Date.now()`/`new Date()` in build tooling and config; log files such as `/var/log/apk.log`), a cache layer from another commit, or an Alpine package
published in the minutes between the two builds (re-run the job).
