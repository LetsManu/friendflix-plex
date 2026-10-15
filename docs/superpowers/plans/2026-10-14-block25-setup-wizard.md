# Block 25 – Setup Wizard and Settings Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new install runs with `docker compose up` and no `.env`: an init container generates the pre-DB secrets into a volume, a setup-code-protected wizard configures everything else, and all settings live (encrypted where secret) in the database, editable live in Admin → Settings, while existing env-configured installs keep working.

**Architecture:**
- A typed registry (`backend/src/settings/registry.ts`) classifies every config key; a pure resolver merges env > DB > default into the existing `Config` shape; a store keeps the live snapshot, writes rows with a revision counter and broadcasts the revision over Redis (30 s DB poll as fallback). `ctx.cfg` becomes a getter over the store, and the few startup-captured clients (OIDC, media, request service) rebuild on change.
- A dependency-free `bootstrap.js` in the backend image runs as an init container and fills two volumes (all pre-DB secrets; a gateway-only copy of `INTERNAL_SECRET`). The gateway pulls its upstream URL from the backend.
- 25b adds setup mode (a global gate + a hashed one-time code in `settings_meta`), the wizard endpoints, the media-module setup seam with Jellyfin auto-provisioning, and Authentik automation by importing blueprints through `POST /api/v3/managed/blueprints/import/`.

