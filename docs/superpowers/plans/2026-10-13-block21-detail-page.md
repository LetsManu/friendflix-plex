# Block 21 – Detail page: tidier, more info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shorter detail page that shows more: a ratings line, tagline, a film's collection in order, always-on tabs with a Details tab (facts, links, social card), plus optional TMDB/OMDb keys set by the admin.

**Architecture:**
- Backend: a key store (`sources/keys.ts`, encrypted `app_settings`, `*_FILE` wins) and two small clients (`sources/tmdb.ts`, `sources/omdb.ts`) on a shared fetch helper (kv cache, 3 s timeout, 401 pause, OMDb budget).
- The `MediaServer` seam gets two optional methods, `itemAbout?` and `itemCollections?`; Jellyfin implements both. `GET /api/items/:id/about` merges seam data, TMDB, OMDb and friends' stars; a failing source is left out, never a 500.
- Web: `lib/detail/about.ts` (types, SWR load, pure view helpers), new `RatingsLine`, `CollectionRow`, `DetailsTab`, `SocialCard` components; `DetailView.svelte` is reordered; new admin page `/admin/sources`.

**Tech Stack:** Fastify + zod + Postgres + kv (Redis/Memory) (backend), SvelteKit (legacy syntax) (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-block21-detail-page-design.md`

### Order and model tier

| Task | Depends on | Can run in parallel with | Model |
| --- | --- | --- | --- |
| 1 Source keys + admin API | – | 3 | sonnet |
| 2 TMDB/OMDb clients | 1 | 3, 5 | sonnet |
| 3 Seam `itemAbout?` / `itemCollections?` + Jellyfin | – | 1, 2 | sonnet |
| 4 `GET /api/items/:id/about` | 2, 3 | 5 | opus |
| 5 Admin page `/admin/sources` | 1 (API contract) | 2, 3, 4 | sonnet |
| 6 Detail page restructure | 4 (contract in its Interfaces; e2e mocks it) | 5 | opus |
| 7 Collection row | 6 | – | sonnet |
| 8 Final verification + docs | all | – | sonnet |

Tasks 5 and 6 only need the JSON contracts below, so they can start once Tasks 1 and 4 are specified. They must not merge before their backend task is green.

## Global Constraints

- External data is optional. Without keys the page shows Jellyfin data only. Empty sections are hidden, and viewers never see a "key missing" hint.
- Keys:
  - stored encrypted with `APP_ENC_KEY` (`encrypt`/`decrypt` in `backend/src/crypto.ts`) in `app_settings` under the keys `source.tmdb` and `source.omdb`
  - never in an API response, a log line, the audit log, the HTML or a URL sent to the browser; the API returns only `{ set, last4, from: 'db' | 'file' }`
  - `TMDB_API_KEY_FILE` / `OMDB_API_KEY_FILE` take precedence; the UI then shows "from file" and disables editing
- Every key change writes an audit entry (`source.set`, `source.remove`, meta `{ name }` only).
- External calls:
  - 3 s timeout each
  - cache 7 days (`604800` s) for success and 1 hour (`3600` s) for failures, in `ctx.kv`, keyed by external ID and shared by all users
  - an HTTP 401 pauses that source for 1 hour
  - OMDb makes at most 900 calls per UTC day; after that it serves the cache only, and the counter resets at midnight UTC
  - a slow or down source is left out of the response
- Visibility:
  - Collection parts in the library come from the viewer's own media-server identity (role libraries, age cap and kids profile apply).
  - Kids profiles get no friends' rating, no missing (TMDB) parts and `canRequest: false`.
  - "Request" appears only when the role may request.
- The Plex token never reaches clients; the new seam methods return neutral DTOs only.
- No new npm dependencies.
- No other brands' look-alikes (Block 19 rules): neutral styling for the ratings line and links (text labels "IMDb", "TMDB", "TVDB", "Trakt", "RT", "MC"), no logos and no brand colours.
- Admin UI uses the kit (`#lib/ui/*`, `#lib/adminContent/AdminCard.svelte`, `runAction`, `confirm`).
- All new UI text goes in all 7 locales (`web/src/lib/i18n/locales/{de,en,fr,es,it,tr,pl}`; de is the typed source).
- TV mode is unchanged except that focus moves cleanly into and through the tabs.
- Touch targets ≥ 44 px on phones.
- Commands (from the repo root; kill processes by PID only, never `pkill -f`):
  - `LOCK=/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/b21.lock`
  - backend: `service postgresql start`; `psql -U postgres -h localhost -c 'create database ff_test_b21'` once (password x); `TEST_DATABASE_URL=postgres://postgres:x@localhost:5432/ff_test_b21 npx -w backend vitest run test/<file>`
  - web unit: `npx -w web vitest run src/lib/<path>`
  - build: `flock $LOCK npm run build -w web 2>&1 | tail -4`
  - e2e: `flock $LOCK env E2E_PORT=4281 E2E_SKIP_BUILD=1 PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test -c e2e/playwright.config.ts <spec>`; then delete `e2e/test-results`
  - checks: `npm run lint`, `npm run typecheck`

## Review Focus

1. **A key in the URL of a failed call:** TMDB v3 and OMDb carry the key as a query parameter. Any error path (timeout, 5xx, a JSON parse error, a thrown `TypeError` with the URL in its message) must not log or return it. Test in Task 2.
2. **A collection part the viewer cannot see** (other library, above the age cap) must not show up, not even greyed out as "missing" with a Request button. TMDB knows it, but it is in the library. Test in Task 4.
3. **A key change while a 401 pause or a cached failure is active:** a new key must work at once, not after an hour. Test in Task 1 (pause and failure cache cleared on PUT/DELETE).
4. **Provider IDs with odd values** (`tt` with spaces, a TVDB slug, an IMDb ID in the TMDB field) must not produce broken or injected link URLs. Only validated IDs become links. Test in Task 4.
5. **Stale SWR data from another profile:** switching to a kids profile must not show the grown-up profile's cached friends' rating or missing parts. The cache key includes the active profile. Test in Task 6.

---

### Task 1: Source keys store + admin API (backend)

**Files:**
- Create: `backend/src/sources/keys.ts`, `backend/src/routes/sources.ts`
- Modify:
  - `backend/src/config.ts`: `TMDB_API_KEY: opt`, `OMDB_API_KEY: opt` (`withFileSecrets` then reads `*_FILE` automatically)
  - `backend/src/app.ts`: register `sourceRoutes(app, ctx)`
  - `backend/test/helpers.ts` (`cfg`): add `TMDB_API_KEY: undefined, OMDB_API_KEY: undefined`
  - `.env.example`, `compose.yaml`, `compose.prod.yaml`: commented `TMDB_API_KEY` / `OMDB_API_KEY`; add the `_FILE` variants to `compose.secrets.yaml`
- Test: `backend/test/sources-keys.test.ts`

**Interfaces:**
- Produces:
  - `type SourceName = 'tmdb' | 'omdb'`; `const SOURCES: readonly SourceName[]`
  - `getSourceKey(ctx: Pick<Ctx,'db'|'cfg'|'encKey'>, name: SourceName): Promise<{ key: string; from: 'db' | 'file' } | null>`. File/env wins; the DB value is cached in-process for 30 s and the cache is cleared by `setSourceKey` / `removeSourceKey`.
  - `setSourceKey(ctx, name, key: string): Promise<void>`: stores `{ enc, last4, updatedAt }` as jsonb.
  - `removeSourceKey(ctx, name): Promise<void>`
  - `sourceStatus(ctx: Ctx, name): Promise<SourceStatus>`, where `SourceStatus = { name: SourceName; set: boolean; last4: string | null; from: 'db' | 'file' | null; invalid: boolean; usedToday?: number; budget?: number }`. `usedToday` and `budget` are OMDb only; `budget` is 900.
  - kv keys used by Task 2 (constants exported from `keys.ts`): `PAUSE_KEY(name) = 'src:pause:' + name`, `INVALID_KEY(name) = 'src:invalid:' + name`, cache prefix `CACHE_PREFIX(name) = 'ext:' + name + ':'`, `OMDB_COUNT_KEY(dayUtc) = 'src:omdb:calls:' + dayUtc`
  - `testSourceKey` is defined in Task 2. Until then the route returns `{ ok: false, error: 'not_set' }` when no key exists, and otherwise calls an injected tester.
  - Routes (all `requireAdmin`, CSRF as usual, `name` = zod enum `['tmdb','omdb']`):
    - `GET /api/admin/sources` → `{ sources: SourceStatus[] }`
    - `GET /api/admin/sources/:name` → `SourceStatus`
    - `PUT /api/admin/sources/:name` body `{ key: string }` (trimmed, 8–200 chars, `/^[\x21-\x7e]+$/`) → `SourceStatus`; 409 `{ error: 'from_file' }` when the file wins
    - `DELETE /api/admin/sources/:name` → `SourceStatus`; 409 `from_file` likewise
    - `POST /api/admin/sources/:name/test` body `{ key?: string }` (an unsaved value may be tested) → `{ ok: true } | { ok: false, error: 'not_set' | 'invalid_key' | 'unreachable' | 'budget' }`; rate limit 10/min
  - PUT and DELETE clear `PAUSE_KEY`, `INVALID_KEY` and every kv key under `CACHE_PREFIX(name)` (use `kv.keys`).

- [ ] **Step 1: Write failing tests:**
  - `PUT stores the key encrypted: app_settings value has no plaintext (JSON.stringify(row) does not contain the key), decrypt(enc) === key`
  - `GET/PUT/DELETE responses never contain the key; last4 is the last 4 chars; from 'db'`
  - `TMDB_API_KEY set in cfg (ctxPatch) → from 'file', PUT and DELETE → 409 from_file, getSourceKey returns the file key even with a DB row`
  - `non-admin (friend login) → 403 on all five routes; no session → 401`
  - `audit_log has source.set / source.remove with meta {name} and no key text`
  - `PUT clears src:pause:tmdb, src:invalid:tmdb and ext:tmdb:* (Review Focus 3)`
  - `bad name → 400; key with a space or 7 chars → 400`
- [ ] **Step 2:** Run `test/sources-keys` → FAIL.
- [ ] **Step 3:** Implement the files above.
- [ ] **Step 4:** Re-run → PASS; run the full backend suite (the `cfg` change touches every test).
- [ ] **Step 5:** `git commit -m "feat(sources): encrypted TMDB/OMDb keys with admin API"`

### Task 2: TMDB + OMDb clients (backend)

**Files:**
- Create:
  - `backend/src/sources/fetch.ts`: `extFetch` (cache, timeout, pause, failure cache)
  - `backend/src/sources/tmdb.ts`, `backend/src/sources/omdb.ts`
- Modify: `backend/src/routes/sources.ts` (the test route calls `testSourceKey`)
- Test: `backend/test/sources-clients.test.ts` (sets `ctx.fetchImpl = fakeHttp({...})` via `ctxPatch`; the `fakeHttp` route key is the path, e.g. `GET /3/movie/603`)

**Interfaces:**
- Consumes: `getSourceKey`, the kv key constants from Task 1.
- Produces:
  - `extFetch<T>(ctx: Ctx, name: SourceName, cacheKey: string, url: (key: string) => { url: string; headers?: Record<string,string> }, parse: (j: unknown) => T, log?: { warn(o: object): void }): Promise<T | null>`
    - Returns `null` when there is no key, while paused, on the cached failure marker, on budget exhaustion or on any error.
    - On HTTP 401 it sets `PAUSE_KEY` and `INVALID_KEY` with TTL 3600.
    - Success is cached under `CACHE_PREFIX(name) + cacheKey` with TTL 604800; a failure stores `{"f":1}` with TTL 3600.
    - For OMDb it increments `OMDB_COUNT_KEY(today UTC)` (TTL 2 days) before calling and skips the call when the new value is > 900.
    - It never puts the URL, the key or an error message in a log or a thrown error. Errors are caught and only `{ source: name, status }` is passed to `log?.warn` (routes pass `req.log`).
  - TMDB auth: a key that looks like a v4 token (`/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/`) is sent as `Authorization: Bearer`; otherwise as the `api_key` query parameter. Base `https://api.themoviedb.org/3`.
  - `tmdbTitle(ctx, type: 'movie' | 'tv', tmdbId: number): Promise<{ imdbId?: string; collection?: { id: number; name: string }; keywords: string[] } | null>`
    - Movie: `/movie/{id}?append_to_response=keywords,external_ids` (`belongs_to_collection`, `keywords.keywords[].name`).
    - TV: `/tv/{id}?append_to_response=keywords,external_ids` (`keywords.results[].name`).
    - Keywords: at most 20.
  - `tmdbCollection(ctx, id: number): Promise<{ id: number; name: string; parts: Array<{ tmdbId: number; title: string; releaseDate?: string; posterPath?: string }> } | null>`
    - Source: `/collection/{id}`.
    - Parts sorted by `release_date`; parts without a date go last.
    - `posterPath` is kept only if it matches `/^\/[A-Za-z0-9_-]{5,60}\.(jpg|png|webp)$/` (the proxy's rule in `routes/seerr.ts`).
  - `omdbRatings(ctx, imdbId: string): Promise<{ imdb?: number; rt?: number; mc?: number } | null>`
    - Source: `https://www.omdbapi.com/?i={imdbId}&apikey={key}`.
    - `Response: "False"` counts as a failure.
    - Parsing: `imdbRating` "8.1" → 8.1; Ratings "Rotten Tomatoes" "92%" → 92; "Metacritic" "81/100" → 81; "N/A" is dropped.
  - `testSourceKey(ctx, name, key: string): Promise<{ ok: true } | { ok: false; error: 'invalid_key' | 'unreachable' | 'budget' }>`
    - TMDB: `/configuration`. OMDb: `?i=tt0111161`.
    - Not cached; counts against the OMDb budget.

- [ ] **Step 1: Write failing tests:**
  - `no key → null and no fetch call`
  - `tmdbTitle parses collection + keywords + imdbId; second call (other user) is served from kv: fetch count stays 1`
  - `v3 key goes in api_key query, eyJ… token in the Authorization header`
  - `tmdbCollection sorts by release date, drops a poster path with ../`
  - `omdbRatings parses imdb 8.1, rt 92, mc 81; N/A dropped; Response False → null and cached for 1 h (kv ttl ≈ 3600)`
  - `timeout: a fetch that never resolves → null after ~3 s` (fake timers or `vi.useFakeTimers` + `AbortSignal.timeout` spy; assert the signal passed has a 3000 ms timeout)
  - `401 → null, src:pause:<name> and src:invalid:<name> set; next call within the hour makes no fetch`
  - `OMDb budget: counter at 900 → no fetch, cached entries still served; new UTC day key → calls again`
  - `key never leaks: fetchImpl throws new TypeError('fetch failed https://…apikey=SECRET'); spy on console and the passed log → no argument contains SECRET; return value null` (Review Focus 1)
  - `POST /api/admin/sources/tmdb/test with body key → {ok:true}; 401 upstream → {ok:false,error:'invalid_key'}; unreachable → 'unreachable'`
- [ ] **Step 2:** Run `test/sources-clients` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git commit -m "feat(sources): TMDB and OMDb clients with shared cache, timeout, pause and budget"`

### Task 3: Seam – `itemAbout?` and `itemCollections?` (Jellyfin)

**Files:**
- Modify:
  - `backend/src/media/types.ts`: new DTOs and two optional `MediaServer` methods (block comment like Block 17 P1)
  - `backend/src/jellyfin/service.ts`: implement both
  - `backend/src/jellyfin/dto.ts`: `toItemAbout(raw)`
  - `docs/architecture.md`: seam table rows
- Test: `backend/test/media-about-seam.test.ts`

**Interfaces:**
- Produces (in `media/types.ts`):
  - `interface ProviderIds { imdb?: string; tmdb?: string; tvdb?: string }` (raw strings; validation is Task 4's job)
  - `interface ItemAboutDto { type: string; providerIds: ProviderIds; tagline?: string; originalTitle?: string; premiereDate?: string; countries: string[]; studios: string[]; tags: string[]; communityRating?: number; criticRating?: number }`
  - `interface MediaCollection { id: string; name: string; parts: Array<{ item: ItemDto; tmdbId?: string }> }`: parts are only those the viewer can see, in release order (premiere date, then year, then name)
  - `itemAbout?(user: MediaUser, id: string): Promise<ItemAboutDto>`: throws `MediaError(404)` when not visible
  - `itemCollections?(user: MediaUser, id: string): Promise<MediaCollection[]>`: `[]` when the item is in no collection the viewer can see
- Jellyfin:
  - `itemAbout`: viewer token, `/Items?userId&ids=<id>&fields=ProviderIds,Taglines,Studios,Tags,ProductionLocations,OriginalTitle,Genres&enableImages=false`.
    - `Taglines[0]`; `ProductionLocations` → countries; studios ≤ 6 and tags ≤ 20 (same caps as `toCredits`).
    - `ProviderIds.Imdb/Tmdb/Tvdb` are read case-insensitively.
    - `CriticRating` and `CommunityRating` as given.
  - `itemCollections`:
    - A library-wide membership index built with the admin key: BoxSets paged 200 at a time, then each one's children ids via `/Items?parentId=<boxset>&fields=` with `enableImages=false`.
    - The index is cached in kv as `jf:boxsets:v1` (TTL 3600) with single-flight, so concurrent requests build it once.
    - For each BoxSet that contains `id`, the visible parts come from the viewer token: `/Items?userId&parentId=<boxset>&fields=<FIELDS>,ProviderIds&sortBy=PremiereDate,ProductionYear,SortName`. A non-ok answer skips that BoxSet.
    - The BoxSet name comes from the same viewer call (`/Items?userId&ids=<boxset>`), so an invisible BoxSet never shows its name.

- [ ] **Step 1: Write failing tests** (fake Jellyfin as in `scenes17.test.ts`):
  - `itemAbout maps tagline, original title, countries, studios, tags, provider ids (Imdb/imdb), community + critic rating`
  - `itemAbout of an invisible item → 404`
  - `itemCollections: two BoxSets, item in one → one collection, parts in premiere order with tmdbId`
  - `parts hidden from the viewer (fake returns fewer children for the kids user token) are absent`
  - `membership index is built once for two concurrent calls and reused from kv (admin calls counted)`
  - `item in no BoxSet → []`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also `test/media-seam` and `test/scenes17`.
- [ ] **Step 5:** `git commit -m "feat(seam): optional itemAbout and itemCollections (Jellyfin)"`

### Task 4: `GET /api/items/:id/about` (backend)

**Files:**
- Create: `backend/src/about.ts` (aggregation, pure helpers), `backend/src/routes/about.ts` (route, registered in `app.ts`)
- Test: `backend/test/about.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`getSourceKey`, `tmdbTitle`, `tmdbCollection`, `omdbRatings`, `ctx.jf.itemAbout?`, `ctx.jf.itemCollections?`, `ctx.jf.findByTmdb`), `limitFor` (`requestlimit.ts`), `isKidsProfile` (`kids.ts`).
- Produces (exported from `about.ts`; the web mirrors it in Task 6):
  ```ts
  type RatingKey = 'community' | 'critic' | 'imdb' | 'rt' | 'mc' | 'friends';
  interface AboutRating { key: RatingKey; value: number; max: 5 | 10 | 100; from: 'jellyfin' | 'omdb' | 'friends' }
  interface AboutLink { kind: 'imdb' | 'tmdb' | 'tvdb' | 'trakt'; url: string }
  interface AboutPart { id?: string; tmdbId?: number; name: string; year?: number; poster?: string; image: boolean; played: boolean; current: boolean; inLibrary: boolean; from: 'jellyfin' | 'tmdb' }
  interface AboutCollection { name: string; parts: AboutPart[]; from: 'jellyfin' | 'tmdb' }
  interface AboutDto { ratings: AboutRating[]; tagline?: string; originalTitle?: string; releaseDate?: string; countries: string[]; studios: string[]; tags: string[]; keywords: string[]; links: AboutLink[]; collection: AboutCollection | null; canRequest: boolean; sources: Array<'jellyfin' | 'tmdb' | 'omdb'> }
  ```
  - `buildLinks(type: string, ids: ProviderIds): AboutLink[]` (pure)
    - IMDb `/^tt\d{7,10}$/` → `https://www.imdb.com/title/{id}/`
    - TMDB `/^\d{1,9}$/` → `https://www.themoviedb.org/{movie|tv}/{id}`
    - TVDB `/^\d{1,9}$/` → `https://www.thetvdb.com/dereferrer/{movie|series}/{id}`
    - Trakt from IMDb → `https://trakt.tv/search/imdb/{id}`, else from TMDB → `https://trakt.tv/search/tmdb/{id}?id_type={movie|show}`
    - Anything else is dropped (Review Focus 4).
  - Route: `GET /api/items/:id/about` (`requireUser`; `id32`; 404 when `itemAbout` 404s; rate limit 120/min per session).
- Rules:
  - Without `itemAbout` the Jellyfin part is empty (ratings from friends only), and without `itemCollections` the collection is null.
  - Ratings, in this order:
    1. community (max 10)
    2. critic (max 100, from Jellyfin), dropped when OMDb gives `rt`
    3. imdb (10), rt (100), mc (100) from OMDb via the IMDb ID; when Jellyfin has none, the IMDb ID comes from `tmdbTitle`
    4. friends (5): the average of the same query as `GET /api/items/:id/ratings` (shareRatings respected); none on kids profiles or when there are no rows
  - `releaseDate` = premiere date `YYYY-MM-DD`; `originalTitle` only if it differs from the item name (case-insensitive); `keywords` from TMDB (de-duplicated against tags, case-insensitive).
  - Collection (Movie only):
    - A Jellyfin BoxSet with ≥ 2 visible parts (prefer the one whose parts include the TMDB collection's parts, else the most parts).
    - With TMDB: the TMDB collection gives order and missing parts.
    - Library parts are matched by `tmdbId`, from the BoxSet parts or else `findByTmdb` followed by the viewer's `item()`. A part found in the library but not visible to the viewer is omitted entirely (Review Focus 2).
    - Missing parts get `inLibrary: false`, `from: 'tmdb'`, `poster: '/api/seerr/image' + posterPath`, `tmdbId`.
    - Kids: missing parts are dropped.
    - Without TMDB: library parts only.
    - A collection with < 2 parts after filtering → null.
  - `canRequest = !kids && (await limitFor(ctx, role)) !== 0`.
  - All external lookups run in parallel under the 3 s client timeout; a rejected one only removes its part. `sources` lists which sources contributed.

- [ ] **Step 1: Write failing tests** (fake Jellyfin + `ctxPatch` fetchImpl for TMDB/OMDb):
  - `no keys: ratings community + critic + friends, tagline, studios, tags, countries, links imdb/tmdb/trakt, collection from BoxSet, sources ['jellyfin']`
  - `with TMDB: collection has 4 parts in TMDB order, part 3 missing with poster /api/seerr/image/…, keywords present, sources includes tmdb`
  - `with OMDb: imdb 8.1, rt 92, mc 81; Jellyfin critic dropped; OMDb looked up with the IMDb id from TMDB when Jellyfin has none`
  - `TMDB times out / 500 → 200 without TMDB parts; OMDb 401 → 200 without OMDb ratings`
  - `kids profile: no friends rating, no missing parts, canRequest false, parts above the age cap absent`
  - `role with requests_per_month 0 → canRequest false; friend role → true`
  - `TMDB part that is in the library but in a library the viewer's role lacks → omitted, not missing` (Review Focus 2)
  - `cache shared: two different users → one TMDB fetch, one OMDb fetch`
  - `buildLinks: 'tt 123', 'tt12', 'abc', '12;x' produce no link; tvdb series vs movie path` (Review Focus 4)
  - `invisible item → 404; no session → 401; response body never contains a stored key`
- [ ] **Step 2:** Run `test/about` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; then the full backend suite.
- [ ] **Step 5:** `git commit -m "feat: GET /api/items/:id/about (ratings, collection, links, facts)"`

### Task 5: Admin page Data sources (web)

**Files:**
- Create: `web/src/routes/admin/sources/+page.svelte`
- Modify:
  - `web/src/lib/admin/nav.ts`: add `{ href: '/admin/sources', label: 'admin.tabs.sources', icon: 'link' }` to the `operations` group after `/admin/digest`. There is no Settings group; operations is where instance settings live.
  - i18n `admin.tabs.sources` ("Datenquellen") and a new `admin.sources` block in all 7 locales: intro, field labels, hint with the provider sign-up pages as plain text, from file, key invalid, OMDb usage "{n} von 900 Abfragen heute", test results per error code, saved/removed/remove confirm
  - `e2e/mocks/admin.ts`: state + routes for `/api/admin/sources*`
- Test: `e2e/tests/admin-sources.spec.ts`, `e2e/tests/admin-sources.mobile.spec.ts`; extend `web/src/lib/admin/nav` tests if present (`activeItem('/admin/sources')`)

**Interfaces:**
- Consumes: the Task 1 routes and `SourceStatus`.
- UI per source, one `AdminCard` each:
  - Status: a `StatusPill` showing "Set · …abcd", "Not set", "From file" or "Key invalid".
  - A `Field type="password" autocomplete="off"` for a new key, plus Save, Test (tests the typed value if any, else the stored key) and Remove (with `confirm`).
  - When `from === 'file'`, the field and the Save/Remove buttons are disabled and a hint explains why.
  - The OMDb card also shows today's usage.
  - After Save the field is cleared; the key is never echoed back or put in the DOM again.

- [ ] **Step 1: Write failing e2e tests:**
  - `set key → pill shows …abcd; page HTML (page.content()) does not contain the typed key after save`
  - `test → success toast; mocked invalid → error text "Schlüssel ungültig"`
  - `remove asks for confirmation, then pill "Nicht gesetzt"`
  - `from file: field and Save disabled, hint visible`
  - `OMDb usage "12 von 900"`
  - `nav: Data sources link under Betrieb, active on /admin/sources`
  - mobile: `no horizontal overflow; buttons ≥ 44 px`
- [ ] **Step 2:** Locked build + run → FAIL.
- [ ] **Step 3:** Implement page, nav entry, i18n (7 locales), mocks.
- [ ] **Step 4:** Locked build; run the new specs plus `admin-shell*` → PASS. Run `npx -w web vitest run src/lib/i18n`.
- [ ] **Step 5:** `git commit -m "feat(admin): data sources page for TMDB/OMDb keys"`

### Task 6: Detail page restructure (web)

**Files:**
- Create:
  - `web/src/lib/detail/about.ts`: types mirroring `AboutDto`, plus:
    - `loadAbout(id: string, profileId: string, apply: (a: About) => void): Promise<void>`: `swrLoad` over a module `createSwr(10 * 60_000)` with key `profileId + ':' + id`; errors are swallowed, so the page stays as is
    - `ratingParts(a: About | null): Array<{ key: RatingKey; text: string }>`: `★ 7.8`, `IMDb 8.1`, `RT 92 %`, `MC 81`, `Kritiker 92 %`, `Freunde 4.5 ★`; numbers via `fmtNumber`, one decimal for /10 and /5
    - `type DetailTab = 'episodes' | 'details' | 'more' | 'extras'`
    - `detailTabs(type: string, hasExtras: boolean): DetailTab[]`: Episodes (Series only) · Details · More like this · Extras (only with extras)
    - `defaultTab(type: string): DetailTab`: `'episodes'` for Series, else `'details'`
  - `web/src/lib/detail/RatingsLine.svelte`: props `about: About | null | undefined` (undefined = loading → fixed-height placeholder `min-height: 1.6rem`, `aria-hidden`); hidden when there are no parts; on phones it scrolls horizontally with no wrap
  - `web/src/lib/detail/DetailsTab.svelte`: `InfoBlock` (minus its cast line, because the cast row is above the tabs), then the new facts (studios, tags + keywords, release date via `fmtDate`, original title, countries via `Intl.DisplayNames` when an ISO code, else as given), then links (`target="_blank" rel="noopener noreferrer"`, text label + `link` icon), then `SocialCard`, then the visible `DownloadButton` (desktop, non-series)
  - `web/src/lib/detail/SocialCard.svelte`: `Reactions` (Movie/Episode) and the friends' star panel moved from `DetailView` (stars, review, list) as one card; hidden on kids profiles
  - `web/src/lib/detail/about.test.ts`
  - `e2e/tests/detail.spec.ts`, `e2e/tests/detail.mobile.spec.ts`
- Modify:
  - `web/src/lib/detail/DetailView.svelte`. New body order for both variants and phone/desktop:
    1. meta line + `TitleFacts`
    2. `RatingsLine`
    3. tagline (`<p class="tagline">`, italic)
    4. synopsis; on phones clamped to 4 lines (`-webkit-line-clamp: 4`) with a "Mehr"/"Weniger" button (`aria-expanded`), shown only when the text overflows
    5. language line, `FriendsStrip`, messages and the recommend panel (as today)
    6. collection slot (filled in Task 7)
    7. `StoryCard` (series)
    8. `CastRow`
    9. tabs, always shown, from `detailTabs`, default from `defaultTab`
  - Also in `DetailView.svelte`:
    - Remove the right-hand `dl.right` (cast/genres/moods duplicate the cast row and the Details tab) and the old bottom `Reactions` / `.rate` / `CastRow` / `InfoBlock`.
    - Panels stay mounted and switch with `hidden`, so the `DownloadButton` binding for the ⋯ menu keeps working.
    - `toInfo()` now selects the Details tab, then scrolls.
    - Phone: the tab bar is `position: sticky` (`top: var(--nav-h)` on the page, `0` in the modal) with a `--dv-bg` background; tabs ≥ 44 px high.
    - TV (`html.tv`): every tab is focusable (`tabindex=0`) and focusing a tab selects it; ArrowDown from the tab bar focuses the first focusable element of the active panel, and ArrowUp from that element returns to the active tab. Nothing else changes in TV mode.
    - `about` loads after the first paint (`requestAnimationFrame` after `item` is set) through `loadAbout`.
  - `web/src/lib/detail/InfoBlock.svelte`: prop `cast = true` to drop the cast line
  - i18n `detail.about.*` in 7 locales: tab "Details", ratings aria labels, critics, friends, more/less, studios, tags, release date, original title, countries, links heading, "opens in a new tab" sr text
  - `e2e/mocks/api.ts`: default `GET /api/items/:id/about` → `{ ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], collection: null, canRequest: false, sources: ['jellyfin'] }` (the `api` fixture fails on unmocked calls)
  - `e2e/tests/hubs.spec.ts` (`without extras there are no tabs` becomes `without extras the tabs are Details and Mehr davon`, default Details), `e2e/tests/item.spec.ts`: adjust expectations that the new layout changes on purpose, and only those
- Test: as listed.

**Interfaces:**
- Consumes: the `AboutDto` contract from Task 4.
- Produces for Task 7: `About['collection']`, a slot point in `DetailView` right after the synopsis block (`{#if about?.collection && item.type === 'Movie'}<CollectionRow … />{/if}`), and `loadAbout`.

- [ ] **Step 1:** Measure the "before" state. Add `e2e/tests/detail-measure.spec.ts`, which records `document.scrollingElement.scrollHeight` of `/item/<MOVIE.id>` and `/item/<SERIES.id>` at 1440×900 and 390×844 as `test.info().annotations` and always passes. Run it on the current code and note the numbers for the PR.
- [ ] **Step 2: Write failing tests:**
  - unit `about.test.ts`:
    - `ratingParts(null) → []`
    - `all six ratings → order community, critic, imdb, rt, mc, friends texts`
    - `only friends → ['Freunde 4.5 ★']`
    - `critic absent when rt present` (the server already drops it, so test the pure mapping keeps the order with gaps)
    - `detailTabs('Series', false) → ['episodes','details','more']`
    - `detailTabs('Movie', true) → ['details','more','extras']`
    - `defaultTab('Series') → 'episodes'; defaultTab('Movie') → 'details'; defaultTab('Episode') → 'details'`
  - e2e `detail.spec.ts`:
    - `no keys: ratings line shows ★ and Freunde, tabs Details/Mehr davon, Details selected, studios + links visible`
    - `mocked keys: IMDb/RT/MC in the ratings line; every external link has target _blank and rel "noopener noreferrer"`
    - `tagline in italics under the ratings line`
    - `series: Episodes tab selected by default; Details tab shows the info block`
    - `about request starts after the hero is painted and the ratings placeholder keeps its height (no layout shift: bounding box of the synopsis unchanged before/after about resolves)`
    - `TV: focus moves from the play button down to the tabs, Right selects Mehr davon, Down enters its panel, Up returns to the tab`
    - `kids profile: no Freunde rating, no social card`
    - `switch from the main profile to a kids profile: no friends' rating from the cached about` (Review Focus 5)
    - `modal variant (open from a card): same tabs and ratings line`
  - e2e `detail.mobile.spec.ts`:
    - `synopsis clamped to 4 lines with Mehr; Mehr expands, aria-expanded true`
    - `tab bar sticks under the app bar while scrolling (boundingBox.y ≈ nav height after scrolling 1500 px)`
    - `ratings line scrolls horizontally, page has no horizontal overflow`
    - `tabs ≥ 44 px high`
- [ ] **Step 3:** Locked build, run → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Locked build; run `detail*`, `item`, `hubs*`, `kids*`, `fresh*`, `popout`, `player-transition` and the unit tests → PASS. Run `detail-measure` again and note the "after" numbers.
- [ ] **Step 6:** `git commit -m "feat(detail): ratings line, tagline, always-on tabs with Details, phone sticky tabs"`

### Task 7: Collection row (web)

**Files:**
- Create: `web/src/lib/detail/CollectionRow.svelte`
- Modify:
  - `web/src/lib/detail/about.ts`: `collectionView(c: AboutCollection): { index: number; total: number; next: AboutPart | null }`
    - `index` is the 1-based position of the `current` part; `total` = `parts.length`.
    - `next` = the part right after the current one if it is `inLibrary && !played`, else null.
  - `web/src/lib/detail/DetailView.svelte`: render it in the Task 6 slot
  - i18n `detail.collection.*` in 7 locales: "Teil {i} von {n} · {name}", "Weiter mit Teil {n}", "Nicht in der Bibliothek", "Anfragen", "Angefragt", request errors (limit reached and others; reuse the existing request texts where one exists)
  - `e2e/mocks/api.ts`: nothing new by default (`collection: null`)
- Test: `about.test.ts` (extend), `e2e/tests/detail-collection.spec.ts`, `e2e/tests/detail-collection.mobile.spec.ts`

**Interfaces:**
- Consumes: `About`, `AboutPart`, `AboutCollection`, `loadAbout` (Task 6); `POST /api/requests { mediaType: 'movie', tmdbId }` (existing; 409 `already_requested`, 429 `request_limit`).
- UI:
  - Heading "Teil 2 von 4 · <name>", plus a "Weiter mit Teil 3" link to `/item/<id>` (modal variant: `swapModal`, as `MoreLikeThis` does).
  - A horizontal poster row:
    - Library parts link to their item and use `img(id, 240)`; a watched part gets a check badge; the current part has an outline and `aria-current="true"`.
    - Missing parts use their `poster` (proxy URL) at 50 % opacity and grayscale and are not links. Under them is a "Request" button when `about.canRequest`; after success it shows "Angefragt" and is disabled.
  - Phones get smaller posters (≈ 96 px wide instead of 140 px) and ≥ 44 px buttons.
  - TV: the row is a normal focus row and needs no special code.

- [ ] **Step 1: Write failing tests:**
  - unit:
    - `collectionView: current 2 of 4, next part 3 in library unwatched → next = part 3`
    - `next watched → null`
    - `next missing → null`
    - `current last → null`
  - e2e:
    - `heading "Teil 2 von 4 · Matrix-Reihe" and "Weiter mit Teil 3" link`
    - `posters in given order; watched tick on part 1; part 2 aria-current`
    - `missing part greyed, Anfragen posts {mediaType:'movie', tmdbId} once and shows Angefragt`
    - `canRequest false → no Anfragen button`
    - `no collection → no row`
    - `modal: Weiter mit Teil 3 swaps the dialog content`
  - mobile: `smaller posters, no horizontal page overflow, Anfragen ≥ 44 px`
- [ ] **Step 2:** Locked build, run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Locked build; run the collection specs plus `detail*` → PASS.
- [ ] **Step 5:** `git commit -m "feat(detail): collection row with order, watched ticks and requests for missing parts"`

### Task 8: Final verification and docs

- [ ] Run lint, typecheck, web unit, gateway and the full backend suite, then the locked web build and the full e2e (desktop + mobile). Everything must be green; record the counts.
- [ ] Report the scroll heights before and after from `detail-measure` (Movie and Series, 1440 and 390 px) for the PR.
- [ ] Docs:
  - `CHANGELOG.md` *Unreleased*: a "Detail page" entry (ratings line, collection row, Details tab, links, phone sticky tabs) and a "Data sources" entry (optional TMDB/OMDb keys, cache, budget)
  - README EN + DE: one feature line each, plus config table rows `TMDB_API_KEY(_FILE)` / `OMDB_API_KEY(_FILE)` ("optional; or set in Admin → Data sources")
  - `docs/integrations.md` (+ `docs/de/` counterparts where they exist): new "TMDB / OMDb (optional)" section covering where to get keys, what is fetched, the 7 d / 1 h cache, the 900/day OMDb budget, the 401 pause, that keys never leave the server, and that `*_FILE` wins
  - `docs/operations.md`: key rotation via the admin page or the secret file
  - `docs/architecture.md`: endpoint list (`/api/items/:id/about`, `/api/admin/sources*`)
- [ ] Run gitleaks on the branch (check the exit code directly). Grep the built web bundle and the e2e HTML snapshots for the test keys: no hits.
- [ ] Open the PR. After the merge, port to the Plex fork: implement `itemAbout` (Plex `Guid` → provider IDs, `tagline`, `studio`, `Country`, `originalTitle`, `rating`/`audienceRating`) and `itemCollections` (Plex collections of the item); the keys, the endpoint and the UI come in through the merge.

---

## Rulings on open spec points

- **Env without `_FILE`:** `TMDB_API_KEY` / `OMDB_API_KEY` set directly in the env count as `from: 'file'`. `config.ts` merges both, and the spec only knows `db | file`.
- **Info block contents:** the Details tab keeps age rating (with "Ab 12 Jahren") and quality as the spec lists them; it drops the cast line (the cast row sits above the tabs). The desktop right column (cast/genres/moods) is removed because it duplicates the Details tab.
- **Jellyfin critic rating vs. OMDb RT:** both come from the same source, so the Jellyfin value is shown as "Kritiker" only when OMDb gives no RT.
- **"Part N of M" for kids:** missing parts are dropped for kids profiles, so M counts the parts they can see.
- **Collections:** for films only. A collection needs ≥ 2 visible parts. A part that is in the library but invisible to the viewer is omitted rather than shown as missing.
- **Request permission:** "may request" = not a kids profile and the role's monthly wish limit is not 0.
- **Test button:** tests the typed (unsaved) value if there is one, else the effective key.
- **Admin placement:** there is no Settings group in the admin nav, so Data sources goes under *Betrieb* (operations).
