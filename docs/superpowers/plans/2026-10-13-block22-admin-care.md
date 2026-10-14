# Block 22 – Admin care: health, library hygiene, user insight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin sees at a glance whether FriendFlix and its dependencies are healthy (traffic lights, disks, errors, transcodes, a banner across the app), which titles in the library need care (info, languages, duplicates, files), and how each account uses the instance (aggregated, no titles).

**Architecture:**
- Backend: one migration (35) for all new tables; an aggregated error log in Redis (`errorlog.ts`); a health snapshot (`health.ts`: parallel probes, `statfs` disks, levels, issue fingerprints) rebuilt by a tick and served from kv; playback recording into `play_daily` plus an active-streams view; a hygiene scanner (`hygiene/rules.ts` pure rules, `hygiene/scan.ts` incremental + weekly full sweep into `hygiene_items`); usage aggregates over `play_seconds` / `play_daily` / `devices`.
- The `MediaServer` seam gets three optional methods: `admin.transcodeSessions?`, `libraryHygiene?`, `refreshMetadata?`; Jellyfin implements all three.
- Web: `/admin/status` becomes the health page; `HealthBanner.svelte` in the root layout for admins; new pages `/admin/hygiene` (Content) and `/admin/usage` (People); the player reports fatal playback errors.

**Tech Stack:** Fastify + zod + Postgres + kv (Redis/Memory) (backend), SvelteKit (legacy syntax) (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-block22-admin-care-design.md`

### Order and model tier

| Task | Depends on | Can run in parallel with | Model |
| --- | --- | --- | --- |
| 1 Schema, config, error log | – | 2 | sonnet |
| 2 Seam `transcodeSessions?` / `libraryHygiene?` / `refreshMetadata?` + Jellyfin | – | 1 | sonnet |
| 3 Health snapshot + banner API | 1 | 4, 5 | opus |
| 4 Playback recording + active streams | 1, 2 | 3, 5 | sonnet |
| 5 Hygiene rules + scanner | 1, 2 | 3, 4 | opus |
| 6 Hygiene admin API | 5 | 7, 8 | sonnet |
| 7 Usage API | 4 | 6, 8 | sonnet |
| 8 Health page (`/admin/status`) + player error report | 3, 4 (contracts) | 6, 7, 10, 11 | sonnet |
| 9 Admin warning banner | 3 (contract) | 10, 11 | sonnet |
| 10 Hygiene page | 6 (contract) | 8, 9, 11 | sonnet |
| 11 Usage page | 7 (contract) | 8, 9, 10 | sonnet |
| 12 Final verification + docs | all | – | sonnet |

Web tasks only need the JSON contracts in the backend tasks' Interfaces and can start once those are written down. They must not merge before their backend task is green. Only Task 1 touches `db.ts` (one migration for the whole block).

## Global Constraints

- Admin-only: every new route uses `requireAdmin(ctx)` (admin role **and** owner profile), CSRF as usual, zod for params/query/body. Non-admins get 403, no session 401.
- Never expose secrets or internals: no media-server token, API key (TMDB/OMDb/request service), URL, file path, IP address or raw exception text in any response, log line written by this block, or the HTML. Reasons are codes the web translates.
- No Docker socket. Disk usage only via `statfs` / `stat` of paths already mounted into the backend (`DOWNLOAD_DIR`, `PREVIEW_DIR`); the database size via SQL.
- Background work only in ticks guarded by `BACKGROUND_JOBS`; no request ever waits for a library scan or a slow probe (except the explicit `?refresh=1`, bounded at 3.5 s).
- New seam methods are optional; absent = feature degrades (documented per task). Neutral DTOs only.
- Privacy: usage is aggregated per account, no titles, no genres; the error log stores no user id, IP or full user agent.
- No new npm dependencies.
- No other brands' look-alikes (Block 19 rules): no logos or brand colours for Jellyfin/TMDB/OMDb/OIDC providers; neutral labels ("Medienserver", "Anmeldung", "Wunsch-Dienst").
- "Seerr" never appears in user-facing text (use the existing "Wunsch-Dienst" / `admin.dash.svc.seerr` wording); code identifiers may keep `seerr`.
- Admin UI uses the kit (`#lib/ui/*`: `StatusPill` with icon + text, `StatTile`, `Progress`, `DataTable`, `Button`, `Select`, `Skeleton`; `#lib/adminContent/AdminCard.svelte`; `runAction`, `confirm`, `toast`). Every list has skeleton / empty / error + retry / content. The shell owns `<h1>` and `<title>`.
- All new UI text in all 7 locales (`web/src/lib/i18n/locales/{de,en,fr,es,it,tr,pl}`; de is the typed source). Page texts go to `adminContent` (health, hygiene) and `adminPeople` (usage); nav labels to `admin.tabs.*`.
- TV mode is unaffected: no banner, no new focus stops, nothing in `html.tv` changes.
- Touch targets ≥ 44 px on phones; no horizontal page overflow at 390 px.
- Commands (from the repo root; kill processes by PID only, never `pkill -f`):
  - `LOCK=/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/b22.lock`
  - backend: `service postgresql start`; `psql -U postgres -h localhost -c 'create database ff_test_b22'` once (password x); `TEST_DATABASE_URL=postgres://postgres:x@localhost:5432/ff_test_b22 npx -w backend vitest run test/<file>`
  - web unit: `npx -w web vitest run src/lib/<path>`
  - build: `flock $LOCK npm run build -w web 2>&1 | tail -4`
  - e2e: `flock $LOCK env E2E_PORT=4282 E2E_SKIP_BUILD=1 PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test -c e2e/playwright.config.ts <spec>`; then delete `e2e/test-results`
  - checks: `npm run lint`, `npm run typecheck`

## Review Focus

1. **A secret or path in a health/hygiene/stream response:** the OIDC probe URL, the gateway URL, `DOWNLOAD_DIR`, a Jellyfin `MediaSources[].Path`, a token in a session's `TranscodingInfo` or an exception message (`fetch failed http://jellyfin:8096/…?api_key=`) must never reach the JSON. Tests in Tasks 2, 3 and 6 grep the serialized responses.
2. **A dismissed banner that never comes back, or one that comes back every minute:** the fingerprint must change with level or reason, never with numbers (disk 85 → 86 %). Test in Task 3.
3. **A request blocked by a scan or probe:** a hanging media server must not slow `/api/admin/health`, the banner or any viewer page; the scan must not run inside a request. Tests in Tasks 3 and 5 (probe that never resolves; banner answers from the snapshot).
4. **Deleting hygiene rows after an incomplete sweep:** a page error mid-sweep or an incremental run must never delete rows of items that still exist. Test in Task 5.
5. **Usage leaking titles:** no title, series name or item id in `/api/admin/usage*` responses, even through device labels of foreign apps. Test in Task 7.
6. **A non-owner profile of an admin account:** an admin's kids/other profile must not get the banner or the APIs. Tests in Tasks 3 and 9.

---

### Task 1: Schema, config and error log (backend)

**Files:**
- Create: `backend/src/errorlog.ts`
- Modify:
  - `backend/src/db.ts`: migration 35 (all Block 22 tables, below)
  - `backend/src/config.ts`: `GATEWAY_URL: z.string().url().default('http://gateway:4000')`, `HEALTH_DISK_WARN_PCT: z.coerce.number().int().min(50).max(99).default(85)`, `HEALTH_DISK_CRIT_PCT: z.coerce.number().int().min(51).max(100).default(95)`, `HEALTH_DB_WARN_GB: z.coerce.number().positive().default(10)`
  - `backend/test/helpers.ts` (`cfg`): the four new keys with their defaults
  - `.env.example`, `compose.yaml`, `compose.prod.yaml`: commented `GATEWAY_URL`, `HEALTH_*`
  - `backend/src/clientErrors.ts`: kind `playback` with optional `itemId` (`/^[0-9a-f]{32}$/`) and `code` (≤ 60, `/^[\w.:-]+$/`); every accepted report also goes to `recordError`
  - `backend/src/app.ts`: `onResponse` hook → `recordError(ctx, { source: 'server', code: method + ' ' + (routeOptions.url ?? 'unmatched') + ' ' + status })` for status ≥ 500 (never `req.url`)
  - `backend/src/server.ts`: every background `catch` (preview warm, download prep/gc, playback check, digest, poll, reminder, leaving, session poll) also calls `recordError(ctx, { source: 'job', code: '<job name>' })`
  - `backend/src/routes/admin.ts`: `GET /api/admin/errors`
- Test: `backend/test/errorlog.test.ts`, extend `backend/test/client-errors.test.ts`

**Migration 35:**
```sql
create table play_daily (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  device_id text not null default '',
  streams int not null default 0,
  transcodes int not null default 0,
  reasons jsonb not null default '{}',
  primary key (user_id, day, device_id)
);
create index play_daily_day on play_daily(day);
create table hygiene_items (
  item_id text primary key,
  type text not null check (type in ('Movie','Series','Episode')),
  name text not null,
  series_id text,
  series_name text,
  year int,
  facts jsonb not null,
  issues text[] not null default '{}',
  ids_key text,
  title_key text,
  episode_key text,
  scanned_at timestamptz not null default now()
);
create index hygiene_items_issues on hygiene_items using gin(issues);
create index hygiene_items_type on hygiene_items(type);
create index hygiene_items_series on hygiene_items(series_id) where series_id is not null;
create index hygiene_items_ids on hygiene_items(ids_key) where ids_key is not null;
create index hygiene_items_title on hygiene_items(title_key) where title_key is not null;
create index hygiene_items_episode on hygiene_items(episode_key) where episode_key is not null;
create table hygiene_ignored (
  item_id text not null,
  code text not null,
  by_user uuid references users(id) on delete set null,
  at timestamptz not null default now(),
  primary key (item_id, code)
);
create table health_dismissals (
  user_id uuid not null references users(id) on delete cascade,
  issue_id text not null,
  fp text not null,
  at timestamptz not null default now(),
  primary key (user_id, issue_id)
);
```

**Interfaces:**
- Produces (`errorlog.ts`):
  - `type ErrorSource = 'server' | 'client' | 'playback' | 'job'`
  - `interface ErrorEntry { source: ErrorSource; code: string; count: number; firstAt: string; lastAt: string; release?: string; sample?: string; itemId?: string }`
  - `recordError(ctx: Pick<Ctx,'kv'|'cfg'>, e: { source: ErrorSource; code: string; sample?: string; itemId?: string; release?: string }): Promise<void>`
    - key `errlog:<source>:<sha1(code + itemId).slice(0,16)>`, value JSON, TTL 7 days (`604800`), refreshed on each hit; per-15-min bucket counter `errlog:b:<source>:<floor(now/900s)>` (TTL 2 h) for the health levels.
    - At most 300 fingerprint keys (`kv.keys('errlog:')` count cached 60 s in-process); beyond that only `errlog:overflow` is incremented.
    - `code` and `sample` pass through `scrub()` from `clientErrors.ts` and are cut to 120 / 300 chars. Never throws (errors swallowed).
  - `listErrors(ctx, opts: { since?: Date; source?: ErrorSource; limit?: number }): Promise<{ entries: ErrorEntry[]; overflow: number }>` sorted by `lastAt` desc.
  - `recentCount(ctx, source: ErrorSource, minutes: 15 | 60): Promise<number>` from the bucket counters.
- Route: `GET /api/admin/errors?source=&hours=24` (hours 1–168) → `{ entries: ErrorEntry[]; overflow: number }`.

- [ ] **Step 1: Write failing tests:**
  - `migration 35 applies on a fresh db and on a db at 34 (tables + indexes exist)`
  - `a 500 from a route with an id param records "GET /api/items/:id 500", never the concrete id or query`
  - `two identical client errors → one entry with count 2; message with ?token=abc and an e-mail is scrubbed in sample`
  - `playback report {kind:'playback', itemId, code:'bufferStalledError'} → 204 and entry source playback with itemId; bad itemId → 400`
  - `entry has no user id, ip or user agent field (JSON.stringify contains none of the test values)`
  - `301st fingerprint → not stored, overflow 1`
  - `kv ttl of an entry ≈ 604800; recentCount(server, 15) counts only the last 15 min buckets`
  - `job failure in a tick catch records source job with the job name`
  - `GET /api/admin/errors: admin 200 sorted by lastAt; friend 403; admin on a non-owner profile 403; no session 401`
- [ ] **Step 2:** Run `test/errorlog` and `test/client-errors` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS; run the full backend suite (the `cfg` and migration change touch every test).
- [ ] **Step 5:** `git commit -m "feat(admin): Block 22 schema, health config and aggregated error log"`

### Task 2: Seam – `transcodeSessions?`, `libraryHygiene?`, `refreshMetadata?` (Jellyfin)

**Files:**
- Modify:
  - `backend/src/media/types.ts`: new DTOs and three optional methods (block comment "Block 22 (optional): admin care")
  - `backend/src/jellyfin/service.ts`: implement all three
  - `backend/src/jellyfin/dto.ts`: `toServerSession(raw)`, `toHygieneFacts(raw)`, export the existing `REASON_MAP` mapping as `mapTranscodeReasons(raw: string[]): TranscodeReason[]`
  - `backend/src/jellyfin/client.ts`: `sessions()` unchanged; add `allSessions()` (`/Sessions?activeWithinSeconds=30`, no `ff-` filter)
  - `docs/architecture.md`: seam table rows
- Test: `backend/test/media-admincare-seam.test.ts`

**Interfaces:**
- Produces (in `media/types.ts`):
  ```ts
  interface ServerSession {
    sessionId: string; serverUserId: string;
    /** raw device id as the server knows it ('ff-<deviceId>' for FriendFlix devices) */
    deviceId?: string; client?: string; deviceName?: string;
    item: { id: string; name: string; seriesName?: string; type?: string };
    playSessionId?: string;
    playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
    reasons: TranscodeReason[]; videoCodec?: string; audioCodec?: string; hardware?: boolean;
    bitrate?: number; progressPct?: number; paused: boolean;
  }
  interface HygieneStream { codec?: string; lang?: string; forced?: boolean; text?: boolean; channels?: number; bitDepth?: number; height?: number; hdr?: boolean }
  interface HygieneSource { container?: string; bitrate?: number; sizeBytes?: number; runtimeTicks?: number; video: HygieneStream[]; audio: HygieneStream[]; subtitles: HygieneStream[] }
  interface HygieneFacts {
    id: string; type: 'Movie' | 'Series' | 'Episode'; name: string;
    seriesId?: string; seriesName?: string; season?: number; episode?: number; year?: number;
    overview: boolean; poster: boolean; backdrop: boolean; providerIds: ProviderIds;
    runtimeTicks?: number; virtual: boolean; sources: HygieneSource[];
  }
  ```
  - `MediaAdmin.transcodeSessions?(): Promise<ServerSession[]>`: every session that plays something, FriendFlix devices included.
  - `MediaServer.libraryHygiene?(type: 'Movie' | 'Series' | 'Episode', page: { start: number; limit: number; savedSince?: string }): Promise<HygieneFacts[]>`: admin key, stable order, short page = end. `savedSince` (ISO) = only items saved at or after it.
  - `MediaServer.refreshMetadata?(id: string): Promise<void>`: admin key; `MediaError(404)` for an unknown id.
- Jellyfin:
  - `transcodeSessions`: `allSessions()`; `PlayState.PlayMethod`, `PlayState.PlaySessionId` when present, `TranscodingInfo.{VideoCodec, AudioCodec, HardwareAccelerationType (non-empty → hardware), Bitrate, CompletionPercentage, TranscodeReasons}` → `mapTranscodeReasons`; `Client`, `DeviceName`, `DeviceId`.
  - `libraryHygiene`: `/Items?recursive=true&includeItemTypes=<type>&fields=Overview,ProviderIds,MediaSources,ProductionYear,PremiereDate,SeriesId&enableUserData=false&enableImageTypes=Primary,Backdrop&imageTypeLimit=1&sortBy=SortName,Id&sortOrder=Ascending&startIndex&limit` plus `minDateLastSaved=<savedSince>` when given. `ImageTags.Primary` → poster, `BackdropImageTags.length` → backdrop; `LocationType === 'Virtual'` → virtual; per source: `Container`, `Bitrate`, `Size`, `RunTimeTicks`, `MediaStreams` split by `Type` (`Codec`, `Language`, `IsForced`, `IsTextSubtitleStream`, `Channels`, `BitDepth`, `Height`, `VideoRange !== 'SDR'` → hdr). `Path`, `Protocol` and URLs are never read into the DTO.
  - `refreshMetadata`: `POST /Items/{id}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=FullRefresh&replaceAllMetadata=false&replaceAllImages=false` (admin key).

- [ ] **Step 1: Write failing tests** (fake Jellyfin as in `scenes17.test.ts`):
  - `transcodeSessions maps PlayMethod, reasons (VideoCodecNotSupported → videoCodec, unknown → other), codecs, hardware, progress; includes ff- devices`
  - `transcodeSessions DTO never contains the access token, a URL or a path (fake session has TranscodingInfo with a URL and a Path; JSON.stringify contains neither)` (Review Focus 1)
  - `libraryHygiene maps overview/poster/backdrop/year/providerIds/virtual and per-source streams (forced, text, bitDepth, hdr)`
  - `libraryHygiene passes minDateLastSaved only when savedSince is set; sortBy SortName,Id`
  - `libraryHygiene DTO has no Path (fake item has MediaSources[0].Path '/mnt/media/x.mkv')` (Review Focus 1)
  - `refreshMetadata posts to /Items/<id>/Refresh with the admin key; 404 → MediaError(404)`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also `test/media-seam`, `test/transcode-reason`, `test/nowplaying-privacy`.
- [ ] **Step 5:** `git commit -m "feat(seam): optional transcodeSessions, libraryHygiene and refreshMetadata (Jellyfin)"`

### Task 3: Health snapshot + banner API (backend)

**Files:**
- Create: `backend/src/health.ts` (probes, disks, levels, issues, snapshot, tick), `backend/src/routes/health.ts` (registered in `app.ts`)
- Modify: `backend/src/server.ts` (`healthTick` every 60 s with `BACKGROUND_JOBS`, once at start), `backend/src/routes/admin.ts` (`/api/admin/summary` `services` reads the snapshot when fresh, else today's calls)
- Test: `backend/test/health.test.ts`

**Interfaces:**
- Consumes: `recentCount` (Task 1), `sourceStatus`, `PAUSE_KEY`, `OMDB_DAILY_BUDGET` (`sources/keys.ts`), `ctx.seerr.requestCount`, `ctx.jf.admin.ping`.
- Produces (exported from `health.ts`; the web mirrors it in Tasks 8 and 9):
  ```ts
  type Level = 'ok' | 'warn' | 'err' | 'off';
  type ServiceId = 'media' | 'postgres' | 'redis' | 'gateway' | 'oidc' | 'requests' | 'tmdb' | 'omdb' | 'playbackCheck';
  type Reason = 'slow' | 'down' | 'issuer_mismatch' | 'invalid_key' | 'paused' | 'budget' | 'not_set' | 'failed_titles' | 'unavailable' | 'full' | 'low_free' | 'cap' | 'large' | 'server_errors' | 'client_errors' | 'failed_playbacks';
  interface ServiceHealth { id: ServiceId; level: Level; reason?: Reason; ms?: number; detail?: { n?: number; pct?: number } }
  interface DiskHealth { id: 'downloads' | 'previews' | 'database'; level: Level; reason?: Reason; totalBytes?: number; freeBytes?: number; usedPct?: number; ownBytes: number; capBytes?: number; sharedWith?: 'downloads' | 'previews' }
  interface ErrorHealth { level: Level; reason?: Reason; server15: number; client15: number; playback60: number }
  interface HealthIssue { id: string; level: 'warn' | 'err'; reason: Reason; fp: string; detail?: { n?: number; pct?: number } }
  interface HealthSnapshot { at: string; services: ServiceHealth[]; disks: DiskHealth[]; errors: ErrorHealth; issues: HealthIssue[]; worst: Level }
  ```
  - `buildSnapshot(ctx, deps?: { fetchImpl?; statfs?; stat? }): Promise<HealthSnapshot>`: all probes in parallel, each wrapped in a 3 s timeout; a throw = that probe's `err`/`warn` state.
  - Levels as in the spec table § 1.1 / 1.2 / 1.3. OIDC result cached 5 min in kv `health:oidc`.
  - `issueFp(id, level, reason) = sha1(id + '|' + level + '|' + reason).slice(0, 12)`; numbers are **not** part of it (Review Focus 2).
  - Issue ids: `svc:<ServiceId>`, `disk:<id>`, `errors:server|client|playback`.
  - `getSnapshot(ctx, { refresh?: boolean }): Promise<HealthSnapshot>`: kv `health:snap` (TTL 300); older than 90 s → return it and rebuild in the background (single flight per process); missing → build (bounded by the 3 s probe timeout); `refresh` → build and wait.
  - `healthTick(ctx)`: builds and stores; never throws; prunes `health_dismissals` older than 30 days once per hour.
- Routes (all `requireAdmin`):
  - `GET /api/admin/health?refresh=1` → `HealthSnapshot` (`refresh` rate limit 6/min per session)
  - `GET /api/admin/health/banner` → `{ issues: HealthIssue[]; worst: Level }`: snapshot issues minus this admin's dismissals with the same `(issue_id, fp)`; sorted err first, then by id
  - `POST /api/admin/health/dismiss` body `{ id: string (≤ 40, /^[a-z]+:[a-z]+$/), fp: string (/^[0-9a-f]{12}$/) }` → `{ ok: true }` (upsert)

- [ ] **Step 1: Write failing tests** (fake fetch for gateway/OIDC via `ctxPatch`, injected `statfs`/`stat`):
  - `all ok → worst ok, no issues`
  - `media ping 2.5 s → warn slow; ping throws → err down; a ping that never resolves → err down after ~3 s (fake timers)` (Review Focus 3)
  - `gateway /health 503 → err; OIDC issuer mismatch → err issuer_mismatch; OIDC fetched once in 5 min (fetch count)`
  - `request service down → warn (never err)`
  - `tmdb not set → off; invalid → warn invalid_key; paused → warn paused; omdb usedToday 820/900 → warn budget`
  - `last playback check with 2 failed → warn failed_titles detail n 2`
  - `disk: 86 % → warn full; 96 % → err full; free < DOWNLOAD_MIN_FREE_GB → err low_free; downloads ≥ 90 % of cap → warn cap; same dev → one entry with sharedWith; missing dir → off unavailable; downloads disabled → no downloads entry`
  - `database size above HEALTH_DB_WARN_GB → warn large`
  - `errors: 10 server 5xx in 15 min → warn server_errors; 3 playback failures in 60 min → warn failed_playbacks; never err`
  - `fp equal for 85 % and 86 % (both warn full); differs for warn → err` (Review Focus 2)
  - `snapshot JSON never contains GATEWAY_URL, OIDC_ISSUER, DOWNLOAD_DIR, PREVIEW_DIR or an exception message` (Review Focus 1)
  - `stale snapshot (100 s) → served at once, one background rebuild for 3 concurrent calls`
  - `banner: dismissed (id, fp) hidden for that admin only; level change → shown again; other admin still sees it`
  - `dismiss validation: bad id/fp → 400; friend 403; admin on a non-owner profile 403 on all three routes` (Review Focus 6)
  - `refresh=1 seventh call within a minute → 429`
- [ ] **Step 2:** Run `test/health` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also `test/admin-summary`, `test/status`.
- [ ] **Step 5:** `git commit -m "feat(admin): health snapshot with traffic lights, disks, error levels and banner API"`

### Task 4: Playback recording + active streams (backend)

**Files:**
- Create: `backend/src/playstats.ts`
- Modify:
  - `backend/src/live.ts`: optional `playMethod?: 'direct' | 'remux' | 'transcode'`, `transcodeReason?: TranscodeReason`, `deviceId?: string` on `Live`
  - `backend/src/routes/media.ts`: after `/api/playback/info` store `pbinfo:<userId>:<playSessionId>` = `{ reason }` (TTL 21600); on `Playing` set the live fields (method from `playMethod` + stored reason, device from `req.session.deviceId`)
  - `backend/src/routes/internal.ts` `pollJellyfinSessions`: a foreign session seen for the first time (no live key yet) counts one stream for its user with `device_id = 'app:' + client` (client cut to 40 chars, `[\w .-]` only)
  - `backend/src/achievements.ts` `wireStats` or a new `wirePlayStats(ctx)` in `playstats.ts` registered next to it: on `Playing` → `recordStream`
  - `backend/src/routes/admin.ts`: `GET /api/admin/streams`
- Test: `backend/test/playstats.test.ts`

**Interfaces:**
- Produces:
  - `methodOf(playMethod: string | undefined, reason: TranscodeReason | undefined): 'direct' | 'remux' | 'transcode'`: `DirectPlay` → direct; `Transcode` with a reason → transcode; otherwise remux.
  - `recordStream(ctx, userId: string, deviceId: string, method, reason?: TranscodeReason): Promise<void>`: upsert into `play_daily` for `current_date`; `transcodes += 1` and `reasons[reason] += 1` only for `transcode`.
  - Route `GET /api/admin/streams` (`requireAdmin`) →
    ```ts
    { streams: Array<{ userId: string | null; userName: string | null; profileName: string | null; device: string | null; title: string; seriesName: string | null;
                       source: 'portal' | 'app'; method: 'direct' | 'remux' | 'transcode' | null; reason: TranscodeReason | null;
                       videoCodec: string | null; audioCodec: string | null; hardware: boolean | null; paused: boolean }>;
      totals: { direct: number; remux: number; transcode: number };
      details: boolean;            // false when transcodeSessions is absent or failed
      failed: Array<{ itemId: string; title: string | null; count: number; lastAt: string; code: string }>; }  // playback errors 24 h
    ```
    - Portal live entries are enriched from `transcodeSessions()` by `playSessionId`, else by `ff-<deviceId>` + item id; foreign sessions come only from `transcodeSessions()` (fallback: `listLive` entries with `source: 'jellyfin'`).
    - `device` = the FriendFlix device label (`devices.label`) or `client · deviceName` for apps.
    - `failed` = `listErrors({ source: 'playback', since: 24 h })` grouped by `itemId`; `title` from `hygiene_items.name` when known, else null.
    - One `transcodeSessions()` call per request, 3 s timeout, memo 5 s.

- [ ] **Step 1: Write failing tests:**
  - `methodOf: DirectPlay → direct; Transcode + videoCodec → transcode; Transcode without reason → remux; undefined → remux`
  - `info then start: play_daily row for (user, today, device) streams 1, transcodes 1, reasons {videoCodec:1}`
  - `direct start → streams 1, transcodes 0; progress and stop do not count again`
  - `prefetched info without a start → no row` (Block 20 prefetch must not count)
  - `foreign Jellyfin session seen twice by the poller → counted once, device 'app:Infuse'`
  - `streams: portal transcode enriched with codecs/hardware from transcodeSessions; transcodeSessions throws → details false, method from live`
  - `streams: failed playbacks grouped by item with count and title from hygiene_items`
  - `streams JSON has no token, URL or path` (Review Focus 1); `friend 403`
- [ ] **Step 2:** Run `test/playstats` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also `test/progress`, `test/playback-resume`, `test/nowplaying-privacy`, `test/remote-cap`.
- [ ] **Step 5:** `git commit -m "feat(admin): record streams and transcodes per day, active streams with play method"`

### Task 5: Hygiene rules + scanner (backend)

**Files:**
- Create: `backend/src/hygiene/rules.ts` (pure), `backend/src/hygiene/scan.ts` (tick, upsert, duplicates, language recompute)
- Modify: `backend/src/server.ts` (`hygieneTick` every 30 min with `BACKGROUND_JOBS`, once 2 min after start), `backend/src/media/events.ts` (`itemAdded` → `hygieneSoon()` debounced 2 min; `itemRemoved` → delete the row)
- Test: `backend/test/hygiene-rules.test.ts`, `backend/test/hygiene-scan.test.ts`

**Interfaces:**
- Consumes: `ctx.jf.libraryHygiene?` (Task 2), `normLang` (`langindex.ts`), `instanceLanguage` (`i18n.ts`), `recordError` (Task 1).
- Produces (`rules.ts`):
  - `type IssueCode = 'no_overview' | 'no_poster' | 'no_backdrop' | 'no_year' | 'no_ids' | 'no_audio' | 'audio_unknown' | 'foreign_no_subs' | 'forced_only' | 'image_subs_only' | 'dup_ids' | 'dup_title' | 'dup_episode' | 'no_source' | 'zero_runtime' | 'heavy_bitrate' | 'hevc_10bit' | 'video_codec' | 'audio_codec'`
  - `type Category = 'info' | 'language' | 'duplicate' | 'file'`; `CATEGORY: Record<IssueCode, Category>`; `SEVERITY: Record<IssueCode, 'warn' | 'info'>`
  - `HEAVY_BPS = 40_000_000`; `OK_VIDEO = ['h264','hevc','vp9','av1']`; `OK_AUDIO = ['aac','mp3','ac3','eac3','opus','flac']`
  - `itemIssues(f: HygieneFacts, langs: ReadonlySet<string>): IssueCode[]` (no duplicate codes; those come from SQL). File and language rules flag only when **every** source has the problem.
  - `keysOf(f: HygieneFacts): { ids: string | null; title: string | null; episode: string | null }`
    - ids: `type + ':tmdb:' + id` (else `':imdb:'`), only for valid ids (`/^\d{1,9}$/`, `/^tt\d{7,10}$/`)
    - title: Movie/Series `type + ':' + normalised name + ':' + year` (lower case, NFKD, strip diacritics and non-alphanumerics); null without year
    - episode: `seriesId + ':' + season + ':' + episode` when both numbers exist
  - `compactFacts(f: HygieneFacts): object`: what is stored in `facts` (no name duplication, streams reduced to the fields used by the rules)
- Produces (`scan.ts`):
  - `householdLanguages(ctx): Promise<Set<string>>` (instance language + `user_prefs` / `profile_prefs` `audioLang`, `subtitleLang`, `language`), via `normLang`; `langsFp` = sorted join.
  - `hygieneTick(ctx, opts?: { full?: boolean; now?: Date }): Promise<void>`: never throws; one run per process (`busy`).
    - Full when `opts.full`, no `hygiene:lastFull` in kv, or older than 7 days; else incremental with `savedSince = hygiene:lastStart − 5 min`.
    - Types Movie, Series, Episode; pages of 200 (`PAGE`), `await sleep(200)` between pages, upsert each page at once (`insert … on conflict (item_id) do update`, `scanned_at = runStart`).
    - After the run: duplicates recomputed in SQL (remove the three `dup_*` codes everywhere, then add them to rows whose key occurs ≥ 2 times); only a **complete full** run deletes rows with `scanned_at < runStart` (Review Focus 4); store `hygiene:lastStart`, `hygiene:lastFull`, `hygiene:lastDone` (ISO) and drop `hygiene:summary`.
    - When `langsFp` differs from kv `hygiene:langs`: recompute the language codes of every row from `facts` in batches of 1000 (no server calls).
    - A page error: `recordError({ source: 'job', code: 'hygiene' })`, stop, keep rows.
    - Without `libraryHygiene`: return at once.
  - `hygieneState(ctx): Promise<{ supported: boolean; running: boolean; lastDone: string | null; lastFull: string | null }>`
  - `startHygieneScan(ctx): boolean` (full; false while running)

- [ ] **Step 1: Write failing tests:**
  - rules (fixtures per code):
    - `movie without overview / poster / backdrop / year / ids → each code; series likewise; episode → none of the info codes`
    - `no audio stream → no_audio; all audio und → audio_unknown`
    - `langs {deu}: English-only audio + German full subs → none; English-only + only forced German subs → forced_only + foreign_no_subs; English-only + German PGS only → image_subs_only; English-only + no subs → foreign_no_subs; German audio → none`
    - `ger and deu are the same language (normLang)`
    - `two versions, one 4K HEVC 10-bit and one 1080p h264 → no hevc_10bit; both HEVC 10-bit → hevc_10bit`
    - `bitrate 45 Mbit/s → heavy_bitrate; mpeg2 → video_codec; only DTS + TrueHD → audio_codec; DTS + AC3 → none`
    - `virtual or no source → no_source; runtime 0 → zero_runtime`
    - `keysOf: "Amélie" 2001 and "amelie" 2001 → same title key; invalid tmdb "12a" → ids from imdb; neither → null`
  - scan (fake `libraryHygiene` on `ctx.jf`):
    - `first run is full: rows for all items, issues set, lastFull stored`
    - `second run within 7 days is incremental and passes savedSince = lastStart − 5 min`
    - `duplicates: two movies with tmdb 603 → both dup_ids; same series/season/episode → dup_episode; after one is removed and a full run → neither`
    - `incremental run does not delete untouched rows; full run that fails on page 3 deletes nothing` (Review Focus 4)
    - `itemRemoved event deletes the row; itemAdded schedules one early tick for 5 events within 2 min`
    - `profile pref subtitleLang 'tur' added → next tick recomputes language issues without calling libraryHygiene`
    - `50 000 fake items (250 pages): completes, rows 50 000, heap growth < 50 MB, a concurrent admin request to /api/admin/health answers < 200 ms` (Review Focus 3)
    - `server without libraryHygiene → no calls, hygieneState.supported false`
- [ ] **Step 2:** Run both tests → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also `test/langindex`, `test/media-hooks`.
- [ ] **Step 5:** `git commit -m "feat(admin): library hygiene rules and incremental scanner"`

### Task 6: Hygiene admin API (backend)

**Files:**
- Create: `backend/src/routes/hygiene.ts` (registered in `app.ts`)
- Test: `backend/test/hygiene-api.test.ts`

**Interfaces:**
- Consumes: Task 5 (`hygieneState`, `startHygieneScan`, `CATEGORY`, `SEVERITY`), `ctx.jf.refreshMetadata?`, `audit`.
- Produces (web mirrors it in Task 10):
  ```ts
  interface HygieneSummary { state: { supported: boolean; running: boolean; lastDone: string | null; lastFull: string | null };
    total: number; byCategory: Record<'info' | 'language' | 'duplicate' | 'file', number>; byIssue: Partial<Record<IssueCode, number>>; ignored: number; canRefresh: boolean }
  interface HygieneRow { itemId: string; type: 'Movie' | 'Series' | 'Episode'; name: string; seriesId: string | null; seriesName: string | null; year: number | null;
    issues: Array<{ code: IssueCode; severity: 'warn' | 'info' }>; versions: number; container: string | null; bitrate: number | null; sizeBytes: number | null;
    video: string | null;   // e.g. "hevc 10-bit 2160p HDR"
    audio: string[];        // e.g. ["eng dts 6ch"]
    subtitles: string[];    // e.g. ["deu forced", "eng pgs"]
    dupOf: string[] }       // other item ids with the same dup key (≤ 5)
  ```
  - `GET /api/admin/hygiene/summary` → `HygieneSummary` (cached 60 s in kv `hygiene:summary`)
  - `GET /api/admin/hygiene?category=&issue=&type=&seriesId=&q=&sort=name|issues|size|bitrate&dir=&limit=(1–200, default 50)&offset=` → `{ items: HygieneRow[]; total: number }`; only rows with at least one non-ignored issue; ignored codes are removed from `issues`
  - `POST /api/admin/hygiene/ignore` `{ itemId, code }` → `{ ok: true }`; `DELETE /api/admin/hygiene/ignore` same body (Undo); audit `hygiene.ignore` / `hygiene.unignore` with meta `{ code }`
  - `POST /api/admin/hygiene/:itemId/refresh` → `{ ok: true }` or 404 / 501 `{ error: 'unsupported' }`; rate limit 30/min; audit `hygiene.refresh`
  - `POST /api/admin/hygiene/scan` → `{ started: boolean }`; rate limit 2/10 min; audit `hygiene.scan`

- [ ] **Step 1: Write failing tests** (seed `hygiene_items` directly):
  - `summary counts per category and issue; ignored excluded and counted in ignored`
  - `filter category=language returns only rows with a language issue; issue=dup_ids; type=Episode&seriesId=…; q matches name and series name (ilike, escaped)`
  - `sort size desc, paging limit/offset and total`
  - `row strings: video "hevc 10-bit 2160p HDR", audio "eng dts 6ch", subtitles "deu forced"`
  - `row JSON never has a path, even when facts were seeded with a path key` (Review Focus 1)
  - `ignore → the row drops out when it was its only issue; unignore brings it back; audit entries without names`
  - `refresh calls refreshMetadata once; server without it → 501 unsupported; unknown id → 404`
  - `scan while running → started false; third call in 10 min → 429`
  - `friend 403; admin on a non-owner profile 403; bad issue code → 400`
- [ ] **Step 2:** Run `test/hygiene-api` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat(admin): library hygiene API (list, summary, ignore, refresh, scan)"`

### Task 7: Usage API (backend)

**Files:**
- Create: `backend/src/routes/usage.ts` (registered in `app.ts`)
- Test: `backend/test/usage.test.ts`

**Interfaces:**
- Consumes: `play_seconds`, `play_daily` (Task 4), `devices`, `users`, `listLive`.
- Produces (web mirrors it in Task 11):
  ```ts
  interface UsageRow { userId: string; name: string; role: string; disabled: boolean; lastSeen: string | null;
    seconds: number; movieSeconds: number; seriesSeconds: number; titles: number;
    streams: number; transcodes: number; topReason: TranscodeReason | null;
    devices: number; devicesUsed: number; liveNow: number }
  interface UsageDetail { userId: string; days: Array<{ day: string; seconds: number }>;   // every day of the period, zeros included
    devices: Array<{ label: string; lastSeen: string | null; streams: number; transcodes: number; app: boolean }>;
    reasons: Partial<Record<TranscodeReason, number>>; since: string | null }               // first play_daily day overall
  ```
  - `GET /api/admin/usage?days=7|30|90&sort=name|seconds|streams|transcodes|lastSeen&dir=` → `{ users: UsageRow[]; since: string | null }` (cached 60 s per `days`)
  - `GET /api/admin/usage/:userId?days=` → `UsageDetail`; 404 for an unknown user
  - `titles` is a count (`count(distinct coalesce(series_name, item_name))`); no field carries a title, series name or item id (Review Focus 5).
  - App devices (`device_id` starting with `app:`) are labelled by the client part only.

- [ ] **Step 1: Write failing tests:**
  - `30 days: seconds, movie vs series split, titles count, streams, transcodes, topReason from play_daily reasons`
  - `period 7 excludes older rows; days array has 7 entries with zeros`
  - `devices: approved count, devicesUsed from play_daily in the period, labels from devices; app:Infuse → label "Infuse", app true`
  - `lastSeen = max devices.last_seen; liveNow from listLive`
  - `no response contains a seeded title, series name or item id (JSON.stringify check)` (Review Focus 5)
  - `disabled users listed with disabled true; sort streams desc`
  - `friend 403; admin on a non-owner profile 403; bad days → 400; unknown user 404`
- [ ] **Step 2:** Run `test/usage` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; then the full backend suite.
- [ ] **Step 5:** `git commit -m "feat(admin): aggregated per-user usage API"`

### Task 8: Health page (`/admin/status`) + player error report (web)

**Files:**
- Create:
  - `web/src/lib/admin/health.ts`: types mirroring `HealthSnapshot`, `/api/admin/streams` and `ErrorEntry`; `loadHealth(refresh?)`; pure helpers `levelTone(l: Level): Tone` (ok → ok, warn → warn, err → err, off → muted), `reasonKey(id, reason): TKey`, `sortServices(s)` (err, warn, ok, off; stable)
  - `web/src/lib/admin/health.test.ts`
  - `web/src/lib/admin/ServiceLights.svelte`, `DiskCard.svelte`, `StreamsCard.svelte`, `ErrorsCard.svelte`
  - `e2e/tests/admin-health.spec.ts`, `e2e/tests/admin-health.mobile.spec.ts`
- Modify:
  - `web/src/routes/admin/status/+page.svelte`: sections in this order: services (traffic lights, "Jetzt prüfen" → `?refresh=1`), disks, errors & streams (active streams with method/reason chips, failed playbacks with links to `/item/<id>`, top errors of 24 h with source, count, last seen, release), numbers (as today). Polls the snapshot every 30 s and streams every 10 s while visible.
  - `web/src/routes/admin/+page.svelte`: the overview health strip reads `/api/admin/health` (worst per service) with the existing tiles unchanged
  - `web/src/lib/telemetry.ts`: `reportPlayback(itemId: string, code: string)` (kind `playback`, same dedupe/limits)
  - `web/src/lib/Player.svelte`: call `reportPlayback` on a fatal hls.js error and on a `<video>` `MediaError` that ends playback (once per play session)
  - i18n `adminContent.health.*` in 7 locales: service names (`media` "Medienserver", `oidc` "Anmeldung", `requests` "Wunsch-Dienst", `gateway` "Medien-Gateway", …), level texts, every reason, disk labels and sentences ("{used} von {total} belegt · {pct} %", "davon FriendFlix {own}"), streams (direct / remux / transcode, reason texts reuse `player.*` transcode reason texts where they exist), errors (sources, "zuletzt {time}", empty states)
  - `e2e/mocks/admin.ts`: `/api/admin/health`, `/api/admin/streams`, `/api/admin/errors`
- Test: as listed; extend `web/src/lib/telemetry.test.ts`

**Interfaces:**
- Consumes: Task 3 `HealthSnapshot`, Task 4 streams payload, Task 1 `ErrorEntry`.

- [ ] **Step 1: Write failing tests:**
  - unit: `levelTone maps all four; sortServices puts err before warn before ok before off; reasonKey covers every Reason (exhaustive over a list)`
  - unit: `reportPlayback sends kind playback with itemId and code; identical report within 60 s deduped`
  - e2e:
    - `services: media red "Nicht erreichbar", TMDB yellow "Schlüssel ungültig", OMDb off "Nicht eingerichtet"; every pill has icon + text`
    - `Jetzt prüfen calls ?refresh=1 once and shows the new state`
    - `disks: downloads 93 % warn with "davon FriendFlix", database size only; shared volume shown once`
    - `streams: transcode row shows reason "Videoformat" and "Hardware"; details false → muted hint`
    - `failed playbacks link to /item/<id>; errors list shows source and count`
    - `page HTML contains no "http://" from the mocks' internal fields` (Review Focus 1)
    - `overview strip uses the snapshot (media red there too)`
    - mobile: `no horizontal overflow; buttons ≥ 44 px`
- [ ] **Step 2:** Locked build + run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Locked build; run the new specs plus `admin-shell*`, `admin-content*`, `telemetry`, `player-controls` → PASS. Run `npx -w web vitest run src/lib/i18n src/lib/admin src/lib/telemetry.test.ts`.
- [ ] **Step 5:** `git commit -m "feat(admin): health page with traffic lights, disks, streams and errors; player reports fatal errors"`

### Task 9: Admin warning banner (web)

**Files:**
- Create:
  - `web/src/lib/admin/HealthBanner.svelte`
  - `web/src/lib/admin/banner.ts`: `bannerView(issues: HealthIssue[]): { first: HealthIssue | null; more: number; level: 'warn' | 'err' | null }`; `issueText(i): string` (via `tr`, with `detail.pct` / `detail.n`); store + `startBanner()` (poll 60 s while `document.visibilityState === 'visible'`, refresh on `visibilitychange`), `dismiss(i)` (optimistic remove, `POST /api/admin/health/dismiss`, rollback on error)
  - `web/src/lib/admin/banner.test.ts`
  - `e2e/tests/admin-banner.spec.ts`, `e2e/tests/admin-banner.mobile.spec.ts`
- Modify:
  - `web/src/routes/+layout.svelte`: mount `<HealthBanner />` under the app bar when `admin && !tv && !watchPage && !profilesPage && !publicPage`; start/stop the poll with that condition
  - i18n `admin.banner.*` in 7 locales: one sentence per `id × reason` family ("Medienserver nicht erreichbar", "Download-Speicher fast voll ({pct} %)", "TMDB-Schlüssel ungültig", "{n} Wiedergaben fehlgeschlagen" …), "+{n} weitere", "Ansehen", "Ausblenden"
  - `e2e/mocks/api.ts`: default `GET /api/admin/health/banner` → `{ issues: [], worst: 'ok' }` for admin fixtures
- Test: as listed

**Interfaces:**
- Consumes: Task 3 `GET /api/admin/health/banner`, `POST /api/admin/health/dismiss`, `HealthIssue`.
- UI: a slim bar (`--tone-warn` / `--tone-err` background), icon + one sentence for the worst issue, "+2 weitere" toggles a short list of the rest (each with its own close button), "Ansehen" link to `/admin/status`, close button `aria-label="Ausblenden"` ≥ 44 px. `role="status"`; a red issue first seen in this page view uses `role="alert"` once.

- [ ] **Step 1: Write failing tests:**
  - unit: `bannerView: err before warn; more = rest count; empty → level null`; `issueText for disk:downloads warn full with pct 93 → "Download-Speicher fast voll (93 %)"`
  - e2e:
    - `admin sees the banner on / and /browse with the worst issue first and "+1 weitere"`
    - `close → POST dismiss {id, fp}; banner hides; next poll with the same fp stays hidden; mock changes fp → banner shows again` (Review Focus 2)
    - `no banner on /watch/<id>, in TV mode (html.tv), on a non-owner profile, for a friend (no banner request made)` (Review Focus 6)
    - `Ansehen navigates to /admin/status`
    - `banner request failing → no banner, no error toast`
    - mobile: `banner wraps without horizontal overflow; close button ≥ 44 px; does not cover the tab bar`
- [ ] **Step 2:** Locked build + run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Locked build; run the new specs plus `shell`, `kids*`, `pages*`, `home*` → PASS.
- [ ] **Step 5:** `git commit -m "feat(admin): warning banner for admins, dismissable per issue until it changes"`

### Task 10: Hygiene page (web)

**Files:**
- Create:
  - `web/src/routes/admin/hygiene/+page.svelte`
  - `web/src/lib/admin/hygiene.ts`: types mirroring Task 6; `hygieneQuery(f: { category?; issue?; type?; seriesId?; q; sort; offset; limit }): URLSearchParams` (drops empty values); `issueLabel(code): TKey`; `categoryOf(code)`
  - `web/src/lib/admin/hygiene.test.ts`
  - `e2e/tests/admin-hygiene.spec.ts`, `e2e/tests/admin-hygiene.mobile.spec.ts`
- Modify:
  - `web/src/lib/admin/nav.ts`: `{ href: '/admin/hygiene', label: 'admin.tabs.hygiene', icon: 'check' }` in the `content` group after `/admin/previews`
  - i18n `admin.tabs.hygiene` ("Bibliothekspflege") and `adminContent.hygiene.*` in 7 locales: intro, categories, every issue code (title + one-line hint what to do in the media server), scan state ("Zuletzt geprüft {time} · vollständig {time}"), "Jetzt prüfen", "Ignorieren", "Ignoriert" + Undo, "Metadaten neu laden", "{n} Versionen", "Doppelt mit", unsupported state, empty state ("Alles in Ordnung")
  - `e2e/mocks/admin.ts`: hygiene routes with state
- Test: as listed; extend nav tests (`activeItem('/admin/hygiene')`)

**Interfaces:**
- Consumes: Task 6 routes and types.
- UI:
  - Top: four `StatTile`s (info, language, duplicate, file) that act as category filters (`aria-pressed`), scan state line with "Jetzt prüfen".
  - Filters: issue `Select` (codes of the chosen category), type `Select`, search. Server paging through `DataTable` (`total` + `on:query`).
  - Row: name (link `/item/<id>`; episodes "Serie · S1E2"), issue `StatusPill`s (warn / info tone, icon + text), file summary (container, size via `fmtBytes`, bitrate, video, audio, subtitles), "Doppelt mit" links.
  - Row actions (`ActionMenu`): "Ignorieren" per issue (`runAction` with `undo` → `DELETE`), "Metadaten neu laden" (only info issues and `canRefresh`).
  - Unsupported server → one neutral `AdminCard` with the explanation, no table.

- [ ] **Step 1: Write failing tests:**
  - unit: `hygieneQuery drops empty filters and keeps sort/dir/offset/limit`; `every IssueCode has a label key (exhaustive list)`
  - e2e:
    - `tiles show counts; clicking "Sprache" filters (request has category=language) and marks the tile pressed`
    - `issue select narrows to foreign_no_subs; search sends q`
    - `row shows pills "Keine Untertitel" (warn) and "HEVC 10-Bit" (info); link goes to /item/<id>`
    - `ignore → row disappears, toast with Undo; Undo → DELETE and row back`
    - `refresh metadata posts once and shows a toast; hidden when canRefresh false`
    - `Jetzt prüfen → POST scan; running state disables the button`
    - `unsupported → explanation card, no table`
    - `nav: Bibliothekspflege under Inhalte, active on /admin/hygiene`
    - mobile: `table becomes cards, no horizontal overflow, actions ≥ 44 px`
- [ ] **Step 2:** Locked build + run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Locked build; run the new specs plus `admin-shell*`, `admin-content*` → PASS; `npx -w web vitest run src/lib/admin src/lib/i18n`.
- [ ] **Step 5:** `git commit -m "feat(admin): library hygiene page"`

### Task 11: Usage page (web)

**Files:**
- Create:
  - `web/src/routes/admin/usage/+page.svelte`
  - `web/src/lib/admin/usage.ts`: types mirroring Task 7; `fmtHours(seconds): string` (via `fmtNumber`, one decimal under 10 h), `transcodePct(r): number | null` (null with 0 streams), `dayBars(days): Array<{ day; pct }>` (relative to the max day; all zero → 0)
  - `web/src/lib/admin/usage.test.ts`
  - `e2e/tests/admin-usage.spec.ts`, `e2e/tests/admin-usage.mobile.spec.ts`
- Modify:
  - `web/src/lib/admin/nav.ts`: `{ href: '/admin/usage', label: 'admin.tabs.usage', icon: 'bar-chart' }` in the `people` group after `/admin/devices`
  - i18n `admin.tabs.usage` ("Nutzung") and `adminPeople.usage.*` in 7 locales: period labels, column labels, "Daten seit {date}", detail headings, privacy note ("Zusammengefasst, ohne Titel"), empty state
  - `e2e/mocks/admin.ts`: usage routes
- Test: as listed; extend nav tests

**Interfaces:**
- Consumes: Task 7 routes and types.
- UI:
  - Period `Select` (7 / 30 / 90 Tage), privacy note under it, "Daten seit …" when `since` is newer than the period start.
  - `DataTable` (client-side sort is enough: one row per account): name + role (+ "Gesperrt" pill), last seen (`fmtRelative`), watch time with films/series split, titles, streams, transcodes as "{pct} % · {reason}", devices "{used}/{total}", "läuft gerade" pill with link to `/admin/playback`.
  - Row expand (button with `aria-expanded`): 30 day bars (pure CSS, `role="img"` with an `aria-label` summary), devices list, reasons list. Loads `/api/admin/usage/:id` on first expand.

- [ ] **Step 1: Write failing tests:**
  - unit: `fmtHours(5400) → "1,5 Std."; transcodePct with 0 streams → null; dayBars scales to the max day`
  - e2e:
    - `30 days default; rows show hours, streams, "25 % · Videoformat", devices "2/3"`
    - `switching to 7 days requests days=7`
    - `expand loads detail once, shows bars and devices, aria-expanded toggles`
    - `"läuft gerade" links to /admin/playback`
    - `page text contains no title from the mocks' running sessions` (Review Focus 5)
    - `nav: Nutzung under Personen, active on /admin/usage`
    - mobile: `cards, no horizontal overflow, expand button ≥ 44 px`
- [ ] **Step 2:** Locked build + run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Locked build; run the new specs plus `admin-shell*`, `admin-people*` → PASS.
- [ ] **Step 5:** `git commit -m "feat(admin): per-user usage overview"`

### Task 12: Final verification and docs

- [ ] Run lint, typecheck, web unit, gateway and the full backend suite, then the locked web build and the full e2e (desktop + mobile). Everything must be green; record the counts.
- [ ] Measurement for the PR: p95 of `/api/admin/health` and `/api/admin/health/banner` from the snapshot (Server-Timing `app`, 50 calls); hygiene full sweep on the 50k fake library (duration, heap delta) and an incremental run with 50 changed items (number of `libraryHygiene` calls).
- [ ] Docs:
  - `CHANGELOG.md` *Unreleased*: "Admin: health" (traffic lights, disks, errors, transcodes, banner), "Admin: library hygiene", "Admin: usage"
  - README EN + DE: one feature line each; config table rows `GATEWAY_URL`, `HEALTH_DISK_WARN_PCT`, `HEALTH_DISK_CRIT_PCT`, `HEALTH_DB_WARN_GB`
  - `docs/monitoring.md`: "Zustand im Portal" section (what the status page checks and the thresholds); "Browser-Fehler → Datenschutz" now says reports are kept as 7-day aggregates without user, IP or user agent; the new `playback` kind
  - `docs/operations.md`: what the banner means and how to act on each red item; hygiene scan cadence and "Jetzt prüfen"
  - `docs/personal.md`: what admins can see on the usage page (aggregates, devices, no titles)
  - `docs/architecture.md`: endpoint list (`/api/admin/health*`, `/api/admin/streams`, `/api/admin/errors`, `/api/admin/hygiene*`, `/api/admin/usage*`) and the three optional seam methods (Task 2 adds the rows)
  - `docs/ui-kit.md`: Operations/Content/People page lists and the banner
- [ ] Run gitleaks on the branch (check the exit code directly). Grep the built web bundle and e2e HTML snapshots for `http://jellyfin`, `/data/downloads`, `/data/previews`, `api_key`: no hits.
- [ ] Open the PR. After the merge, port to the Plex fork: implement `transcodeSessions` (`/status/sessions` + `TranscodeSession`), `libraryHygiene` (`/library/sections/<id>/all?type=…&includeGuids=1` with `Media`/`Part`/`Stream`, `updatedAt>=` for `savedSince`) and `refreshMetadata` (`PUT /library/metadata/<id>/refresh`); health, banner, usage and the UI come in through the merge.

---

## Rulings on open spec points

- **Migration:** one migration (35) for the whole block, owned by Task 1, so parallel tasks never renumber.
- **Error log storage:** Redis with 7-day TTL and a 300-fingerprint cap, not Postgres; it is a rolling diagnostic, not a record.
- **Server errors:** only status ≥ 500, keyed by route pattern (`routeOptions.url`), so ids and queries never form keys.
- **Job errors:** every existing background `catch` in `server.ts` records its job name; the log line stays as it is.
- **Snapshot freshness:** 60 s tick, stale after 90 s, rebuilt in the background; only `?refresh=1` waits.
- **OIDC probe:** discovery document every 5 min at most; issuer must match `OIDC_ISSUER` (trailing slash ignored).
- **Fingerprint:** `id + level + reason`, numbers excluded; dismissals per admin in `health_dismissals`, pruned after 30 days.
- **Stream counting:** on `Playing` only (not on info, which the web prefetches since Block 20); foreign apps once per session via the poller.
- **Transcode vs. remux:** client `Transcode` plus a server reason = transcode; HLS without reason = remux (counted as direct in the share).
- **Hygiene versions:** file and language rules flag an item only when every version has the problem.
- **Hygiene titles of episodes:** episodes show as "Serie · S1E2"; the series name comes from the scan facts.
- **Hygiene title for failed playbacks:** `/api/admin/streams` uses `hygiene_items.name` and leaves the title null when the item was never scanned (no extra media-server call).
- **Usage sort:** client-side (one row per account; instances have tens of accounts, not thousands).
- **Banner placement:** under the app bar, above page content; hidden on `/watch/*`, `/party/*`, the profile picker, public pages, TV mode and non-owner profiles.
- **Health page:** `/admin/status` keeps its route and nav label ("Status"); the overview strip reads the same snapshot.