**Tech Stack:** Fastify + zod + pg + ioredis (backend), SvelteKit (web), Node gateway, Docker Compose, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-block25-setup-wizard-design.md` (Parts A–J, "Interface for Block 23 phase 3", "Unverified assumptions").

**Split:** 16 tasks, two PRs.
- **25a (Tasks 1–10):** settings store, live config, request service optional, bootstrap volume + compose, gateway pull, Admin → Settings, docs. Mergeable alone: existing installs gain Admin → Settings; new installs still need the wizard (25b) to get past an empty config, so 25a's docs keep the `.env` path as the documented install until 25b lands.
- **25b (Tasks 11–16):** setup mode and code, media seam + Jellyfin auto, Authentik automation, first admin, wizard UI, docs.

Prerequisite: Block 23 phase 2 is merged (`requireRecentAuth(ctx, maxAgeMs)` and the session `reauthAt` field exist). Block 23 phase 3 comes after 25b.

## Global Constraints

- Never give the Docker socket to any FriendFlix container.
- Secrets are never logged, never put into errors, never sent to the client. A secret setting is write-only in the UI ("set / replace / clear"). The single exception is `POST /api/admin/settings/generate {what:'webhookSecret'}`, which returns the new secret once with `cache-control: no-store`.
- One-time credentials (Authentik admin token, Jellyfin admin password) are used within the request only, never stored, never logged. Request bodies of `/api/setup/*` and `/api/admin/settings*` are excluded from error logs.
- Precedence: environment (`VAR`, `VAR_FILE`, legacy names) > DB > default. An empty env string counts as unset.
- The Redis broadcast carries only the revision number, never values.
- Audit entries for settings carry key names only (`{ keys: [...] }`), never values.
- Migrations are appended to `MIGRATIONS` in `backend/src/db.ts` only.
- 7 locales (`de, en, es, fr, it, pl, tr`); German is the source. New web areas `settings` and `setup` (`web/src/lib/i18n/locales/<lang>/settings.ts`, `setup.ts`, registered in each `index.ts`). Missing setting labels fall back to the key name.
- User-facing text never says "Seerr" ("request service" / "Wunsch-Dienst").
- No trademark look-alikes; README screenshots use fictional titles and generated art only.
- The Plex fork must keep compiling: new media-seam members are optional or additive.
- No new runtime dependencies. VAPID keys via `node:crypto` (as `scripts/gen-vapid.mjs`), multipart via the global `FormData`/`Blob`.
- Backend tests in `backend/test/*.test.ts` with `makeEnv`/`resetDb`; gateway tests in `gateway/test/`; e2e in `e2e/tests/`. Coverage thresholds hold; `npm run lint`, `npm run typecheck -w web`, `npm run spdx:check` clean; every new file carries the SPDX header.
- Setup code: Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 12 chars shown `XXXX-XXXX-XXXX`, TTL 24 h, 5 attempts / 15 min per IP, 10 global failures invalidate it.
- Bootstrap files: `/run/friendflix/{postgres_password,redis_password,redis.conf,app_enc_key,internal_secret}`, `/run/friendflix-gateway/internal_secret`; owner 0, group 10001, mode 0440, directory 0750.

## Review Focus

1. **DB restored without the bootstrap volume (new `APP_ENC_KEY`):** the backend starts, setup is *not* re-triggered (users exist), every secret row shows `invalid` ("stored value unreadable") and can be re-entered; nothing crashes. Test in Task 3 (`resolveConfig` with an undecryptable row) and Task 8 (GET shows `invalid: true, set: false`).
2. **A second backend instance misses the Redis message:** it converges by the 30 s poll. Test in Task 3 (`poll picks up a rev written by another store without a bus message`).
3. **Secret leakage through the settings API:** no GET, test or error response contains a secret value, also when the value comes from env or `_FILE`. Test in Task 8 (`GET never contains the secret value from env, file or db`, stringify-and-search).
4. **Setup code after completion or restart:** after `completeSetup` the old code and every setup session are dead (`unlock` → `409 setup_complete`); a backend restart during setup issues a new code but existing setup sessions stay valid until their TTL. Tests in Tasks 11 and 14.
5. **`PUBLIC_URL` typed with a path or trailing slash (`https://tv.example.com/` or `/friendflix`):** a trailing slash is normalised away, any path or query is rejected with `origin_only` (the redirect URI is built from the origin). Test in Task 1 (schema) and Task 11 (wizard save).

---

## Part 25a – Settings store (PR 1)

### Task 1: Settings registry and key classification

**Files:**
- Create: `backend/src/settings/registry.ts`
- Modify: `backend/src/config.ts` (env-only/bootstrap/build schema stays; setting part derived from the registry; required keys become optional, see below)
- Modify: `backend/src/media/index.ts` (add `mediaSettings()`)
- Test: `backend/test/settings-registry.test.ts`

**Interfaces (produces):**
- Types and constants exactly as spec Part B1: `SettingKind`, `SettingGroup`, `ProbeId`, `SettingDef`, `SETTINGS`, `ENV_ONLY_KEYS`, `BOOTSTRAP_KEYS`, `BUILD_KEYS`.
- `settingDef(key: string): SettingDef | undefined`
- `mediaSettings(): SettingDef[]` in `media/index.ts` (Jellyfin: `JELLYFIN_URL` url, `JELLYFIN_ADMIN_API_KEY` secret, both group `media`, `probe: 'media'`, `runRequired: (c) => c.MEDIA_SERVER === 'jellyfin'`).
- `parseEnvValue(def: SettingDef, raw: string): { ok: true; value: unknown } | { ok: false; code: string }` (env strings → typed; `bool` accepts `'true'|'false'`; `cidrList` accepts comma-separated, error code `invalid_cidr`).
- `publicUrlSchema`: origin only; trailing `/` stripped; path/query/hash → `origin_only`; non-http(s) → `invalid_url`.
- Classes and per-key data exactly as spec Part A (48 settings incl. the 2 media ones, 12 env-only, 4 bootstrap, 4 build) plus the 9 phase-3 keys with `visible: false` and the defaults from the spec's phase-3 table.
- `Config` keeps every field name and type; `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL`, `REQUESTS_URL`, `REQUESTS_API_KEY`, `WEBHOOK_SECRET` resolve to `''` when unset (type stays `string`). `loadConfig(env)` no longer throws for them.

- [ ] **Step 1: Write the failing tests**
  - `every key of the config schema is in exactly one of SETTINGS, ENV_ONLY_KEYS, BOOTSTRAP_KEYS, BUILD_KEYS` (68 keys; also: the 9 phase-3 keys are settings with `visible === false`)
  - `secrets: OIDC_CLIENT_SECRET, JELLYFIN_ADMIN_API_KEY, REQUESTS_API_KEY, DISCORD_WEBHOOK_URL, VAPID_PRIVATE_KEY, TMDB_API_KEY, OMDB_API_KEY, AUTHENTIK_API_TOKEN, GITHUB_TOKEN, PORTAINER_WEBHOOK_URL, PORTAINER_API_KEY, WEBHOOK_SECRET` (exact set); `hint === 'last4'` only for `TMDB_API_KEY`, `OMDB_API_KEY`
  - `apply === 'restart' exactly for DOWNLOAD_CREATE_PER_HOUR and API_COMPRESSION`
  - `REQUESTS_URL.legacyEnv equals ['SEERR_URL']`, `REQUESTS_API_KEY.legacyEnv equals ['SEERR_API_KEY']`
  - `publicUrlSchema`: `'https://tv.example.com/'` → `'https://tv.example.com'`; `'https://tv.example.com/ff'` → `origin_only`; `'ftp://x'` → `invalid_url`
  - `parseEnvValue(HOME_NETWORKS, '10.0.0.0/8, bad')` → `{ ok: false, code: 'invalid_cidr' }`
  - `loadConfig({ })` with only bootstrap env (`DATABASE_URL`, `REDIS_URL`, `APP_ENC_KEY`, `INTERNAL_SECRET`) succeeds; `OIDC_ISSUER === ''`, `SESSION_TTL_SECONDS === 28800`
  - existing `config` tests still pass unchanged (defaults, `_FILE`, renamed env, warn/crit fallback)
- [ ] **Step 2: Run `npx vitest run backend/test/settings-registry.test.ts` → FAIL (module missing).**
- [ ] **Step 3: Implement the registry and derive the setting part of the config schema from it.**
- [ ] **Step 4: Run the test file plus `npx vitest run backend/test/core.test.ts` → PASS.**
- [ ] **Step 5: Commit** `feat(settings): typed settings registry and key classification`.

### Task 2: Settings table, repository and data-source migration

**Files:**
- Modify: `backend/src/db.ts` (one migration, SQL as spec Part B2)
- Create: `backend/src/settings/repo.ts`
- Modify: `backend/src/sources/keys.ts` (read/write through the repo; keep exported names and `SourceStatus` shape; `from: 'db' | 'file'` keeps its meaning: `'file'` = env layer)
- Test: `backend/test/settings-repo.test.ts`, extend `backend/test/block23-migration.test.ts` pattern in a new `backend/test/block25-migration.test.ts`

**Interfaces (produces):**
- `interface StoredRow { key: string; value: unknown | null; enc: string | null; last4: string | null; updatedAt: string; updatedBy: string | null }`
- `readRows(db: Db): Promise<{ rev: number; rows: StoredRow[] }>`
- `writeRows(db: Db, encKey: Buffer, changes: Record<string, unknown | null>, actor: string | null): Promise<number>` – one transaction; secrets → `encrypt(encKey, String(v))`, `last4` only for `hint: 'last4'`; `null` deletes; bumps and returns `settings_meta.rev`.
- `readRev(db: Db): Promise<number>`
- `readMeta(db) / updateMeta(db, patch)` for the setup columns (used in Task 11).

- [ ] **Step 1: Write the failing tests**
  - migration on a DB with a user and `app_settings` rows `source.tmdb {enc,last4:'abcd'}`, `digest {...}` → `settings` has `TMDB_API_KEY` with the same `enc` and `last4 'abcd'`, `app_settings` keeps `digest`, `settings_meta.setup_completed_at` not null
  - migration on an empty DB → `setup_completed_at` null, `rev` 0
  - `writeRows({ JELLYFIN_URL: 'http://jf:8096', JELLYFIN_ADMIN_API_KEY: 'k'.repeat(32) })` → rev 1; the key row has `value null`, `enc` set and decrypts to `'k'.repeat(32)`; `last4` null
  - `writeRows({ JELLYFIN_URL: null })` → row gone, rev 2
  - the check constraint rejects a row with both `value` and `enc`
  - `sourceStatus` / `getSourceKey` / `setSourceKey` tests in the existing sources test file pass unchanged
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the migration, the repo and the keys.ts switch.**
- [ ] **Step 4: Run the new tests and `npx vitest run backend/test/sources*.test.ts` → PASS.**
- [ ] **Step 5: Commit** `feat(settings): settings table with encrypted secrets and revision counter`.

### Task 3: Resolver, live store and Redis broadcast

**Files:**
- Create: `backend/src/settings/resolve.ts`, `backend/src/settings/store.ts`, `backend/src/settings/bus.ts`
- Test: `backend/test/settings-store.test.ts`

**Interfaces:**
- Consumes: Task 1 registry, Task 2 repo.
- Produces:
  - `type Source = 'env' | 'db' | 'bootstrap' | 'default' | 'unset'`
  - `resolveConfig(input: { env: NodeJS.ProcessEnv; rows: StoredRow[]; encKey: Buffer; bootstrap?: Partial<Record<string, string>> }): { cfg: Config; sources: Record<string, Source>; invalid: string[] }`
  - `SettingsStore` and `SettingsBus` exactly as spec Part B4.
  - `createSettingsStore(deps: { db: Db; encKey: Buffer; env: NodeJS.ProcessEnv; bus: SettingsBus; log: { warn(o: object, m: string): void }; bootstrap?: Partial<Record<string, string>>; pollMs?: number }): Promise<SettingsStore>` (default `pollMs` 30 000).
  - `class RedisSettingsBus implements SettingsBus { constructor(redis: Redis) }` (uses `redis.duplicate()`, channel `ff:settings:rev`).
  - `class MemorySettingsBus implements SettingsBus` (tests; one instance shared by several stores).

- [ ] **Step 1: Write the failing tests**
  - precedence: env `JELLYFIN_URL=http://env:8096` + row `http://db:8096` → `cfg.JELLYFIN_URL === 'http://env:8096'`, source `env`; env `''` → `db`; no row → `default` / `unset`
  - `JELLYFIN_ADMIN_API_KEY_FILE` pointing to a temp file → source `env`
  - legacy: env `SEERR_URL=http://seerr:5055` → `REQUESTS_URL` source `env`
  - a row encrypted with another key → ignored, `invalid` contains the key, `log.warn` called with `{ key }` and no value
  - a row failing its schema (`SESSION_TTL_SECONDS: -5`) → default used, `invalid` contains it
  - `HEALTH_DISK_WARN_PCT 95 / CRIT 90` from DB → 85 / 95 (existing rule)
  - store A `save({ CAST_ENABLED: false })` → store B (same `MemorySettingsBus`) reloads, `B.current().CAST_ENABLED === 'false'`, `B.rev() === 1`
  - `poll picks up a rev written by another store without a bus message` (bus that drops messages, `pollMs: 20`) (Review Focus 2)
  - `onChange(['JELLYFIN_URL'], fn)`: fires once with `changed = ['JELLYFIN_URL']` after saving it; does not fire after saving `CAST_ENABLED`
  - `pendingRestart()` is `['API_COMPRESSION']` after saving `API_COMPRESSION: false`, `[]` after saving it back to the boot value
  - `importEnv(['TMDB_API_KEY'])` with env `TMDB_API_KEY=abcd1234…` → row written encrypted, source still `env`, returns `['TMDB_API_KEY']`; `importEnv('all')` skips keys not set in env
  - `save` of an env-locked key → throws `HttpError(400)` with `{ KEY: 'locked' }`
  - the bus message payload is the rev as a string and nothing else
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement resolver, store and buses.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(settings): live settings store with env precedence and Redis broadcast`.

### Task 4: Live config in the context

**Files:**
- Modify: `backend/src/ctx.ts`, `backend/src/server.ts`, `backend/src/oidc.ts`, `backend/src/media/index.ts`, `backend/src/push.ts`, `backend/test/helpers.ts`
- Test: `backend/test/settings-live.test.ts`

**Interfaces:**
- Consumes: `createSettingsStore`, `RedisSettingsBus` (Task 3).
- Produces:
  - `Ctx` gains `settings: SettingsStore`; `cfg` stays `Config` but is provided by a getter `get cfg() { return settings.current() }` (object built in `server.ts` and in `makeEnv`).
  - `createLazyOidc(getCfg: () => Config): OidcProvider & { reset(): void }` in `oidc.ts`: discovery on first `start()`/`finish()`, cached; failure → `HttpError(503, 'oidc_unavailable')`, next attempt after 30 s; `reset()` on `PUBLIC_URL` / `OIDC_*` / `OIDC_ALLOW_INSECURE` change.
  - `ctx.jf` and `ctx.seerr` are getters over holders rebuilt by `settings.onChange` (media keys from `mediaSettings()`; `REQUESTS_URL`, `REQUESTS_API_KEY`). The old media instance gets `stop()`, the new one `start()`.
  - Timers for `PREVIEW_WARM` and `DOWNLOADS_ENABLED` are always registered (under `BACKGROUND_JOBS`) and return early when the flag is `'false'`.
  - `makeEnv` builds a store from the test config (`MemorySettingsBus`); existing tests stay green.

- [ ] **Step 1: Write the failing tests**
  - `saving JELLYFIN_URL swaps ctx.jf: the next admin ping goes to the new URL` (fake HTTP records the host)
  - `ctx.cfg reflects a saved SESSION_IDLE_SECONDS on the next request without restart`
  - `oidc discovery failure → /auth/login answers 503 oidc_unavailable and the backend stays up; after saving a reachable issuer the next login starts`
  - `PREVIEW_WARM=false → warm tick does nothing; after saving true → the next tick warms`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new test and the full backend suite `npm test -w backend` → PASS.**
- [ ] **Step 5: Commit** `feat(settings): config readers use the live settings snapshot`.

### Task 5: Request service optional

**Files:**
- Modify: `backend/src/seerr/client.ts` (export `requestsEnabled(ctx): boolean`), `backend/src/ctx.ts` (`seerr: SeerrClient | null`), the 8 files using `ctx.seerr` (`grep -rln "ctx.seerr" backend/src`), `backend/src/routes/auth.ts` (`/api/me` `features.requests`), web: the requests nav/routes that read `/api/me`
- Test: `backend/test/requests-optional.test.ts`, extend an existing e2e mock with `features.requests: false`

**Interfaces:**
- Produces: `requestsEnabled(ctx: Pick<Ctx, 'seerr'>): boolean`; `/api/me` → `features: { requests: boolean }` (added, nothing removed); request routes → `404 { error: 'requests_disabled' }`; `resolveRequestedPolls` and request-related ticks skip when disabled.

- [ ] **Step 1: Write the failing tests**
  - `no REQUESTS_URL → GET /api/requests 404 requests_disabled` (and one write route)
  - `/api/me features.requests false; true with URL and key`
  - `resolveRequestedPolls with requests disabled makes no HTTP call`
  - e2e: `requests nav entry hidden when features.requests is false`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS; `grep -ri seerr web/src/lib/i18n/locales` shows no new hits.**
- [ ] **Step 5: Commit** `feat(requests): the request service is optional`.

### Task 6: Bootstrap init container, volume readers and compose

**Files:**
- Create: `backend/src/bootstrap.ts` (entry, dependency-free), `backend/src/settings/bootstrapFiles.ts` (reader), `scripts/backup-bootstrap.sh`
- Modify: `backend/src/server.ts` (bootstrap layer into the store and into `DATABASE_URL`/`REDIS_URL`/`APP_ENC_KEY`/`INTERNAL_SECRET`), `gateway/src/server.ts` (`INTERNAL_SECRET` fallback file), `compose.yaml`, `compose.prod.yaml`, `compose.secrets.yaml`, `compose.planb.yaml`, `compose.monitoring.yaml`, `.github/workflows/*` (the compose check job)
- Test: `backend/test/bootstrap.test.ts`, `gateway/test/server-secret.test.ts`

**Interfaces:**
- Produces:
  - `runBootstrap(opts: { dir: string; gatewayDir: string; env: NodeJS.ProcessEnv; gid: number; chown: (path: string, uid: number, gid: number) => void; log: (line: string) => void }): void` (exported for tests; `bootstrap.ts` calls it with `/run/friendflix`, `/run/friendflix-gateway`, `process.env`, 10001, `fs.chownSync`, `console.log`).
  - `readBootstrap(dir = '/run/friendflix'): { postgresPassword?: string; redisPassword?: string; appEncKey?: string; internalSecret?: string }`
  - `bootstrapEnv(env, files): { DATABASE_URL: string; REDIS_URL: string; APP_ENC_KEY: string; INTERNAL_SECRET: string }` – env wins; defaults per spec Part A; missing → throws `bootstrap file /run/friendflix/<name> missing: start the stack with docker compose up (the bootstrap service creates it)`.
  - Compose per spec Parts C1–C4: `bootstrap` service, volumes `bootstrap` and `bootstrap-gateway`, `depends_on … service_completed_successfully`, `group_add: ["10001"]`, redis on `redis.conf` as `user: "999:999"`, postgres on `POSTGRES_PASSWORD_FILE`, backup `PGPASSWORD_FILE` default, web `ORIGIN: ${PUBLIC_URL:-}` + `PROTOCOL_HEADER: x-forwarded-proto`, no `:?`, no injected defaults for setting keys, pass-through `${KEY:-}` lines kept.

- [ ] **Step 1: Write the failing tests**
  - empty dir, empty env → five files created; `app_enc_key` decodes (base64) to 32 bytes; the three hex secrets match `/^[0-9a-f]{64}$/`; `redis.conf` is `requirepass <redis_password>\n`; `chown` called with gid 10001 for each; modes `0o440`; gateway dir has only `internal_secret` equal to the main one
  - second run with the same dir → identical contents, log says `kept` for each
  - env `POSTGRES_PASSWORD=legacy-pw` → `postgres_password` is `legacy-pw`, log `postgres_password: from environment`; env removed on the next run → still `legacy-pw`
  - log lines never contain any generated or env value (search all values in the joined log)
  - `bootstrapEnv({}, { postgresPassword: 'p', redisPassword: 'r', appEncKey: K, internalSecret: S })` → `DATABASE_URL === 'postgres://friendflix:p@postgres:5432/friendflix'`, `REDIS_URL === 'redis://:r@redis:6379'`; env `DATABASE_URL` wins
  - missing `app_enc_key` → throws with the exact message above
  - gateway: no `INTERNAL_SECRET` env, file `/tmp/…/internal_secret` via `FF_GATEWAY_BOOTSTRAP_DIR` override → used
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement, change all compose files, add CI step:** `docker compose -f compose.yaml config -q` and `docker compose -f compose.prod.yaml config -q`, once with no `.env` and once with `cp .env.example .env`; both exit 0.
- [ ] **Step 4: Run the tests → PASS. Verify U5 (empty `ORIGIN`) by starting the built web image with `ORIGIN=` and requesting `/` with `x-forwarded-proto: https` – if adapter-node rejects it, drop the `ORIGIN` line instead and note it in the commit. Verify U6 with `docker compose up redis` (healthcheck turns healthy).**
- [ ] **Step 5: Commit** `feat(deploy): bootstrap volume with generated secrets, no required .env`.

### Task 7: Gateway pulls its upstream from the backend

**Files:**
- Modify: `backend/src/routes/internal.ts` (`GET /internal/gateway-config`; `x-ff-config-rev` header on `/internal/authz*` answers), `gateway/src/server.ts`, `gateway/src/gateway.ts` (`upstreamUrl` becomes a getter; 503 without one)
- Create: `gateway/src/remoteConfig.ts`
- Test: `backend/test/gateway-config.test.ts`, `gateway/test/remote-config.test.ts`

**Interfaces:**
- Produces:
  - Backend: `GET /internal/gateway-config` (`x-internal-secret`) → `200 { rev: number, upstreamUrl: string }` or `503 { error: 'setup_required' }` when the media URL key is empty; wrong secret → 403.
  - Gateway: `createRemoteConfig(opts: { backendUrl: string; internalSecret: string; envUrl?: string; fetchImpl?: typeof fetch; refreshMs?: number /* 30000 */; retryMs?: number /* 5000 */ }): { url(): string | null; noteRev(rev: string | null): void; stop(): void }`.
  - `createGateway` option `upstreamUrl` accepts `string | (() => string | null)`.
  - `mediaUrlKey(cfg: Config): string` in `backend/src/media/index.ts` (`'JELLYFIN_URL'` for `jellyfin`); Task 12 re-implements it over `MEDIA_SETUP[kind].urlKey`.

- [ ] **Step 1: Write the failing tests**
  - backend: `gateway-config returns the live JELLYFIN_URL and the rev; after saving a new URL it returns the new one`; `503 setup_required with an empty URL`; `403 without the secret`; `authz answers carry x-ff-config-rev`
  - gateway: `envUrl set → never fetches`; `first fetch 503 → retries after retryMs, then url() returns the value`; `noteRev('7') with cached rev 6 → refetches immediately`; `url() null → /media/x answers 503, /health 200`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test -w gateway` and the backend test → PASS.**
