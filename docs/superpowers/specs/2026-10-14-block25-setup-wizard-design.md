# Block 25 – Setup wizard and settings store (design)

Date: 2026-10-14 · Status: design approved in chat; this written spec is for review

## Goal

A new FriendFlix install needs **no `.env` at all**: `docker compose up` is enough, and everything else happens in the browser.
- A small init container generates every secret that is needed before the database can be read, into a dedicated Docker volume.
- A one-time setup code in the container log protects a setup wizard that configures the public URL, the media server, sign-in (Authentik, automatically or by hand) and the first admin.
- Every setting lives in the database afterwards and can be edited in **Admin → Settings**, live, on all instances.
- Existing installs keep working unchanged: their environment values win and are shown locked.

Owner decisions (chat, 2026-10-14):
- **No `.env` for new installs.** An init container generates into its own volume: the Postgres password (via `POSTGRES_PASSWORD_FILE` / a password file for the app), `APP_ENC_KEY`, `INTERNAL_SECRET` (shared with the gateway) and anything else needed before the DB is readable. Backup = DB + that volume.
- **Precedence: environment > DB setting > default.** Env-provided values are shown locked ("from environment"). A per-setting and an "all" button **Move into settings** copies env values (encrypted where secret) into the DB; afterwards the owner may delete them from `.env`.
- **First-run protection:** a one-time setup code in the container log; the wizard cannot be opened without it; it expires when setup completes, on a TTL and after N failed attempts; rate limited.
- **Automation:** with one-time admin credentials (an Authentik admin API token; a Jellyfin admin user/password) the wizard creates the Authentik provider, application, groups, service account + token with exactly FriendFlix's permissions, the flows FriendFlix uses, and a Jellyfin API key. The credentials are used once and never stored. Every automated step shows what it does; every service can be filled in by hand with live validation.
- **Approach A:** a typed settings registry in code; values in a `settings` table; secrets encrypted with `APP_ENC_KEY` (existing crypto helper); server-side validation incl. live probes; changes broadcast over Redis; config readers use an accessor that reflects live values. **No Docker socket for the app, ever.**
- **Wizard flow:** (1) setup code, (2) public URL, (3) media server (seam: the media module provides the step), (4) sign-in, (5) first admin, (6) optional extras. Everything editable later.
- **Order:** after Block 23 phase 2 and **before** phase 3. Phase 3's new keys are registered in this block's registry (see "Interface for Block 23 phase 3").

