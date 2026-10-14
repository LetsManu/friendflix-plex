# Block 22 – Admin care: health, library hygiene, user insight (design)

Status: scope chosen by the owner in the brainstorm of 2026-10-13; this written spec was drafted while the owner was away
(every gap is a ruling in the last section, to be confirmed in review).
Scope: FriendFlix main repo first; ported to the Plex fork (LetsManu/friendflix-plex) after merge.
Follows: Block 21 "Detail page" (its key-invalid / paused state of the TMDB/OMDb sources feeds the health view here).

## Goal and context

The admin runs FriendFlix for friends and family, usually without Grafana open. Today they find out that something is
wrong when someone sends a message: the media server was down, the download disk was full, a new release broke a page, or a
film "does not play" because its file forces a 4K HEVC transcode. The admin area shows reachability of two services and
some counts, but nothing about disks, errors, transcodes, the state of the library or how the instance is used.

The owner wants three things, all in the existing admin shell and with the kit:
1. **Health at a glance:** a traffic light per dependency, disk usage, recent errors and active/failed transcodes, and a
   warning banner for admins across the app.
2. **Library hygiene:** titles missing info or images, audio/subtitle problems, duplicates, broken or heavy files.
3. **User insight:** an aggregated overview per user (how much, which devices, streams/transcodes, last seen).

Findings from the code (2026-10-13):
- Admin API: `backend/src/routes/admin.ts`. `GET /api/admin/summary` (counts only, every source optional) feeds the shell
  badges and the overview; `GET /api/admin/status` is a leaner legacy variant; `GET /api/admin/live` lists running streams
  with titles (portal + Jellyfin sessions); `/api/admin/downloads` lists jobs and licenses with user names and titles.
- Admin web: `web/src/routes/admin/**`, nav model `web/src/lib/admin/nav.ts` (groups people / content / operations),
  `summary.ts` store, kit in `web/src/lib/ui/*` (`docs/ui-kit.md`). `/admin/status` already shows a health strip
  (media server, request service, previews, playback check), numbers and a storage card (downloads vs. cap, preview bytes).
- Readiness: `app.ts` `/health/ready` checks Redis, Postgres, Jellyfin. `metrics.ts` sets `friendflix_dependency_up` for the
  same three on every scrape. The gateway has `/health` and `/metrics` (`gateway/src/gateway.ts` ~337) and shares the `front`
  network with the backend (`compose.yaml`), but the backend never calls it.
- OIDC: the issuer is only touched at startup discovery (`oidc.ts`); there is no runtime check.
- Request service: `ctx.seerr.requestCount()` doubles as the reachability check in `/api/admin/summary`.
- Block 21 sources: `backend/src/sources/keys.ts` has `sourceStatus()` with `invalid`, `PAUSE_KEY` (401 pause, 1 h),
  `OMDB_COUNT_KEY` and `OMDB_DAILY_BUDGET = 900`.
- Disk: `downloadprep.ts` already uses `statfs(DOWNLOAD_DIR)` for `DOWNLOAD_MIN_FREE_GB`. Preview clips live under
  `PREVIEW_DIR`, sizes in `preview_clips.bytes`. Both are volumes mounted into the backend. Postgres and the media library
  are not mounted (and must not be: no Docker socket, no host paths).
- Client errors: `backend/src/clientErrors.ts` scrubs and logs browser errors and increments
  `friendflix_client_errors_total`, but stores nothing (documented in `docs/monitoring.md`, "Datenschutz"). The player does
  not report fatal playback errors at all.
- Playback: `/api/playback/info` computes `PlaybackDto.transcodeReason` (`jellyfin/dto.ts` `transcodeReasonOf`);
  start/progress/stop reports carry `playMethod` from the web player; `live.ts` keeps live entries in Redis (45 s TTL)
  without play method or reason. `pollJellyfinSessions` (`routes/internal.ts`) turns foreign Jellyfin sessions into live
  entries via `admin.externalSessions()`, which drops FriendFlix devices (`ff-…`) and all transcode info.