- [ ] **Step 5: Commit** `feat(gateway): upstream URL from the live settings`.

### Task 8: Admin settings API and probes

**Files:**
- Create: `backend/src/settings/probes.ts`, `backend/src/routes/adminSettings.ts` (registered in `app.ts`)
- Modify: `backend/src/app.ts` (error-log body exclusion for `/api/admin/settings`)
- Test: `backend/test/admin-settings.test.ts`, `backend/test/settings-probes.test.ts`

**Interfaces:**
- Consumes: `SettingsStore` (Task 3), `requireAdmin`, phase 2 `requireRecentAuth(ctx, 600_000)`.
- Produces:
  - `type ProbeResult` as spec Part I.
  - `runProbe(ctx: Ctx, id: ProbeId, cfg: Config, opts?: { timeoutMs?: number /* 5000 */ }): Promise<ProbeResult>`:
    - `media` → `MEDIA_SETUP[kind].probe` (Task 12) or, until then, `GET <JELLYFIN_URL>/Auth/Keys` with the key: 200 ok, 401/403 `not_admin`
    - `oidc` → discovery; `issuer !== OIDC_ISSUER` → `issuer_mismatch`
    - `authentik` → `GET <AUTHENTIK_URL>/api/v3/core/users/me/` with the token (401 → `unauthorized`), then `GET …/flows/instances/<AUTHENTIK_ENROLL_FLOW>/` when set (404 → `invalid`)
    - `requests` → the existing request-service status call; `tmdb`/`omdb` → the existing source test functions; `portainer`, `github` → their existing checks
    - `publicUrl` → Task 11 (returns `{ ok: true, code: 'ok' }` until then)
  - `settingsView(ctx): Promise<{ rev: number; pendingRestart: string[]; groups: Array<{ id: SettingGroup | 'server'; items: SettingView[] }> }>` (`SettingView` as spec Part I; hidden keys omitted).
  - Routes exactly as spec Part I: `GET /api/admin/settings`, `PUT /api/admin/settings`, `POST /api/admin/settings/test`, `POST /api/admin/settings/import-env`, `POST /api/admin/settings/generate`.
  - `saveWithProbes(ctx, values, opts: { force: boolean; actor: string | null; allowedKeys?: readonly string[] }): Promise<{ rev: number } | { errors: Record<string, string> } | { probe: ProbeResult; group: SettingGroup }>` (shared with Task 11).
  - `generateVapidPair(): { publicKey: string; privateKey: string }`, `generateWebhookSecret(): string` (32 random bytes hex).