Not in scope:
- Managing the stack from the app (restarts, image updates beyond today's Portainer hook). The app never gets the Docker socket.
- Configuring the Jellyfin webhook plugin or the request service's webhook automatically (FriendFlix shows the values to paste).
- Rotating `APP_ENC_KEY` (re-encrypting the store). Documented as a non-feature.
- Writing Authentik e-mail template files (`/templates` is a file mount on the Authentik host; the wizard lists it as a manual step).
- The Plex fork's own media step (the seam is provided; the fork fills it).

## Part A – Key classification

`backend/src/config.ts` has 68 keys. Every key gets exactly one class. A test asserts that every key of the schema (and every compose-only variable listed below) appears in exactly one class.

Classes:
- **bootstrap** – needed before the DB is readable. Source: env (incl. `_FILE`) > bootstrap volume file > built-in default. Never stored in the DB.
- **env-only** – per container / per deployment, or shared with a third container that reads env only. Source: env > default. Shown read-only in Admin → Settings ("Server").
- **setting** – DB-backed, registry entry. Source: env > DB > default. `L` = applies live, `R` = needs a backend restart.
- **build** – baked into the image.

| Key | Class | Group / note |
|---|---|---|
| `PORT` | env-only | default 3000 (container-internal) |
| `PUBLIC_URL` | setting L | general; wizard step 2; run-required |
| `DATABASE_URL` | bootstrap | default `postgres://friendflix:<postgres_password>@postgres:5432/friendflix` |
| `REDIS_URL` | bootstrap | default `redis://:<redis_password>@redis:6379` |
| `SESSION_TTL_SECONDS` | setting L | sessions |
| `SESSION_IDLE_SECONDS` | setting L | sessions |
| `APP_ENC_KEY` | bootstrap | volume file `app_enc_key` |
| `INTERNAL_SECRET` | bootstrap | volume file `internal_secret` (+ gateway copy) |
| `WEBHOOK_SECRET` | setting L, secret | general; generated on demand, shown once (Part F) |
| `ADMIN_GROUP` | setting L | signin |
| `OIDC_ISSUER` | setting L | signin; run-required |
| `OIDC_CLIENT_ID` | setting L | signin; run-required |
| `OIDC_CLIENT_SECRET` | setting L, secret | signin; run-required |
| `MEDIA_SERVER` | env-only | per instance; the Plex fork changes the default; gateway reads it too |
| `JELLYFIN_URL` | setting L | media (registered by the media module); run-required for `jellyfin` |
| `JELLYFIN_ADMIN_API_KEY` | setting L, secret | media; run-required for `jellyfin` |
| `REQUESTS_URL` | setting L | requests; **now optional** (legacy env `SEERR_URL`) |
| `REQUESTS_API_KEY` | setting L, secret | requests (legacy env `SEERR_API_KEY`) |
| `NTFY_URL` | setting L | notifications |
| `DISCORD_WEBHOOK_URL` | setting L, secret | notifications (the URL carries a token) |
| `NTFY_BASE_URL` | setting L | notifications |
| `DIGEST_DAY`, `DIGEST_HOUR` | env-only (unchanged) | stay the *default* under the existing Admin → Digest override (`app_settings` key `digest`); semantics unchanged |
| `VAPID_PUBLIC_KEY` | setting L | push |
| `VAPID_PRIVATE_KEY` | setting L, secret | push; generated with the public key as a pair |
| `VAPID_SUBJECT` | setting L | push |
| `CAST_ENABLED` | setting L | playback |
| `METRICS_TOKEN` | env-only | shared with Prometheus in `compose.monitoring.yaml`, which reads env only |
| `TMDB_API_KEY`, `OMDB_API_KEY` | setting L, secret, hint last4 | sources; migrated from `app_settings` `source.tmdb` / `source.omdb`; Admin → Sources keeps its page |
| `AUTHENTIK_URL` | setting L | signin |
| `AUTHENTIK_API_TOKEN` | setting L, secret | signin |
| `AUTHENTIK_ENROLL_FLOW` | setting L | signin |
| `AUTHENTIK_RECOVERY_FLOW` | setting L | signin, default `default-recovery-flow` |
| `AUTHENTIK_TOTP_SETUP_FLOW` | setting L | signin, default `default-authenticator-totp-setup` |
| `ROLE_TEMPLATES` | env-only | advanced JSON override (Admin → Roles is the UI) |
| `OIDC_ALLOW_INSECURE` | env-only | development only |
| `PREVIEW_DIR` | env-only | path tied to the volume mount |
| `PREVIEW_WARM` | setting L | playback (the timer always runs and checks the flag) |
| `GIT_SHA`, `BUILD_TIME`, `APP_VERSION`, `APP_CODENAME` | build | |
| `UPDATE_REPO` | env-only | fork-level constant |
| `GITHUB_TOKEN` | setting L, secret | updates |
| `PORTAINER_WEBHOOK_URL` | setting L, secret | updates (the URL is the credential) |
| `PORTAINER_URL` | setting L | updates |
| `PORTAINER_API_KEY` | setting L, secret | updates |
| `PORTAINER_STACK_ID` | setting L | updates |
| `PORTAINER_ENDPOINT_ID` | setting L | updates |
| `PLAYBACK_CHECK_HOUR` | setting L | health |
| `DOWNLOADS_ENABLED` | setting L | downloads (ticks always registered under `BACKGROUND_JOBS`, they check the flag) |
| `DIRECT_PLAY_REQUIRES_DOWNLOAD` | setting L | downloads |
| `DOWNLOAD_DIR` | env-only | path tied to the volume mount |
| `DOWNLOAD_CACHE_MAX_GB`, `DOWNLOAD_MIN_FREE_GB`, `DOWNLOAD_PREP_CONCURRENCY`, `DOWNLOAD_PAUSE_STREAMS`, `DOWNLOAD_FILE_TTL_HOURS`, `DOWNLOAD_OFFLINE_GRACE_DAYS` | setting L | downloads |
| `DOWNLOAD_CREATE_PER_HOUR` | setting R | downloads (route rate-limit option, read at registration) |
| `HOME_NETWORKS` | setting L | playback |
| `BACKGROUND_JOBS` | env-only | **per instance** (replicas differ), so never a shared DB value |
| `API_COMPRESSION` | setting R | general (plugin registered at start) |
| `GATEWAY_URL` | env-only | internal topology |
| `HEALTH_DISK_WARN_PCT`, `HEALTH_DISK_CRIT_PCT`, `HEALTH_DB_WARN_GB` | setting L | health (cross-check warn < crit stays) |

No key is removed. Compose-only variables (not in `config.ts`): `BIND_ADDR`, `WEB_PORT`, `BACKEND_PORT`, `GATEWAY_PORT`, `FF_REGISTRY`, `FF_TAG`, `DOWNLOADS_PATH`, `PREVIEWS_PATH`, `MEDIA_PATH`, `TZ`, `BACKUP_*`, `GRAFANA_*`, `PROMETHEUS_RETENTION` stay compose-level with defaults. `POSTGRES_PASSWORD` and `REDIS_PASSWORD` become **optional legacy inputs** of the init container (Part C).

Counts: 4 bootstrap (`DATABASE_URL`, `REDIS_URL`, `APP_ENC_KEY`, `INTERNAL_SECRET`), 12 env-only (`PORT`, `DIGEST_DAY`, `DIGEST_HOUR`, `MEDIA_SERVER`, `METRICS_TOKEN`, `ROLE_TEMPLATES`, `OIDC_ALLOW_INSECURE`, `PREVIEW_DIR`, `UPDATE_REPO`, `DOWNLOAD_DIR`, `BACKGROUND_JOBS`, `GATEWAY_URL`), 4 build, 48 settings = 68.

Pre-registered for Block 23 phase 3 (hidden until phase 3 sets `visible: true`; see the interface section): `LOGIN_UI`, `AUTHENTIK_LOGIN_FLOW`, `AUTHENTIK_STATIC_SETUP_FLOW`, `AUTHENTIK_WEBAUTHN_SETUP_FLOW`, `AUTHENTIK_PASSWORD_CHANGE_FLOW`, `AUTHENTIK_INVALIDATION_FLOW`, `AUTHENTIK_EMAIL_CHANGE_FLOW`, `PASSKEYS_IN_APP`, `LOGIN_COVER_WALL`.

## Part B – Settings store

### B1. Registry (`backend/src/settings/registry.ts`)
```ts
type SettingKind = 'string' | 'url' | 'secret' | 'int' | 'number' | 'bool' | 'enum' | 'cidrList' | 'json';
type SettingGroup = 'general' | 'signin' | 'media' | 'requests' | 'notifications' | 'push' | 'sources'
  | 'downloads' | 'playback' | 'updates' | 'health' | 'sessions';
type ProbeId = 'publicUrl' | 'media' | 'oidc' | 'authentik' | 'requests' | 'tmdb' | 'omdb' | 'portainer' | 'github';
interface SettingDef {
  key: string;              // the env name, e.g. 'JELLYFIN_URL'
  kind: SettingKind;
  group: SettingGroup;
  schema: z.ZodTypeAny;     // parses the raw string (env) and the stored JSON value (db)
  default?: unknown;        // static default; undefined = unset
  secret?: boolean;         // encrypted at rest, write-only in the UI
  hint?: 'last4';           // secrets that may show their last 4 chars (API keys only, never passwords/client secrets)
  apply: 'live' | 'restart';
  probe?: ProbeId;          // the group probe run on save and on "Test"
  legacyEnv?: string[];     // e.g. ['SEERR_URL'] for REQUESTS_URL
  generate?: 'webhookSecret' | 'vapidPair';
  runRequired?: boolean | ((cfg: Config) => boolean);   // must be set once setup is complete
  visible?: boolean;        // default true; false for pre-registered phase-3 keys
  options?: readonly string[]; min?: number; max?: number;
}
export const SETTINGS: readonly SettingDef[];
export const ENV_ONLY_KEYS: readonly string[];
export const BOOTSTRAP_KEYS: readonly string[];
export const BUILD_KEYS: readonly string[];
```
- The media module contributes its entries: `mediaSettings(): SettingDef[]` in `backend/src/media/index.ts` (Jellyfin: `JELLYFIN_URL`, `JELLYFIN_ADMIN_API_KEY`). The Plex fork adds its own there.
- `config.ts` keeps one zod schema for env-only/bootstrap/build keys and derives the setting part from `SETTINGS`, so `Config` keeps its current shape and field types.

### B2. Data model
New migration (appended to `MIGRATIONS`):
```sql
create table settings (
  key text primary key,
  value jsonb,                 -- non-secret value
  enc text,                    -- AES-256-GCM blob (crypto.encrypt) for secrets
  last4 text,                  -- only for hint 'last4'
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  check ((value is null) <> (enc is null))
);
create table settings_meta (
  id int primary key check (id = 1),
  rev bigint not null default 0,
  setup_completed_at timestamptz,
  setup_code_hash text,
  setup_code_expires_at timestamptz,
  setup_code_failures int not null default 0
);
insert into settings_meta(id, setup_completed_at)
  select 1, case when exists (select 1 from users) then now() end;
-- existing data-source keys move over unchanged (same encryption key, same blob format)
insert into settings(key, enc, last4, updated_at)
  select case key when 'source.tmdb' then 'TMDB_API_KEY' else 'OMDB_API_KEY' end, value->>'enc', value->>'last4', updated_at
  from app_settings where key in ('source.tmdb','source.omdb') and value ? 'enc';
delete from app_settings where key in ('source.tmdb','source.omdb');
```
- Every write bumps `settings_meta.rev` in the same transaction.
- `app_settings` stays for feature-owned values (`digest`, default language).
- The migration marks setup complete for every install that has users, so existing installs never see the wizard.

### B3. Precedence and resolution
`resolveConfig({ env, db, bootstrap }): { cfg: Config; sources: Record<string, Source>; invalid: string[] }` (pure):
- **env layer:** `VAR`, then `VAR_FILE` (Docker secrets), then legacy names (`RENAMED_ENV`). An **empty string counts as unset** (compose passes `${VAR:-}`).
- **db layer:** decrypted rows. A row that fails its schema or cannot be decrypted (wrong `APP_ENC_KEY`) is ignored, listed in `invalid`, and logged by key name only.
- **bootstrap layer** (bootstrap keys only): files in `/run/friendflix` (Part C).
- `Source = 'env' | 'db' | 'bootstrap' | 'default' | 'unset'`.
- Cross-field rules stay (`HEALTH_DISK_WARN_PCT < HEALTH_DISK_CRIT_PCT`, `MEDIA_REQUIRED`), but in setup mode run-required keys may be unset; they are then `''` in `cfg`. The setup gate (Part E) guarantees no route that needs them runs.
- `loadConfig(env)` stays as the env-only resolution (tests, bootstrap, startup before the DB is read).

### B4. Live reload
`backend/src/settings/store.ts`:
```ts
interface SettingsStore {
  current(): Config;
  sources(): Record<string, Source>;
  invalid(): string[];
  rev(): number;
  reload(): Promise<void>;
  save(changes: Record<string, unknown | null>, actor: string | null): Promise<number>;   // returns the new rev
  importEnv(keys: readonly string[] | 'all', actor: string | null): Promise<string[]>;
  onChange(keys: readonly string[], fn: (cfg: Config, changed: string[]) => void | Promise<void>): () => void;
  pendingRestart(): string[];   // restart keys whose effective value differs from the boot snapshot
}
interface SettingsBus { publish(rev: number): Promise<void>; subscribe(fn: (rev: number) => void): Promise<() => void> }
```
- `RedisSettingsBus` uses a duplicated ioredis connection (subscriber mode) on channel `ff:settings:rev`. The message carries **only the rev**, never values; each instance reloads from the DB.
- Fallback poll: every 30 s, `select rev from settings_meta`; a higher rev reloads. A missed message therefore costs at most 30 s.
- `ctx.cfg` becomes a getter returning `store.current()` (an immutable snapshot swapped atomically). Code that captures config at startup is listed and moved to `onChange`:
  - `ctx.oidc`: built lazily on first use and rebuilt on `PUBLIC_URL`/`OIDC_*` changes. A discovery failure no longer kills the backend: it answers `503 oidc_unavailable` and retries on the next login (backoff 30 s).
  - `ctx.jf`: rebuilt on media key changes (`stop()`/`start()` of the old/new instance).
  - `ctx.seerr`: rebuilt on `REQUESTS_*`; `null` when unset.
  - push (`pushEnabled`) re-validates the VAPID pair on change.
- Timers that were registered conditionally (`PREVIEW_WARM`, `DOWNLOADS_ENABLED`) are always registered under `BACKGROUND_JOBS` and check the flag per tick.

### B5. Request service optional
`REQUESTS_URL` is no longer required. `requestsEnabled(ctx)` = URL and key set. Request routes answer `404 requests_disabled`; jobs that need it skip; `/api/me` gains `features.requests: boolean`; the web hides request UI. User-facing text never says "Seerr".

## Part C – Bootstrap volume and init container

### C1. Volumes
- `bootstrap` → `/run/friendflix` (ro in postgres, redis, backend, backup; rw in the init container): `postgres_password`, `redis_password`, `redis.conf`, `app_enc_key`, `internal_secret`.
- `bootstrap-gateway` → `/run/friendflix-gateway` (ro in the gateway): only `internal_secret`. The gateway never sees the DB password or the encryption key.

### C2. Init container (`bootstrap` service)
- Image: the backend image, `command: ["node", "backend/dist/bootstrap.js"]` (no new image to publish). Dependency-free (`node:crypto`, `node:fs`).
- `user: "0:0"`, `read_only: true`, `cap_drop: [ALL]`, `cap_add: [CHOWN]`, `network_mode: none`, `restart: "no"`.
- Every other service has `depends_on: { bootstrap: { condition: service_completed_successfully } }`.
- Per file, in order: **env value non-empty → write it** (legacy installs: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_ENC_KEY`, `INTERNAL_SECRET` are passed through as `${VAR:-}`); **else file exists → keep**; **else generate**:
  - `postgres_password`, `redis_password`, `internal_secret`: 32 random bytes, hex (64 chars).
  - `app_enc_key`: 32 random bytes, base64 (44 chars; satisfies `keyFromBase64`).
  - `redis.conf`: `requirepass <redis_password>` (rewritten whenever the password file changes).
- Ownership and modes: owner `0`, group `10001` (`FF_SECRETS_GID`), mode `0440`; the directory `0750`. Services that read them add `group_add: ["10001"]`: backend (uid 1000), gateway, backup (uid 70), redis (runs as `user: "999:999"`). Postgres reads `POSTGRES_PASSWORD_FILE` as root in its entrypoint.
- It logs file **names** and the action (`kept`, `generated`, `from environment`), never values.
- Writes are atomic (temp file + rename). A run is idempotent.

### C3. Consumers
- postgres: `POSTGRES_PASSWORD_FILE: /run/friendflix/postgres_password` only (the image refuses `POSTGRES_PASSWORD` and `_FILE` together; empty counts as unset).
- redis: `redis-server /run/friendflix/redis.conf --save "" --appendonly no`; healthcheck reads the password file into `REDISCLI_AUTH`.
- backend: when `DATABASE_URL` / `REDIS_URL` / `APP_ENC_KEY` / `INTERNAL_SECRET` are not in env, `readBootstrap('/run/friendflix')` supplies them (`backend/src/settings/bootstrap.ts`). A missing file is a startup error naming the file and the fix.
- gateway: `INTERNAL_SECRET` env or `_FILE` (unchanged), else `/run/friendflix-gateway/internal_secret`.
- backup sidecar: `PGPASSWORD_FILE` defaults to `/run/friendflix/postgres_password`; `PGPASSWORD` env still wins.
- web: `ORIGIN: ${PUBLIC_URL:-}` (empty = derive from the request), plus `PROTOCOL_HEADER: x-forwarded-proto`. *(Unverified: adapter-node treating an empty `ORIGIN` as unset; Task 5 verifies it and otherwise drops the variable.)*

### C4. Compose changes (all of `compose.yaml`, `compose.prod.yaml`, `compose.secrets.yaml`, `compose.planb.yaml`, `compose.monitoring.yaml`)
- No `:?` anywhere; no injected defaults for setting keys (they would always count as "from environment"). Each pre-Block-25 setting key keeps a pass-through line `KEY: ${KEY:-}` so existing `.env` files keep working. New keys (phase 3) get no compose line.
- `DATABASE_URL`/`REDIS_URL` lines are removed (derived from the volume); an env value still wins if a local override sets one.
- `compose.secrets.yaml` keeps working (`_FILE` is env layer).

### C5. Backup
- **Backup = DB dump + the `bootstrap` volume.** Documented command:
  `docker run --rm -v friendflix_bootstrap:/s:ro -v "$PWD":/b alpine tar czf /b/friendflix-bootstrap.tgz -C /s .` and `scripts/backup-bootstrap.sh`.
- Kept apart from the nightly dumps on purpose (the encryption key next to the data it protects defeats the separation). The nightly sidecar does not include it.
- Restore without the volume: settings secrets show "stored value unreadable" and must be re-entered; Jellyfin passwords of users are lost (as today without `APP_ENC_KEY`).

## Part D – Gateway configuration

The gateway is not on the `db` network and has no Redis. It pulls from the backend:
- `GET /internal/gateway-config` (header `x-internal-secret`) → `{ rev: number; upstreamUrl: string | null }`. `upstreamUrl` is the media module's URL key (`MediaSetupProvider.urlKey`) from the live config. 503 `setup_required` before the media server is configured.
- The gateway fetches it at start (retry every 5 s until it answers), then every 30 s, and immediately when an `/internal/authz*` response carries `x-ff-config-rev` different from its cached rev.
- An env value (`JELLYFIN_URL` or the adapter's `urlEnv`) still wins; then the gateway never fetches the URL.
- Without an upstream URL, `/media/*` answers 503 and `/health` stays 200 (no restart loop).
- `METRICS_TOKEN` stays env-only.

## Part E – First-run protection and setup mode

### E1. Setup state
- `setupComplete` = `settings_meta.setup_completed_at is not null`.
- While not complete, a global `onRequest` hook answers `503 { error: 'setup_required' }` for everything except: `/health`, `/api/setup/*`, `/auth/login` and `/auth/callback` **with a valid setup session**, `/internal/gateway-config`. Background jobs check `isOperational(ctx)` each tick and do nothing.
- The web treats `503 setup_required` from `/api/me` as "go to `/setup`".

### E2. Setup code
- Generated by the backend at start when setup is not complete and `BACKGROUND_JOBS=true` (one instance owns it): 12 characters from Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), shown as `XXXX-XXXX-XXXX` (60 bits).
- Stored as `sha256(normalized code)` with `setup_code_expires_at = now() + 24 h`, `setup_code_failures = 0`. Every start replaces the previous code.
- Logged once at `warn` level: `FriendFlix setup: open the portal in your browser and enter the setup code K7QM-3XA9-PT2D (valid until 2026-10-15 14:03 UTC). Restart the backend for a new code.`
- Normalisation of input: upper-case, remove spaces and dashes, `O`→`0`, `I`/`L`→`1`.
- Limits: per IP 5 attempts / 15 min (route rate limit); globally 10 failures → the code is invalidated (`setup_code_hash = null`), log `Too many wrong setup codes; restart the backend for a new code`. Expired → `410 code_expired`.
- A valid code creates a **setup session**: random token in the httpOnly cookie `ff_setup` (`sameSite: 'lax'`, `secure` when the request is https, path `/`), kv `setup:sess:<sha256(token)>`, TTL 2 h, sliding. Plus a readable `ff_setup_csrf` cookie (`sameSite: 'strict'`); every setup POST/PUT sends `x-ff-setup-csrf` equal to it (timing-safe). `ff_setup` is Lax (ruling, Task 11 review I1) because the IdP's redirect back to `/auth/callback` is a cross-site navigation whenever Authentik runs on another site (another domain, or hosts like `auth.lan` / `ff.lan`), and a Strict cookie would be dropped there, so the first admin could never sign in; writes stay protected by the double-submit header, which a cross-site page cannot set.
- The code stays valid (for another device) until setup completes, its TTL ends, or it is invalidated.
- On completion: `setup_code_hash = null`, all `setup:sess:*` deleted, audit `setup.completed`, log `Setup completed; the setup code is no longer valid.`

### E3. Security notes
- The wizard makes the backend call URLs the code holder types (SSRF surface limited to the code holder / later admins; responses are never relayed, only status codes).
- One-time credentials (Authentik admin token, Jellyfin admin password) live only in the request; they are never stored, logged or put into errors. Bodies of `/api/setup/*` and `/api/admin/settings*` are excluded from error logs (like `/auth/flow/*`).

## Part F – Wizard

Route `/setup` (web), API under `/api/setup/*`. Steps:

1. **Setup code.** `POST /api/setup/unlock { code }` → sets the setup session. `GET /api/setup/state` → `{ complete, unlocked, mediaKind, steps: { publicUrl, media, signin, admin }: 'todo'|'done'|'env', prefill: { publicUrl } }`.
2. **Public app URL.** Prefilled from `x-forwarded-proto` + `host`. Must be an origin (no path, no query); `http:` allowed with a warning (cookies not secure, cast and passkeys off). Probe `publicUrl`: the backend stores a nonce in kv and fetches `<url>/api/setup/echo/<nonce>`; a mismatch or network error is a **warning** (NAT loopback), never a blocker. Saved via the settings service.
3. **Media server** (provided by the media module, see Part H). Jellyfin: URL + admin username/password → **Create API key automatically**, or manual URL + API key. Live probe on both.
4. **Sign-in.** Authentik URL + admin API token → plan → apply (Part G). Or manual: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `ADMIN_GROUP`, optional `AUTHENTIK_URL`/`AUTHENTIK_API_TOKEN`/`AUTHENTIK_ENROLL_FLOW`, with the probes `oidc` and `authentik` and a checklist (redirect URI, implicit consent, grant type `authorization_code`).
5. **First admin.** "Sign in with Authentik" → `/auth/login?setup=1`. The callback, when `!setupComplete` and the request carries a valid setup session: creates the account as **admin** (no group, invite or approval check; Jellyfin user created as for any first login), then `completeSetup(ctx, userId)`. Without a setup session the callback redirects to `/setup?expired=1` (the code step with the "session expired" note; final 25b wave: a browser navigation gets no JSON answer), and `/auth/login` to `/setup`. Lands on `/setup/extras` signed in.
6. **Optional extras** (admin session; every card has "Skip"): request service (URL + API key, probe), TMDB / OMDb keys, downloads on/off, push (**Generate keys** creates the VAPID pair server-side; the private key never reaches the browser), ntfy / Discord, webhooks (**Generate webhook secret** shows the secret once with the header lines to paste into Jellyfin and the request service), updates via Portainer. "Finish" goes to `/`.

A step whose keys come from the environment shows them locked and is skippable ("from environment").

Setup-session endpoints for steps 2–4 (all need `ff_setup` + `x-ff-setup-csrf`, and answer `409 setup_complete` once setup is done):
- `PUT /api/setup/settings { values, force? }`: the same validation, probes and audit (actor `null`, action `settings.update`) as `PUT /api/admin/settings`, limited to `PUBLIC_URL`, the media provider's keys and the `signin` group (`400 not_allowed` otherwise).
- `POST /api/setup/test { group, values? }`: as the admin test endpoint.
- `POST /api/setup/media/auto { url, username, password }` → `{ ok: true }` or a `ProbeResult` failure.
- `POST /api/setup/authentik/plan` and `/apply` (Part G).

`completeSetup` also stamps the new admin session's re-authentication time (phase 2's `reauthAt`), so step 6 can save secrets without an extra re-authentication.

`WEBHOOK_SECRET` is optional now: while it is unset, the webhook routes answer `403` as for a wrong secret (existing installs keep theirs from `.env`).

## Part G – Authentik automation

Client: `backend/src/setup/authentikSetup.ts`, `fetch` with 10 s timeout per call (blueprint imports 60 s; a path import answered 5xx is retried, see Verified), `Authorization: Bearer <admin token>`.

**Plan** (`POST /api/setup/authentik/plan { url, token }`, read-only) and **apply** (`POST /api/setup/authentik/apply { url, token, addMeToAdmins: boolean }`) return the same step list:
```ts
type AkStepId = 'check' | 'groups' | 'provider' | 'serviceAccount' | 'enrollment' | 'recovery' | 'brand' | 'readback' | 'adminMember' | 'extraFlows';
interface AkStep { id: AkStepId; state: 'create' | 'update' | 'exists' | 'skip' | 'ok' | 'failed'; detail?: string /* i18n code */ }
```
1. **check:** `GET /api/v3/core/users/me/` → `user.is_superuser` must be true (otherwise plan and apply both answer `200` with the step list `[check: failed not_superuser]` and nothing else runs, like every other step failure; amended in the final 25b wave to match the implementation). `GET /api/v3/admin/version/` → `version_current`; below 2024.4 → `unsupported_version`.
2. **groups**, **provider**, **serviceAccount**, **enrollment** are blueprints imported with `POST /api/v3/managed/blueprints/import/` (multipart: `file` = the YAML, `context` = JSON string). The endpoint validates, checks the token's add/change/delete permissions per model and applies synchronously; the answer is `{ success: boolean, logs: [...] }`. Re-running is safe (entries match by identifiers).
   - `deploy/authentik/friendflix-setup.yaml` (new): groups `!Context admin_group` (default `friendflix-admins`) and `friendflix-users`; OAuth2 provider `FriendFlix` with `authorization_flow` = `!Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]`, `invalidation_flow` = `default-provider-invalidation-flow`, `client_type: confidential`, `grant_types: [authorization_code]`, `redirect_uris: [{ matching_mode: strict, url: !Format ["%s/auth/callback", !Context public_url] }]`, `signing_key` = `!Find [authentik_crypto.certificatekeypair, [name, "authentik Self-signed Certificate"]]`, `property_mappings` = the managed scope mappings `goauthentik.io/providers/oauth2/scope-openid|email|profile`, `sub_mode: hashed_user_id`, `include_claims_in_id_token: true`, `issuer_mode: per_provider`; application `FriendFlix`, slug `friendflix`, `meta_launch_url: !Context public_url`, `policy_engine_mode: any`.
   - `deploy/authentik/friendflix-service-account.yaml` (existing) and `deploy/authentik/friendflix-blueprint.yaml` (existing, enrollment flow) are imported unchanged.
   - Grant types: Authentik 2026.8 creates API/blueprint providers with **no** grant types (`default=list`); the blueprint sets `authorization_code` explicitly. Providers updated in place get it added.
   - Plan mode reads instead: `GET /api/v3/core/groups/?name=`, `GET /api/v3/providers/oauth2/?name=FriendFlix`, `GET /api/v3/core/applications/friendflix/`, `GET /api/v3/core/users/?username=friendflix-invites`, `GET /api/v3/flows/instances/friendflix-enrollment/` → `create` / `update`.
   - An existing provider named `FriendFlix` with other settings is **updated** (plan shows `update`, the UI says which fields the blueprint sets).
3. **recovery:** if `GET /api/v3/flows/instances/default-recovery-flow/` is 404: import by path, `POST /api/v3/managed/blueprints/import/` with `path=example/flows-recovery-email-mfa-verification.yaml` (Authentik's shipped example, MFA variant per docs §10). Otherwise `exists`.
4. **brand:** the default brand (`GET /api/v3/core/brands/?default=true`) gets `PATCH { flow_recovery: <recovery flow pk> }` when empty; the identification stage `default-authentication-identification` gets `PATCH /api/v3/stages/identification/<pk>/ { user_fields, sources, recovery_flow: <pk> }` when empty (`user_fields`/`sources` sent back unchanged: 2026.8.3 refuses the PATCH without them). Existing values are never overwritten (`exists`).
5. **readback:** `GET /api/v3/providers/oauth2/?name=FriendFlix` → `client_id`, `client_secret` (visible to superusers: the serializer's `secret_fields` are returned when the caller may change the object); `GET /api/v3/core/tokens/friendflix-invites-token/view_key/` → `key`. Issuer = `<url>/application/o/friendflix/`; verified by fetching its discovery document (issuer must match exactly).
6. **adminMember** (when `addMeToAdmins`): `POST /api/v3/core/groups/<admin group pk>/add_user/ { pk: <me.user.pk> }`.
7. **extraFlows:** each blueprint in `AK_EXTRA_BLUEPRINTS` (empty in Block 25; phase 3 appends the e-mail change flow) is imported like step 2.
- Then one settings write: `AUTHENTIK_URL`, `AUTHENTIK_API_TOKEN` (the **service account's** token, never the admin token), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `ADMIN_GROUP`, `AUTHENTIK_ENROLL_FLOW=friendflix-enrollment`, `AUTHENTIK_RECOVERY_FLOW=default-recovery-flow`.
- Steps run in order; the first failure stops the run and returns the list so far (`failed` with a code: `unauthorized`, `not_superuser`, `blueprint_invalid`, `unreachable`, `unexpected`). Nothing is rolled back in Authentik (re-running is idempotent).
- **Manual leftovers** shown after apply: SMTP for Authentik, MFA in the authentication flow (docs §6), the `/templates` mount (phase 3).

**Jellyfin automation** (`backend/src/jellyfin/setup.ts`, part of the media provider):
1. `GET <url>/System/Info/Public` → `StartupWizardCompleted` must be true (else `jellyfin_wizard_pending`: "finish Jellyfin's own setup first").
2. `POST <url>/Users/AuthenticateByName` `{ Username, Pw }` with `Authorization: MediaBrowser Client="FriendFlix", Device="Setup", DeviceId="ff-setup-<random>", Version="<app version>"` → `AccessToken`, `User.Policy.IsAdministrator` must be true (`not_admin`).
3. `POST <url>/Auth/Keys?app=FriendFlix` (204, no body; needs elevation).
4. `GET <url>/Auth/Keys` → `Items[]` (`AccessToken`, `AppName`, `DateCreated`): the newest with `AppName === 'FriendFlix'` created after step 3 started.
5. `POST <url>/Sessions/Logout` with the session token (best effort).
6. Save `JELLYFIN_URL` + `JELLYFIN_ADMIN_API_KEY`. The probe `media` (`GET /Auth/Keys` with the key → 200 means an admin-level key) confirms it.

## Part H – Plex fork seam

`backend/src/media/setup.ts`:
```ts
interface MediaSetupProvider {
  kind: MediaServerKind;
  keys: readonly string[];          // registry keys, in field order (Jellyfin: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'])
  urlKey: string;                   // the gateway upstream (Jellyfin: 'JELLYFIN_URL')
  probe(values: Record<string, string | undefined>, deps: { fetchImpl: typeof fetch }): Promise<ProbeResult>;
  auto?: {
    fields: readonly ('url' | 'username' | 'password')[];
    run(input: { url: string; username: string; password: string }, deps: { fetchImpl: typeof fetch; appVersion: string }): Promise<Record<string, string>>;
  };
}
export const MEDIA_SETUP: Partial<Record<MediaServerKind, MediaSetupProvider>>;
```
- The web renders the media step from `GET /api/setup/state` (`media: { keys, auto: fields | null }`) and the registry's kinds; labels come from `settings.keys.<KEY>` strings with the key name as fallback. The fork adds `MEDIA_SETUP.plex` (Plex URL + token, manual, probe) and its i18n strings; no web code change.
- A kind without an entry falls back to manual fields from `mediaSettings()`.
- All new members are optional or additive: the fork keeps compiling.

## Part I – Admin → Settings

Route `/admin/settings` (new nav entry). Groups as in B1, plus a read-only **Server** group (env-only and bootstrap keys: source and set/unset only, never values).

Per setting:
- Label + help (i18n), an input by kind.
- **Source badge:** "from environment" (locked; input disabled), "saved", "default".
- **Secret:** write-only: "set" / "not set", updated date, `…last4` only with `hint: 'last4'`. Actions **Replace** (input) and **Clear**.
- **Restart badge** for `apply: 'restart'`; a banner lists `pendingRestart()` keys with "Restart the backend: `docker compose restart backend`".
- **Move into settings** on env-sourced rows, and **Move all** at the top. After moving, the row says "Also saved. You can now remove `KEY` (and `KEY_FILE`, legacy names) from `.env` and restart." Until removed, env still wins.
- An unreadable or invalid stored value shows "stored value unreadable – enter it again".

API (`requireAdmin`, CSRF as existing admin routes):
- `GET /api/admin/settings` → `{ rev, pendingRestart: string[], groups: Array<{ id: SettingGroup | 'server'; items: SettingView[] }> }`, with
  `SettingView = { key; kind; source: Source; value: unknown | null /* null for secrets */; set: boolean; last4?: string; apply; restartPending: boolean; invalid: boolean; envNames: string[]; updatedAt: string | null; options?; min?; max? }`.
- `PUT /api/admin/settings { values: Record<string, unknown | null>, force?: boolean }`:
  - Unknown, env-only or env-locked keys → `400 { errors: { KEY: 'locked' | 'unknown' } }`.
  - Schema errors → `400 { errors: { KEY: code } }`.
  - Clearing a run-required key → `400 required`.
  - The affected groups' probes run against the candidate config. `unauthorized` / `invalid` / `not_admin` always block; `unreachable` / `timeout` block unless `force: true` ("Save anyway").
  - One transaction, rev bump, publish. Audit `settings.update` with `{ keys }` only, never values.
  - Changing a secret or `ADMIN_GROUP` / `OIDC_*` / `AUTHENTIK_*` requires recent re-authentication (phase 2 `requireRecentAuth(ctx, 10 * 60_000)` → `403 reauth_required`).
- `POST /api/admin/settings/test { group, values? }` → `ProbeResult` (unsaved candidate values; omitted secrets use the saved ones).
- `POST /api/admin/settings/import-env { keys: string[] | 'all' }` → `{ moved: string[] }`; audit `settings.import_env` with `{ keys }`.
- `POST /api/admin/settings/generate { what: 'webhookSecret' | 'vapidPair' }` → webhook: `{ secret }` **once** (the only time a secret value leaves the server; the response has `cache-control: no-store`); VAPID: `{ publicKey }`. Audited.
- `ProbeResult = { ok: boolean; code: 'ok' | 'unreachable' | 'timeout' | 'unauthorized' | 'invalid' | 'not_admin' | 'issuer_mismatch' | 'wizard_pending' | 'warning'; detail?: string }` (detail is an i18n code, never an upstream body).

Admin → Sources keeps its page; its routes call the settings service for `TMDB_API_KEY` / `OMDB_API_KEY` (env > DB unchanged). `sources/keys.ts` reads `ctx.cfg` and `store.sources()` instead of `app_settings`.

## Interface for Block 23 phase 3

Phase 3 consumes:
- **Registry entries** (pre-registered by Block 25 with `visible: false`; phase 3 sets `visible: true` and wires them):
  | Key | Kind / default |
  |---|---|
  | `LOGIN_UI` | enum `app` \| `authentik`, no default (phase 3's `loginUi(cfg)` decides) |
  | `AUTHENTIK_LOGIN_FLOW` | string, `default-authentication-flow` |
  | `AUTHENTIK_STATIC_SETUP_FLOW` | string, `default-authenticator-static-setup` |
  | `AUTHENTIK_WEBAUTHN_SETUP_FLOW` | string, `default-authenticator-webauthn-setup` |
  | `AUTHENTIK_PASSWORD_CHANGE_FLOW` | string, `default-password-change` |
  | `AUTHENTIK_INVALIDATION_FLOW` | string, `default-invalidation-flow` |
  | `AUTHENTIK_EMAIL_CHANGE_FLOW` | string, `friendflix-email-change` |
  | `PASSKEYS_IN_APP` | enum `auto` \| `off`, `auto` |
  | `LOGIN_COVER_WALL` | bool, `true` (replaces phase 3's `app_settings` key `login_art`; its `GET|PUT /api/admin/login-settings` becomes a thin wrapper over the settings service or is dropped in favour of Admin → Settings) |
- `ctx.cfg` is live; phase 3 must not cache flow slugs beyond its own 10-min kv caches, and should subscribe with `store.onChange` where it holds derived state.
- `AK_EXTRA_BLUEPRINTS: Array<{ id: string; file: string; context?: (cfg: Config) => Record<string, string> }>` in `backend/src/setup/authentikSetup.ts`: phase 3 appends `friendflix-email-change.yaml`.
- Phase 3's Task 1 "Modify config.ts" becomes "use the registered keys"; its status check keeps using the service token (never the one-time admin token).

## Part J – Migration for existing installs
- Upgrade = pull + `up -d`. The init container copies `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_ENC_KEY`, `INTERNAL_SECRET` from `.env` into the volume (env wins on every run).
- The migration marks setup complete when users exist; settings come from env and show locked.
- The owner may click **Move all**, then delete the moved keys from `.env`. The four bootstrap values may also be deleted from `.env` once the volume holds them (documented: check `docker compose run --rm bootstrap` output says `kept`).
- `docs/setup.md` gets an "Upgrading to settings in the database" section; `.env.example` shrinks to optional overrides with a header saying a new install needs none.

## Error handling
- DB row undecryptable → ignored, `invalid` flag, warning by key name.
- Redis down → no broadcast; the 30 s poll still converges.
- OIDC discovery fails → login shows "Sign-in service unavailable" (existing copy), backend stays up.
- Media server unreachable after a change → health page shows it; the old client is already replaced (the probe ran before saving).
- Bootstrap file missing at backend start → exit with `bootstrap file /run/friendflix/<name> missing: start the stack with docker compose up (the bootstrap service creates it)`.
- Authentik apply fails mid-way → list with the failed step and its code; "Try again" re-runs everything (idempotent).

## Testing
- **Unit / backend:**
  - classification completeness (every schema key in exactly one class)
  - `resolveConfig` precedence (env > db > default; `_FILE`; legacy names; empty = unset; invalid row ignored)
  - store: save → rev bump → publish; second store reloads on message and via poll; `onChange` fires only for changed keys; `pendingRestart`
  - migration: source keys moved, setup complete iff users exist
  - bootstrap script: generate / keep / env wins / modes 0440 gid 10001 / idempotent / no values in output
  - setup code: format, normalisation, TTL, per-IP and global limits, invalidation, session + CSRF, completion clears sessions
  - setup gate: 503 everywhere but the allow-list
  - first admin: callback with setup session → admin + complete; without → 503
  - Jellyfin auto (fake HTTP): wizard pending, not admin, key picked by AppName/DateCreated, logout called, password never in logs
  - Authentik plan/apply (fake HTTP): not superuser, version gate, import calls with the right multipart `context`, readback, add_user, failure stops the run, admin token never stored or logged
  - admin settings API: locked keys, secret write-only (never in GET), probe blocking vs `force`, re-auth for secrets, import-env, generate once, audit has keys only
  - gateway: config fetch, rev header refresh, env wins, 503 without upstream
  - request service off: routes 404 `requests_disabled`, `features.requests` false
- **e2e (mocked API):** wizard happy path (auto and manual), wrong code, locked env step; Admin → Settings: badges, replace/clear secret, move into settings, restart banner; phone + desktop; a11y names.
- **Compose:** CI runs `docker compose -f compose.yaml config` and `-f compose.prod.yaml config` with **no** `.env` (must succeed) and with the old `.env.example` (must succeed).
- **Manual:** fresh stack against Authentik 2026.8.3 and Jellyfin 10.11: `docker compose up`, code from the log, auto Authentik + Jellyfin, first admin login, invite flow works; an existing install upgrades without changes.
- Coverage thresholds hold; new strings in all 7 locales; `grep -ri seerr` over the new locale files is empty.

## Unverified assumptions (to verify in the named task)
- U5 – adapter-node with `ORIGIN=''` behaves as unset.
- U6 – Redis 7 official image honours `user: "999:999"` + `group_add` for reading the conf file (entrypoint does not re-exec with su-exec when not root).
- U7 – `depends_on: service_completed_successfully` in Portainer stacks (needs Compose v2; documented minimum).

Verified (running, Task 13, 2026-10-15, fresh `ghcr.io/goauthentik/server:2026.8.3` + Postgres 16, bootstrap token of `akadmin`, plan → apply with `authentikSetup.ts`, then a second apply):
- U1 – the blueprint import accepts `grant_types: [authorization_code]` and `redirect_uris: [{matching_mode: strict, url: !Format [...]}]`: the provider reads back `grant_types ["authorization_code"]`, `redirect_uris [{matching_mode: strict, url: https://tv.example.com/auth/callback}]`, confidential, `hashed_user_id`, `per_provider`, three scope mappings, implicit-consent authorization flow, `default-provider-invalidation-flow`. A second apply is idempotent (one provider, same client id/secret, same service token).
- U2 – `!Find [authentik_crypto.certificatekeypair, [name, "authentik Self-signed Certificate"]]` resolves (signing key name read back).
- U3 – `PATCH /api/v3/core/brands/<brand_uuid>/ { flow_recovery }` works. `PATCH /api/v3/stages/identification/<pk>/ { recovery_flow }` alone is **refused** (400 "When no user fields are selected, at least one source must be selected": the serializer's `validate()` reads `user_fields`/`sources` from the request only); sending the stage's current `user_fields` and `sources` with it works (implemented so).
- U4 – the import's per-model permission check passes for a superuser token; the readback (`client_secret` visible, `view_key`) works; the saved service token passes the `authentik` probe, the discovery issuer equals `<url>/application/o/friendflix/` (`oidc` probe ok), and a login through the provider with PKCE S256 + client secret via the backend's own `oidc.ts` (Authentik session from the flow executor, authorize → `/auth/callback?code&state`, token exchange) returns `sub`, `email`, `groups` incl. `friendflix-admins` (adminMember) and `auth_time`.
- Found on the way: a path import (`path=example/...`) is validated by a worker task the server waits on for 10 s; a busy worker answers **500 ResultTimeout** (seen on a freshly started instance), so path imports are retried (3 attempts) and blueprint imports get a 60 s deadline (the recovery example took ~17 s). Right after Authentik's first start (until its default blueprints are applied, ~3–4 min here) imports can fail `blueprint_invalid` (`!Find` targets missing); "Try again" then succeeds. A full apply took ~27 s (re-run ~6 s).

Verified (source, 2026-10-14): Authentik 2026.8.3 `managed/blueprints/import/` (multipart `file`/`path` + JSON `context`, synchronous, returns `{logs, success}`), `!Context`/`!Format`/`!Find` tags, `core/tokens/<identifier>/view_key/`, `core/users/me/`, `admin/version/`, `core/groups/<pk>/add_user/ {pk}`, `client_secret` visible to users who may change the provider, `grant_types` default `[]`, default flow slugs and managed scope mapping ids. Jellyfin 10.11.0: `POST /Auth/Keys?app=` (204, elevation), `GET /Auth/Keys` (`AccessToken`, `AppName`, `DateCreated`), `POST /Users/AuthenticateByName`, `POST /Sessions/Logout`, `GET /System/Info/Public` (`StartupWizardCompleted`).

## Phases
1. **25a – Settings store, Admin → Settings, bootstrap volume** (registry, table, resolver, live reload, gateway pull, init container + compose, request service optional, admin API + page, docs). Existing installs only see Admin → Settings.
2. **25b – Wizard and automation** (setup mode + code, media seam + Jellyfin auto, Authentik automation, first admin, wizard UI, docs).

Each phase is its own PR. 25b depends on 25a. Block 23 phase 3 follows 25b.