- Usage data: `play_seconds(user_id, item_id, day, seconds, item_name, item_type, series_name)` is filled by a
  `playbackHooks` hook (`achievements.ts`); `devices(user_id, device_id, label, approved, last_seen)`; the users list already
  shows "last seen" (max device `last_seen`). Nothing records stream counts or transcodes.
- Library-wide scans exist twice as a pattern: `langindex.ts` (`libraryStreams`, 12 h, item_langs) and `fresh.ts`
  `qualityIndexTick` (`libraryMediaTraits?`, 12 h, item_quality): admin key, pages of 200, upsert, delete vanished rows only
  after a complete run, never throw. Both rebuild everything every time (no incremental mode).
- The household's languages are visible in `user_prefs` / `profile_prefs` (`audioLang`, `subtitleLang`) and the instance
  language (`i18n.ts` `instanceLanguage`); `langindex.ts` has `normLang()` (639-2/B → /T).
- Migrations: `backend/src/db.ts`, last one is 34.

Non-goals:
- Push / ntfy / Discord alerts for health changes (Icinga/Prometheus cover alerting; `docs/monitoring.md`).
- Fixing files (re-encoding, deleting, merging versions): FriendFlix reports, the admin acts in the media server.
- Media library disk usage (not mounted), Redis memory, host CPU/RAM, container states (would need the Docker socket).
- Per-title watch history of other users, per-profile breakdowns, exports.
- Changing what viewers see; TV mode is unaffected (the banner never shows there).

## 1. Health at a glance

### 1.1 Traffic light per dependency
One row per service with a `StatusPill` (icon + text, never colour alone), a short reason and a link to where it is handled.
Levels: `ok` (green), `warn` (yellow), `err` (red), `off` (muted, not configured; never counts as a problem).

| Service | Probe (each ≤ 3 s, all in parallel) | Yellow | Red |
| --- | --- | --- | --- |
| Media server | `jf.admin.ping()` timed | answer > 2 s | no answer / error |
| Postgres | `select 1` timed | answer > 500 ms | error |
| Redis | `kv.ping()` timed | answer > 200 ms | error |
| Gateway | `GET ${GATEWAY_URL}/health` | answer > 2 s | no 200 |
| Login (OIDC) | `GET ${OIDC_ISSUER}/.well-known/openid-configuration`, `issuer` must match | answer > 2 s | no 200 / issuer mismatch |
| Request service | `seerr.requestCount()` | – | – (down = **yellow**: only wishes are affected) |
| TMDB / OMDb (each) | `sourceStatus()` + `PAUSE_KEY` | key invalid, paused after a 401, OMDb ≥ 90 % of the daily budget | – |
| Playback check | last `playback_checks` row | ≥ 1 failed title | – |

- Unset TMDB/OMDb keys are `off`. A request service is always configured (`SEERR_URL` is required) but treated as optional.
- The OIDC result is cached 5 min (a login provider is not hammered every minute); everything else per snapshot.
- Texts never contain URLs, tokens, keys or exception messages: only a reason code (`slow`, `down`, `invalid_key`, `paused`,
  `budget`, `issuer_mismatch`, `failed_titles`) that the web translates.

### 1.2 Disk usage
- **Downloads volume** (`DOWNLOAD_DIR`, only when downloads are enabled) and **previews volume** (`PREVIEW_DIR`): `statfs` of
  the mounted path → size, free, used %; plus FriendFlix's own share (ready download jobs, preview clip bytes) and, for
  downloads, use of `DOWNLOAD_CACHE_MAX_GB`.
- When both paths sit on the same filesystem (`stat().dev` equal) they are shown as one volume with two shares.
- **Database size** (`pg_database_size(current_database())`): size only (the volume is not mounted, so no free space).
- Thresholds: yellow at ≥ 85 % used, at < 2 × `DOWNLOAD_MIN_FREE_GB` free, or at ≥ 90 % of the download cap; red at ≥ 95 %
  used or < `DOWNLOAD_MIN_FREE_GB` free; database yellow above `HEALTH_DB_WARN_GB` (default 10). Env overrides
  `HEALTH_DISK_WARN_PCT` (85) and `HEALTH_DISK_CRIT_PCT` (95).