- [ ] **Step 1: Write the failing tests**
  - `GET never contains the secret value from env, file or db` (set `OIDC_CLIENT_SECRET` via env, `JELLYFIN_ADMIN_API_KEY` via `_FILE`, `TMDB_API_KEY` via db; `JSON.stringify(body)` contains none of the three values; `TMDB_API_KEY.last4` is its last 4) (Review Focus 3)
  - `undecryptable db secret → invalid: true, set: false` (Review Focus 1)
  - `PUT env-locked key → 400 { errors: { KEY: 'locked' } }`; `PUT METRICS_TOKEN → unknown`; `PUT OIDC_CLIENT_SECRET: null → required`
  - `PUT JELLYFIN_URL with a probe answering 401 → 400 probe not_admin, nothing saved`; `probe timeout without force → 400 timeout; with force → saved`
  - `PUT a secret without recent re-auth → 403 reauth_required; within 10 min → 200`
  - `PUT writes audit settings.update with meta { keys: ['CAST_ENABLED'] } only`
  - `import-env all → moved lists exactly the env-set setting keys; audit settings.import_env`
  - `generate webhookSecret → 64 hex chars, cache-control no-store, saved as WEBHOOK_SECRET; a later GET shows set without the value`
  - `generate vapidPair → publicKey returned, VAPID_PRIVATE_KEY saved and never returned; push validates the pair`
  - `non-admin → 403` on all five routes
  - probes: `oidc issuer mismatch`, `authentik 401 → unauthorized`, `media 403 → not_admin`, unreachable host → `unreachable` (fake fetch throwing)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(admin): settings API with validation, probes and env import`.

### Task 9: Admin → Settings page

**Files:**
- Create: `web/src/routes/admin/settings/+page.svelte`, `web/src/lib/admin/settings/SettingRow.svelte`, `web/src/lib/admin/settings/api.ts`, `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/settings.ts`
- Modify: `web/src/routes/admin/+layout.svelte` (nav entry "Einstellungen"/"Settings"), each locale `index.ts`
- Test: `e2e/tests/admin-settings.spec.ts`, `e2e/tests/admin-settings.mobile.spec.ts`, mocks in `e2e/mocks/settings.ts`

**Interfaces:**
- Consumes: Task 8 routes and `SettingView`.
- Produces: `loadSettings()`, `saveSettings(values, force?)`, `testGroup(group, values?)`, `importEnv(keys | 'all')`, `generate(what)` in `api.ts`. Strings: `settings.groups.<id>`, `settings.keys.<KEY>.label|help`, `settings.source.env|db|default`, `settings.probe.<code>`, `settings.restartBanner`, `settings.moveHint` (with `{keys}`), `settings.secret.set|unset|replace|clear`, `settings.invalid`.

Behaviour per spec Part I: groups as sections; env rows locked with "Move into settings"; "Move all" at the top; secrets write-only; restart banner with `docker compose restart backend`; "Test" per group; a probe `unreachable`/`timeout` error offers "Save anyway" (`force`); a `403 reauth_required` starts phase 2's re-auth and retries.

- [ ] **Step 1: Write the failing e2e tests**
  - `env row is locked and shows "from environment"; Move into settings shows the hint naming KEY and KEY_FILE`
  - `secret row shows set/unset, Replace sends the value, Clear sends null, the page never renders a secret value`
  - `saving API_COMPRESSION shows the restart banner`
  - `probe unreachable → Save anyway saves with force: true`
  - mobile: all controls reachable, a11y names on Replace/Clear/Move buttons
- [ ] **Step 2: Run `npx playwright test e2e/tests/admin-settings*` → FAIL.**
- [ ] **Step 3: Implement; strings in all 7 locales (labels for all 48 visible settings).**
- [ ] **Step 4: Run e2e, `npm run typecheck -w web`, `npm run coverage -w web` → PASS.**
- [ ] **Step 5: Commit** `feat(web): Admin → Settings`.

### Task 10: Docs for 25a

**Files:**
- Modify: `docs/setup.md` + `docs/de/setup.md` (settings in the database; precedence; "Upgrading to settings in the database" per spec Part J), `docs/operations.md` (backup = DB + `bootstrap` volume, `scripts/backup-bootstrap.sh`, restore without the volume), `docs/security.md` (bootstrap volume permissions, gateway-only volume, write-only secrets, rev-only broadcast), `docs/architecture.md` (settings store, gateway pull), `docs/integrations.md` (webhook secret via Admin → Settings → Generate), `.env.example` (header: "Optional. A new install needs no .env"; keys kept as overrides), `CHANGELOG.md` (Unreleased → Settings)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run `npm run lint`, `npm run spdx:check`, `npm run coverage -w backend`, `npm run coverage -w web`, `npm run build -w web`, `npm test -w gateway`, the compose CI check from Task 6 → all pass.**
- [ ] **Step 3: Commit** `docs: Block 25a settings store`.

---

## Part 25b – Setup wizard (PR 2)

### Task 11: Setup mode, setup code and setup session

**Files:**
- Create: `backend/src/setup/state.ts`, `backend/src/setup/code.ts`, `backend/src/routes/setup.ts`
- Modify: `backend/src/app.ts` (global gate hook; body exclusion for `/api/setup/*`), `backend/src/server.ts` (issue the code at start when `BACKGROUND_JOBS=true` and setup incomplete; jobs check `isOperational`), `backend/src/settings/probes.ts` (`publicUrl` probe)
- Test: `backend/test/setup-code.test.ts`, `backend/test/setup-gate.test.ts`

**Interfaces:**
- Consumes: `readMeta`/`updateMeta` (Task 2), `saveWithProbes` (Task 8).
- Produces:
  - `isSetupComplete(ctx): Promise<boolean>` (cached in memory, invalidated by the settings rev) and `isOperational(ctx): boolean` (setup complete and run-required keys set).
  - `newSetupCode(): { display: string; hash: string }` (`display` `XXXX-XXXX-XXXX`), `normalizeCode(input: string): string`, `issueSetupCode(ctx, now = new Date()): Promise<string>` (writes hash, `expires = now + 24 h`, failures 0; returns the display for the log).
  - `verifySetupCode(ctx, input: string, ip: string): Promise<'ok' | 'wrong' | 'expired' | 'locked' | 'complete'>` (10th global failure clears the hash).
  - `createSetupSession(ctx, reply): Promise<void>` / `requireSetupSession(ctx)` preHandler (cookie `ff_setup` + header `x-ff-setup-csrf` = cookie `ff_setup_csrf`); kv `setup:sess:<sha256>`, TTL 7200 s, sliding.
  - Routes per spec Parts F and E: `GET /api/setup/state`, `POST /api/setup/unlock` (rate limit 5 / 15 min / IP), `GET /api/setup/echo/:nonce`, `PUT /api/setup/settings`, `POST /api/setup/test`.
  - Gate: while incomplete, 503 `setup_required` except `/health`, `/api/setup/*`, `/internal/gateway-config`, and `/auth/login` + `/auth/callback` with a valid setup session.
  - Log line exactly: `FriendFlix setup: open the portal in your browser and enter the setup code <CODE> (valid until <YYYY-MM-DD HH:mm> UTC). Restart the backend for a new code.`

- [ ] **Step 1: Write the failing tests**
  - `newSetupCode display matches /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/`
  - `normalizeCode(' k7qm-3xa9 pt2o ') === 'K7QM3XA9PT20'`; `'IL'` → `'11'`
  - `unlock with the right code → 200, ff_setup httpOnly sameSite strict, ff_setup_csrf readable`; `wrong → 401 wrong_code`; `after 24 h + 1 s → 410 code_expired`
  - `6th attempt from one IP within 15 min → 429`; `10 wrong codes from 10 IPs → code invalidated, the right code then → 410 code_locked`
  - `issueSetupCode twice → only the second code works; a session created with the first stays valid` (Review Focus 4)
  - gate: `/api/me 503 setup_required`; `/health 200`; `/api/setup/state 200`; `/auth/login without setup session 503`; `/internal/gateway-config` reachable; with setup complete the gate is inert
  - `PUT /api/setup/settings without x-ff-setup-csrf → 403`; `with PUBLIC_URL 'https://tv.example.com/'` → saved as `https://tv.example.com`; `'https://tv.example.com/ff'` → `400 { errors: { PUBLIC_URL: 'origin_only' } }` (Review Focus 5); `CAST_ENABLED` → `400 not_allowed`
  - `publicUrl probe: echo answers the nonce → ok; another body → code warning, save still succeeds`
  - `state.prefill.publicUrl === 'https://tv.example.com'` for `x-forwarded-proto: https`, `host: tv.example.com`
  - the log line contains the code and the expiry; no other log line contains it
  - jobs: `pollTick with setup incomplete makes no media call`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(setup): setup mode with a one-time code from the log`.

### Task 12: Media setup seam and Jellyfin auto-provisioning

**Files:**
- Create: `backend/src/media/setup.ts`, `backend/src/jellyfin/setup.ts`
- Modify: `backend/src/routes/setup.ts` (`POST /api/setup/media/auto`; `state.media`), `backend/src/settings/probes.ts` (`media` via the provider), `docs/architecture.md` ("Media server seam": the setup provider)
- Test: `backend/test/media-setup-seam.test.ts`, `backend/test/jellyfin-setup.test.ts`

**Interfaces:**
- Produces: `MediaSetupProvider`, `MEDIA_SETUP` exactly as spec Part H; `jellyfinSetup: MediaSetupProvider` with `keys ['JELLYFIN_URL','JELLYFIN_ADMIN_API_KEY']`, `urlKey 'JELLYFIN_URL'`, `auto.fields ['url','username','password']`; `mediaUrlKey(cfg)` (Task 7) now returns `MEDIA_SETUP[cfg.MEDIA_SERVER]?.urlKey`, falling back to the first `url` entry of `mediaSettings()`.
- Jellyfin calls exactly as spec Part G "Jellyfin automation" (header `MediaBrowser Client="FriendFlix", Device="Setup", DeviceId="ff-setup-<16 hex>", Version="<APP_VERSION or dev>"`).
- Error codes: `wizard_pending`, `unauthorized` (401 on AuthenticateByName), `not_admin`, `unreachable`, `unexpected` (no new key found).

- [ ] **Step 1: Write the failing tests**
  - `StartupWizardCompleted false → wizard_pending, no login attempt`
  - `IsAdministrator false → not_admin, logout called, no key created`
  - `happy path: POST /Auth/Keys?app=FriendFlix, then the newest FriendFlix key by DateCreated (an older FriendFlix key and a newer 'Other' key exist) is saved; logout called with the session token`
  - `the password never appears in any log call or error message` (spy on the logger)
  - `POST /api/setup/media/auto saves JELLYFIN_URL and an encrypted JELLYFIN_ADMIN_API_KEY and returns { ok: true }`
  - seam: `a kind without MEDIA_SETUP entry → state.media has keys from mediaSettings() and auto null`; type test: an object literal with only `kind`, `keys`, `urlKey`, `probe` satisfies `MediaSetupProvider`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(setup): media setup seam and automatic Jellyfin API key`.

### Task 13: Authentik automation

**Files:**
- Create: `backend/src/setup/authentikSetup.ts`, `deploy/authentik/friendflix-setup.yaml`
- Modify: `backend/src/routes/setup.ts` (`/api/setup/authentik/plan`, `/apply`), `backend/Dockerfile` (copy `deploy/authentik/*.yaml` to `/app/deploy/authentik/`)
- Test: `backend/test/authentik-setup.test.ts` (fake Authentik), `backend/test/fixtures/authentik-setup/*.json` (fictional `auth.example.com` data only)

**Interfaces:**
- Produces:
  - `AkStepId`, `AkStep` as spec Part G; `AK_EXTRA_BLUEPRINTS: Array<{ id: string; file: string; context?: (cfg: Config) => Record<string, string> }>` (empty).
  - `planAuthentik(input: { url: string; token: string }, deps: { fetchImpl: typeof fetch }): Promise<AkStep[]>`
  - `applyAuthentik(input: { url: string; token: string; addMeToAdmins: boolean; publicUrl: string; adminGroup: string }, deps: { fetchImpl: typeof fetch; blueprintDir: string }): Promise<{ steps: AkStep[]; values?: Record<string, string> }>` – `values` = the eight keys from spec Part G, only when every step succeeded; the route saves them through `saveWithProbes` (probes `oidc`, `authentik`).
  - `importBlueprint(url, token, src: { file: string; context: Record<string, string> } | { path: string }, deps): Promise<void>` – multipart `file` (Blob, `application/x-yaml`) + `context` (JSON string) to `/api/v3/managed/blueprints/import/`; `success: false` → `blueprint_invalid`.
  - `friendflix-setup.yaml` exactly as spec Part G step 2 (context keys `public_url`, `admin_group`), SPDX header, import note like the other blueprints.

- [ ] **Step 1: Write the failing tests**
  - `is_superuser false → steps [check failed not_superuser], no further call`
  - `version_current '2024.2.1' → unsupported_version`
  - `plan on an empty Authentik → groups create, provider create, serviceAccount create, enrollment create, recovery create, brand create; plan makes only GET requests`
  - `apply posts three blueprint files then the recovery path import; the friendflix-setup import has context {"public_url":"https://tv.example.com","admin_group":"friendflix-admins"}`
  - `recovery flow exists → recovery exists, no import; brand with flow_recovery set → brand exists, no PATCH`
  - `readback: values.OIDC_ISSUER === 'https://auth.example.com/application/o/friendflix/', OIDC_CLIENT_ID/SECRET from the provider list, AUTHENTIK_API_TOKEN === the view_key result (not the admin token)`
  - `discovery issuer mismatch → readback failed issuer_mismatch, values undefined`
  - `addMeToAdmins → POST core/groups/<pk>/add_user/ {pk: me.user.pk}`
  - `import 2 answers success false → that step failed blueprint_invalid, later steps absent`
  - `the admin token is not in any saved setting, kv key, log call or response body` (search everything)
  - `friendflix-setup.yaml parses as YAML (custom tags as plain scalars) and contains grant_types [authorization_code], the strict redirect !Format, the implicit-consent !Find`
  - route: `apply saves the eight keys and returns the steps`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS. Then verify U1–U4 once against a local `ghcr.io/goauthentik/server:2026.8.3` (fresh install, akadmin token): apply succeeds, the provider has `grant_types ['authorization_code']`, a login through the provider with PKCE works; record the outcome in the spec's "Unverified assumptions" (move verified items to "Verified").**
- [ ] **Step 5: Commit** `feat(setup): automatic Authentik provider, groups, service account and flows`.

### Task 14: First admin and setup completion

**Files:**
- Modify: `backend/src/routes/auth.ts` (`/auth/login?setup=1`; callback / `finishLogin` branch), `backend/src/setup/state.ts` (`completeSetup`)
- Test: `backend/test/setup-first-admin.test.ts`

**Interfaces:**
- Produces: `completeSetup(ctx, userId: string, session: { reauthAt?: number }): Promise<void>` – sets `setup_completed_at`, clears the code hash, deletes all `setup:sess:*`, audit `setup.completed` (actor `userId`), stamps `reauthAt = Date.now()`, logs `Setup completed; the setup code is no longer valid.`
- The OIDC state saved at `/auth/login?setup=1` carries `setup: true`; the callback honours it only with a valid setup session at callback time.

- [ ] **Step 1: Write the failing tests**
  - `callback with setup session, claims without ADMIN_GROUP and without invite → user role admin, Jellyfin user created, setup complete, redirect /setup/extras`
  - `after completion: unlock with the old code → 409 setup_complete; the old ff_setup cookie → 401 on /api/setup/settings; /api/me works` (Review Focus 4)
  - `callback without setup session during setup → 503 setup_required, no user row`
  - `a second /auth/login?setup=1 after completion behaves like a normal login (group/invite/approval rules)`
  - `the new admin can PUT a secret in /api/admin/settings without re-auth within 10 min`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(setup): the first sign-in becomes admin and completes setup`.

### Task 15: Wizard UI

**Files:**
- Create: `web/src/routes/setup/+page.svelte` (steps 1–5), `web/src/routes/setup/extras/+page.svelte` (step 6), `web/src/lib/setup/{api.ts,StepCode.svelte,StepPublicUrl.svelte,StepMedia.svelte,StepSignin.svelte,StepAdmin.svelte,AkSteps.svelte}`, `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/setup.ts`
- Modify: `web/src/routes/+layout.ts` (503 `setup_required` from `/api/me` → `goto('/setup')`), each locale `index.ts`
- Test: `e2e/tests/setup.spec.ts`, `e2e/tests/setup.mobile.spec.ts`, mocks `e2e/mocks/setup.ts`

**Interfaces:**
- Consumes: Tasks 11–14 routes; Task 8 admin routes for step 6; `generate('vapidPair' | 'webhookSecret')`.
- Produces: `setupState()`, `unlock(code)`, `saveSetup(values, force?)`, `testSetup(group, values?)`, `mediaAuto(input)`, `akPlan(input)`, `akApply(input)` in `web/src/lib/setup/api.ts` (all send `x-ff-setup-csrf` from the cookie).
- Copy rules: the media step renders fields from `state.media` (labels `settings.keys.<KEY>.label`, fallback the key); Authentik shows the plan list (one line per `AkStep` with its state) before "Apply", then the results, then the manual leftovers (SMTP, MFA, `/templates`); the webhook secret card shows the secret once with copy buttons and the header lines `X-Webhook-Secret: <secret>`; "request service", never "Seerr".

- [ ] **Step 1: Write the failing e2e tests**
  - `unauthenticated / redirects to /setup; wrong code shows the error; right code shows step 2 prefilled`
  - `auto path: media auto → step 4 plan list → apply → results → step 5 sign-in button links /auth/login?setup=1`
  - `manual path: Jellyfin URL + key with a failing probe shows not_admin; OIDC manual fields with the checklist (redirect URI shows https://tv.example.com/auth/callback)`
  - `env-locked step shows "from environment" and a Next button`
  - `extras: Skip on every card reaches /; Generate push keys shows "set", never a private key; webhook secret shown once`
  - mobile: every step usable at 390 px; a11y names on inputs and step buttons
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement; strings in all 7 locales.**
- [ ] **Step 4: Run e2e, typecheck, web coverage → PASS; `grep -ri seerr web/src/lib/i18n/locales/*/setup.ts` empty.**
- [ ] **Step 5: Commit** `feat(web): setup wizard`.

### Task 16: Docs for 25b and full checks

**Files:**
- Modify: `docs/setup.md` + `docs/de/setup.md` (rewritten main path: NPM host → `docker compose -f compose.prod.yaml up -d` → `docker compose logs backend | grep "setup code"` → wizard; the `.env` path moves to "Advanced: configure by environment"), `docs/authentik.md` + `docs/de/authentik.md` (new section "Automatic setup from FriendFlix": what the wizard creates, the superuser token used once, how to revoke it afterwards, grant types on 2026.8, what stays manual), `README.md` + `README.de.md` (install in three lines; screenshots with generated art only), `CHANGELOG.md`, `docs/security.md` (setup code, limits, setup session, SSRF note, one-time credentials)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full checks:** `npm run lint`, `npm run typecheck -w web`, `npm run spdx:check`, `npm run coverage -w backend`, `npm run coverage -w web`, `npm run build -w web`, `npm test -w gateway`, `npx playwright test e2e/tests/setup* e2e/tests/admin-settings*`, the compose CI check → all pass.
- [ ] **Step 3: Manual run (spec "Testing → Manual"):** fresh stack with no `.env` against Authentik 2026.8.3 and Jellyfin 10.11 → wizard to the first admin, invite flow works; an existing `.env` install upgrades and keeps working.
- [ ] **Step 4: Commit** `docs: Block 25b setup wizard`.