- A path that does not exist or cannot be read is `off` with reason `unavailable`, never a 500.
- Paths themselves are not sent to the browser (labels "Downloads", "Vorschauen", "Datenbank").

### 1.3 Errors and transcodes
- **Error log (new, aggregated):** fingerprints, not events. One entry per `source + code` with `count`, `firstAt`,
  `lastAt`, `release` and one scrubbed sample. Sources:
  - `server`: responses ≥ 500 (method + route pattern, never the URL with ids or query)
  - `client`: browser errors as today (`kind` + scrubbed message + path), now also aggregated
  - `playback`: **new** client kind `playback` sent by the player on a fatal media/HLS error, with `itemId` (32 hex) and a
    short `code` (hls.js error details or `MediaError` code, ≤ 60 chars)
  - `job`: background job failures (preview warm, download prep/gc, playback check, index ticks, hygiene scan)
  - Stored in Redis under `errlog:<source>:<hash>` with a 7-day TTL, at most 300 fingerprints (beyond that only an overflow
    counter grows). No user id, no IP, no user agent beyond the browser family, nothing else.
- **Active streams with play method:** every running stream (portal and other apps) with user, profile, device label, title
  (as `/api/admin/live` already shows), play method (direct / remux / transcode), transcode reason, and, when the media server
  reports it, video/audio codec and hardware acceleration.
- **Failed playbacks:** `playback` fingerprints of the last 24 h grouped by title, plus the playback check's failed titles.
- Health levels from errors: yellow when ≥ 10 server 5xx or ≥ 20 client errors in the last 15 min, or ≥ 3 failed playbacks
  in the last hour. Never red (errors alone do not mean the instance is down).

### 1.4 Admin warning banner
- Shown to admins (admin role on the owner profile, same rule as `requireAdmin`) on every page **except** TV mode, the
  immersive player pages (`/watch/*`, `/party/*`) and kids profiles.
- One slim bar under the app bar: worst level first, one sentence per issue ("Medienserver nicht erreichbar",
  "Download-Speicher fast voll (93 %)", "TMDB-Schlüssel ungültig"), "+2 weitere" when there are more, a link to
  `/admin/status`, and a close button per issue.
- **Dismiss per issue until it changes:** each issue has a stable `id` (`svc:jellyfin`, `disk:downloads`, `src:tmdb`,
  `errors:client` …) and a fingerprint `fp` = hash of `id + level + reason`. A dismissal stores `(admin, id, fp)`; the
  issue comes back when its level or reason changes (e.g. yellow → red), not when a number moves (85 % → 86 %). Resolved
  issues disappear by themselves. Dismissals are server-side (all of the admin's devices) and expire after 30 days.
- The banner reads a cached snapshot (§ Caching) and polls every 60 s while the tab is visible; it never delays a page.
- `role="status"` (yellow) / `role="alert"` (red, only when a red issue is new on this page view); ≥ 44 px close buttons.

## 2. Library hygiene

New admin page **Content → Bibliothekspflege** (`/admin/hygiene`): summary tiles per category, then one `DataTable` with
server-side paging, filter by category and issue, search, sort; each row links to the title (`/item/<id>`).

### 2.1 Issues
Severity `warn` (affects viewers) or `info` (cosmetic). Codes are stable and translated in the web.

| Category | Code | Rule | Applies to | Sev. |
| --- | --- | --- | --- | --- |
| Info / images | `no_overview` | empty overview | Movie, Series | warn |
| | `no_poster` | no primary image | Movie, Series | warn |
| | `no_backdrop` | no backdrop | Movie, Series | info |
| | `no_year` | no production year and no premiere date | Movie, Series | info |
| | `no_ids` | neither IMDb nor TMDB id (Block 21 links/ratings stay empty) | Movie, Series | info |
| Audio / subtitles | `no_audio` | a video without any audio stream | Movie, Episode | warn |
| | `audio_unknown` | every audio track without a language | Movie, Episode | info |
| | `foreign_no_subs` | no audio in a household language **and** no full (non-forced) subtitle in one | Movie, Episode | warn |
| | `forced_only` | household-language subtitles exist only as forced | Movie, Episode | info |
| | `image_subs_only` | household-language subtitles exist only as image subtitles (PGS/VobSub → burn-in transcode) | Movie, Episode | info |
| Duplicates | `dup_ids` | same type and same TMDB or IMDb id in ≥ 2 items | Movie, Series | warn |
| | `dup_title` | same type, normalised title and year in ≥ 2 items | Movie, Series | info |
| | `dup_episode` | same series, season and episode number in ≥ 2 items | Episode | warn |
| Files | `no_source` | no media source / virtual item / zero size | Movie, Episode | warn |
| | `zero_runtime` | no or zero runtime | Movie, Episode | warn |
| | `heavy_bitrate` | source bitrate > 40 Mbit/s (transcode outside the home network for most roles) | Movie, Episode | info |
| | `hevc_10bit` | HEVC with bit depth ≥ 10 (most browsers transcode) | Movie, Episode | info |
| | `video_codec` | video codec outside h264 / hevc / vp9 / av1 (e.g. mpeg2, vc1, mpeg4) | Movie, Episode | warn |
| | `audio_codec` | no audio track in aac / mp3 / ac3 / eac3 / opus / flac (only DTS / TrueHD / PCM …) | Movie, Episode | info |

- **Household languages** = the instance language plus every non-empty `audioLang` / `subtitleLang` and every profile UI
  language, normalised with `normLang()`. A change in this set re-evaluates the language issues from the stored facts.
- Several versions in one item (`MediaSources.length > 1`) are not a problem; the row shows "2 Versionen" and file checks
  look at the best version (an item is flagged only when **every** version has the problem).
- Series-level info checks only for Series; episodes are checked for files and languages only (episode overviews are
  missing far too often to be useful). The table can group by series (filter "Serie") to keep 3 000 episodes readable.
- **Ignore:** the admin can ignore one issue on one item (reversible, toast with Undo); ignored issues are not counted.
- **Refresh metadata** (info issues, optional seam method): asks the media server to refresh the item; the next incremental
  scan picks up the result.

### 2.2 Scan
- Background job `hygieneTick` (only with `BACKGROUND_JOBS`), never inside a request.
- **Incremental:** every 30 min, items saved since the last successful scan start (minus 5 min overlap) via the seam's
  `savedSince`; a library `itemAdded` media event schedules the next tick early (debounced 2 min).
- **Full sweep:** on the first run and every 7 days; only a complete sweep deletes rows of items that no longer exist
  (`itemRemoved` events delete single rows at once).
- Pages of 200 with 200 ms pause between pages; each page is upserted at once (memory stays flat for 50k items).
- Duplicates are recomputed with SQL after each scan (group by `ids_key`, `title_key`, `episode_key`).
- The page shows "Zuletzt geprüft vor 12 min · vollständig vor 2 Tagen" and a "Jetzt prüfen" button (starts a full sweep,
  rate limited, no-op while one runs).
- Without `libraryHygiene` on the media server the page shows a neutral "not supported by this media server" state.

## 3. User insight

New admin page **People → Nutzung** (`/admin/usage`): one row per account, period selector 7 / 30 / 90 days.

| Column | Source |
| --- | --- |
| Name, role, locked | `users` |
| Last seen | max `devices.last_seen` (as the users list) |
| Watch time | sum `play_seconds.seconds` in the period (+ share films vs. series) |
| Titles | count of distinct titles in the period (a number, never the names) |
| Streams | started streams in the period (new `play_daily`) |
| Transcodes | share of streams that were transcoded, with the most frequent reason |
| Devices | approved devices, number used in the period |
| Now | number of running streams (link to `/admin/playback`, where titles are already visible) |

- Row detail (expand): watch time per day (30 bars, `Progress`-style, no chart library), devices (label, last seen,
  streams, transcodes in the period), transcode reasons breakdown.
- **Privacy:** admin-only; aggregated; no per-title history, no top titles, no genres (the admin already sees running titles
  and download titles elsewhere, and no more than that). Profiles are summed into their account. Kids profiles are not
  shown separately. Viewing is not audited (it is read-only and aggregated), but the privacy page lists what admins see.
- Recording: a playback hook on `Playing` adds one stream to `play_daily(user_id, day, device_id)` with its play method and
  reason (reason stored per play session at `/api/playback/info` time, `pbinfo:<userId>:<playSessionId>`, 6 h TTL). A stream
  counts as **transcode** when the client reports `Transcode` **and** the server gave a reason; HLS without a reason is a
  remux and counts as direct. Foreign apps' streams are counted once by the session poller when first seen
  (`device_id = 'app:' + client name`).
- History before Block 22 has watch time (from `play_seconds`) but no streams/transcodes; the page says "Daten seit <date>".

## Data sources (summary)

| Area | Source | Per request? |
| --- | --- | --- |
| Traffic light, disk, error levels | health snapshot (kv `health:snap`) | no: snapshot, rebuilt by tick |
| Error log | Redis `errlog:*` | read only |
| Active streams | `listLive` + optional `admin.transcodeSessions()` | yes, one call, 3 s timeout, 5 s memo |
| Hygiene | Postgres `hygiene_items`, `hygiene_ignored` | SQL only |
| Usage | `play_seconds`, `play_daily`, `devices`, `users`, `listLive` | SQL + kv only |

## Caching and performance

- **Health snapshot:** built by `healthTick` every 60 s (with `BACKGROUND_JOBS`), stored in kv `health:snap` (TTL 300 s).
  A request finds an older snapshot (> 90 s, e.g. a replica without jobs) → it answers the old one and starts a rebuild in
  the background (single flight). Only `GET /api/admin/health?refresh=1` waits for a fresh one (≤ 3.5 s, rate limit 6/min).
- Banner endpoint: snapshot + one dismissal query; target p95 < 30 ms.
- Hygiene: never calls the media server in a request; list queries use indexes on `issues` (GIN), `type`, `series_id`;
  summary counts cached 60 s in kv and dropped after a scan or an ignore.
- Large libraries (50k items): incremental scans touch only changed items; full sweep ≈ 250 pages; facts per item are a few
  hundred bytes of jsonb; the scan yields between pages and stops early on shutdown.
- Usage: one grouped query per table over the period, indexed by `(day)`; results cached 60 s per period.

## Seam impact (Plex fork)

All new methods are **optional**; absent means the feature degrades to what is server-neutral.

- `MediaAdmin.transcodeSessions?(): Promise<ServerSession[]>`: every playing session (FriendFlix devices included) with play
  method, mapped `TranscodeReason`s, codecs, hardware flag, client and device name. Absent: active streams show only what
  FriendFlix itself knows (method + reason of portal streams).
- `MediaServer.libraryHygiene?(type, page): Promise<HygieneFacts[]>`: neutral facts per item (flags for overview / poster /
  backdrop / year, provider ids, runtime, versions with container, bitrate, size, video / audio / subtitle stream facts),
  with an optional `savedSince` for incremental scans. Absent: hygiene page shows "not supported".
- `MediaServer.refreshMetadata?(id): Promise<void>` (admin key). Absent: no refresh button.
- No DTO contains a server path, URL or token. Jellyfin implements all three now; the fork maps Plex sessions
  (`/status/sessions` `TranscodeSession`), `/library/sections/*/all` with `Media`/`Part`/`Stream` and `updatedAt>=`, and
  `PUT /library/metadata/<id>/refresh` later.

## Security and privacy

- Every new endpoint is admin-only (`requireAdmin`: admin role on the owner profile), CSRF as usual, zod-validated.
- No media-server token, API key, URL, file path, IP address or exception text in any response; reasons are codes.
- Disk usage only through `statfs`/`stat` of paths already mounted into the backend; no Docker socket, no host paths.
- The gateway probe uses `/health` only (no token needed); `GATEWAY_URL` defaults to `http://gateway:4000` (internal net).
- Client and playback error reports stay unauthenticated, rate limited and scrubbed as today; the stored aggregate holds no
  user or IP. `docs/monitoring.md` "Datenschutz" changes from "nothing is stored" to "aggregated for 7 days".
- Usage is aggregated, admin-only, without titles; `docs/personal.md` lists what admins can see.
- Ignore / refresh / dismiss / "check now" write audit entries (`hygiene.ignore`, `hygiene.unignore`, `hygiene.refresh`,
  `hygiene.scan`); dismissals do not (they only hide a banner for one admin).

## Error handling

- A probe that throws or times out is that service's red/yellow state, never a failed snapshot.
- A missing directory, an unknown filesystem or a failing `statfs` → `off` / `unavailable`.
- A failed hygiene page aborts the run (logged as a `job` error), keeps the rows, and the next tick retries; a full sweep that
  did not complete deletes nothing.
- `transcodeSessions` failing → active streams from FriendFlix data only, with a muted "details unavailable" hint.
- A web page whose endpoint fails shows the kit's error state with retry; the banner silently keeps its last state.

## Testing

- Backend:
  - health levels per probe (ok / slow / down), OIDC issuer mismatch, source states from Block 21 (invalid, paused, budget)
  - disk: thresholds, same filesystem merged, missing path `off`, no path in the response
  - snapshot: stale → served + rebuild once (single flight); `refresh=1` rate limit
  - banner: dismiss by `(id, fp)`, comes back on level change, not on number change, per admin, 30-day expiry
  - error log: 5xx route pattern without ids, client + playback aggregation, scrubbing, 300-fingerprint cap, TTL
  - transcode sessions mapping, `ff-` device to label, no token or path in the DTO
  - hygiene: every issue rule (pure function with fixtures), household languages, versions rule, duplicates SQL, ignore,
    incremental vs. full, delete only after full, 50k-item fake library completes with bounded memory and no request blocking
  - usage: aggregates per period, transcode vs. remux counting, foreign app streams, no titles in the response
  - all routes: 401 / 403 for non-admins and for an admin on a non-owner profile
- Web unit: level ordering and banner selection, dismissal matching, hygiene filter query building, usage formatting.
- e2e: status page (lights, disks, errors, streams), banner (shows, dismiss, re-shows on change, absent in TV mode, on
  `/watch/*` and for non-admins), hygiene page (filters, ignore + undo, refresh), usage page (period, row detail), phone
  layouts (no horizontal overflow, ≥ 44 px), all in de + one other language.
- Full suite, gitleaks, i18n in all 7 languages.

## Measurement

- Banner endpoint and `/api/admin/health` p95 from the cache (Server-Timing `app`), reported in the PR.
- Hygiene full sweep on the fake 50k library: duration, peak RSS delta, rows; incremental run with 50 changed items:
  number of server calls.
- Real instance after deploy: count of issues per category (one-time number in the PR, no titles).

## Open decisions taken while the owner was away

- **Ruling: extend `/admin/status` into the health page instead of adding a new page** — it already has the health strip,
  numbers and storage, and two pages about "is everything fine" would compete — cost if wrong: one more nav item and a
  split of the page later (small, the sections are separate components).
- **Ruling: request service down is yellow, not red** — only wishes stop working, playback and login do not — cost if
  wrong: a level constant.
- **Ruling: OIDC down is red** — nobody can sign in or renew a session — cost if wrong: a level constant.
- **Ruling: new env `GATEWAY_URL` (default `http://gateway:4000`)** — the backend has no gateway address today and the
  compose network already allows the call — cost if wrong: a different default for unusual setups (documented).
- **Ruling: gateway health via `/health` only, no metrics scrape** — `/metrics` may need the token and adds parsing for
  little gain — cost if wrong: gateway 5xx rates come later from Prometheus instead.
- **Ruling: database size only, no free space; no media library disk, no Redis memory** — those volumes are not mounted
  and the Docker socket is off limits; the KV interface has no INFO — cost if wrong: the admin still needs Grafana/host
  tools for those.
- **Ruling: disk thresholds 85 % / 95 % with env overrides, DB warning at 10 GB** — common defaults; small instances
  rarely reach 10 GB — cost if wrong: env change, no code.
- **Ruling: store client errors as 7-day aggregates in Redis (changes "nothing is stored")** — "recent errors" is impossible
  otherwise without log access; aggregates carry no user, IP or full user agent — cost if wrong: drop the client source
  and show server/job/playback only (one module).
- **Ruling: new client error kind `playback` with `itemId` + `code`** — "failed transcodes" are invisible today; a fatal
  player error is the only reliable signal — cost if wrong: a small player change to revert.
- **Ruling: banner dismissals stored server-side per admin (new table), 30-day expiry** — "until it changes" must hold on
  every device of the admin — cost if wrong: localStorage instead (simpler, per browser).
- **Ruling: the fingerprint ignores numbers** — a disk at 85 → 86 % must not re-show a dismissed warning every minute —
  cost if wrong: admins miss a slow creep inside one level until it turns red.
- **Ruling: no banner in TV mode, on player/party pages, or on kids/non-owner profiles** — TV mode must stay unchanged and
  the player is immersive — cost if wrong: an admin on the couch sees problems only on the next desktop visit.
- **Ruling: hygiene info checks for films and series only; episodes only files + languages** — episode overviews are
  missing everywhere and would bury the useful rows — cost if wrong: one rule switch.
- **Ruling: thresholds fixed in code (40 Mbit/s heavy, HEVC ≥ 10 bit, codec lists)** — pragmatic, the owner asked for
  "pragmatic" — cost if wrong: constants; can become admin settings later.
- **Ruling: several versions in one item are not an issue; flag only when every version has the problem** — versions are
  a deliberate choice in the media server — cost if wrong: a "versions" filter instead.
- **Ruling: household languages = instance language + every profile's UI, audio and subtitle preference** — it matches
  "the user's languages" without a new setting — cost if wrong: a setting on the hygiene page.
- **Ruling: incremental scan via the server's "saved since" date, full sweep weekly** — keeps 50k libraries cheap;
  removals also arrive as `itemRemoved` events — cost if wrong: deleted items without event linger up to 7 days.
- **Ruling: "Ignore" per item and issue, plus optional "refresh metadata"** — without ignore, accepted cases (a silent film)
  stay red forever — cost if wrong: two small endpoints and a table.
- **Ruling: usage page lives under People as `/admin/usage`, aggregated per account (profiles summed)** — `play_seconds` is
  per account and the users page has no detail view — cost if wrong: a per-profile split needs a `profile_id` column.
- **Ruling: no titles, top titles or genres in usage** — the brief says no per-title history beyond what admin pages show;
  running titles and download titles stay on their pages — cost if wrong: owners wanting "what do they watch" need a follow-up.
- **Ruling: the `shareHistory` preference does not hide a user from the admin's aggregates** — it is about friends, and the
  admin sees no titles here — cost if wrong: filter the watch-time columns by the preference.
- **Ruling: stream/transcode counting starts with Block 22 (no backfill)** — there is no historic source — cost if wrong:
  none; the page says since when data exists.
- **Ruling: transcode = client says `Transcode` and the server gave a reason; HLS without reason = remux (direct)** — the web
  player reports every HLS stream as `Transcode` — cost if wrong: transcode share is over/under-stated, one rule.
- **Ruling: all Block 22 tables in one migration (35)** — tasks run in order, one migration avoids renumbering conflicts —
  cost if wrong: none.

### Controller override (supersedes the error-storage rulings above)

- **Ruling: client and playback error reports are NOT persisted** — `docs/monitoring.md` promises that client error
  reports are not stored, and that promise is not changed without the owner. Client and `playback` reports are aggregated
  **in backend process memory only** (same scrubbing, fingerprint cap 300, no user, no IP, no user agent; window 24 h;
  lost on restart, never written to Redis or Postgres). Server 5xx and job failures (no personal data) may use Redis as
  planned. `docs/monitoring.md` gets one added sentence ("counted in memory for the admin health page, never written to
  disk") instead of the "aggregated for 7 days" change — cost if wrong: after a backend restart the health page shows no
  client/playback errors until new ones arrive; the owner can later opt into persistence.
