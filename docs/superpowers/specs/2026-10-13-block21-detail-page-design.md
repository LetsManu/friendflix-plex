# Block 21 – Detail page: tidier, more info (design)

Status: approved in chat on 2026-10-13, pending review of this written spec.
Scope: FriendFlix main repo first; ported to the Plex fork (LetsManu/friendflix-plex) after merge.
Follow-up: Block 22 "Admin care" (health at a glance, library hygiene, user insight) gets its own spec.

## Goal and context

Viewers open a title's detail page to decide what to watch. Today the page is long: reactions, friends' stars, cast and an
info block stack below the synopsis, and the tabs (episodes / extras / similar) only appear when extras exist. Useful
data that Jellyfin already has is hidden (community rating, studios, tags, provider IDs), and a film's place in a series of
films is not shown at all.

The owner wants a tidier page with less scrolling, more information (ratings, collections in order, links, background
facts) and a good phone view. External data sources are optional API keys set in the admin settings.

Findings from the code (2026-10-13):
- `web/src/routes/item/[id]/+page.svelte` renders `web/src/lib/detail/DetailView.svelte` (`variant="page"`); `ItemModal.svelte`
  uses `variant="modal"`. Phone branch ~360-371, desktop ~397-404, phone CSS ~568-599.
- Body order today: hero → title/meta/age badge → `TitleFacts` → synopsis + genre/mood list → `StoryCard` (series) → tabs
  (only when extras exist: `EpisodeList`, `Extras`, `MoreLikeThis`) → `Reactions` → friends' star panel → `CastRow` → `InfoBlock`
  → download button.
- `ItemDto.communityRating` exists (`backend/src/jellyfin/dto.ts`) but is used only for sorting. CriticRating, provider IDs,
  taglines, original title are not fetched. Studios and tags are mapped into `ItemCreditsDto` but not displayed.
- BoxSets exist (`/api/library/collections`, `web/src/routes/collections`), but the detail page has no "part of a collection".
- No TMDB/OMDb key exists; TMDB is reached only through Seerr (poster proxy `routes/seerr.ts`).
- `app_settings` (key/jsonb) and `crypto.ts` `encrypt/decrypt` with `APP_ENC_KEY` exist.

Non-goals: trivia in the narrow sense (neither TMDB nor OMDb provides it); trailer changes (stay via Seerr); admin health,
library hygiene and user insight (Block 22); changing TV-mode behaviour beyond focus order through the tabs.

## 1. Layout

### Top (visible without scrolling)
1. Hero, title, play buttons (unchanged).
2. Meta line: year · runtime · age rating · quality chips (existing `TitleFacts`; no duplicates elsewhere).
3. **Ratings line (new):** e.g. `★ 7.8 · IMDb 8.1 · RT 92 % · MC 81 · Friends 4.5 ★`.
   - Missing ratings are left out; the line is hidden when empty.
   - Without an OMDb key: Jellyfin community (and critic, if present) rating plus the friends' rating.
   - Kids mode: no friends' rating (as today).
   - Fixed-height placeholder while loading (no layout shift).
4. Tagline (italic) when present.
5. Synopsis; on phones clamped to 4 lines with "More".
6. **Collection row (new, films in a collection only):**
   - Heading "Part 2 of 4 · <collection name>", plus "Continue with part 3" when the next part is in the library and unwatched.
   - Poster row of all parts in release order: watched tick, current part highlighted.
   - Parts not in the library (TMDB key only) are greyed out with "Request" via Seerr, if the role may request.
   - Without a TMDB key only the library parts are shown and "of N" counts library parts.

### Tabs (always shown)
- **Episodes** (series only) · **Details** · **More like this** · **Extras** (only when extras exist).
- Default tab: Episodes for series, Details for everything else.
- The cast row stays above the tabs.
- **Details** tab contains, in this order:
  - Info block: director, writers, genres, moods, quality, age rating (no item that is already in the meta line).
  - **New:** studios, tags and TMDB keywords, release date, original title (if different), production countries.
  - **New:** links to IMDb, TMDB, TVDB and Trakt built from provider IDs; open in a new tab with `rel="noopener noreferrer"`.
  - Reactions and friends' stars as one compact card.
  - Download button.
- `StoryCard` (series) stays above the tabs, as today.

### Phone
- Compact title block, sticky tab bar while scrolling, ratings line scrolls horizontally, smaller collection posters,
  touch targets ≥ 44 px.

### Unchanged
- TV mode (focus moves cleanly into and through the tabs), the modal variant (same structure), kids mode.

## 2. Data sources and keys

### Keys in the admin settings
- New admin page **Settings → Data sources** (`/admin/sources`, kit components, all 7 languages) with fields for the TMDB key
  and the OMDb key, each with a "Test" button.
- Stored encrypted with `APP_ENC_KEY` (`crypto.ts`) in `app_settings` (keys `source.tmdb`, `source.omdb`).
- Keys never leave the server: the API returns only `{ set: boolean, last4, from: 'db' | 'file' }`; change and remove buttons.
- `TMDB_API_KEY_FILE` / `OMDB_API_KEY_FILE` (env) also work and take precedence; the UI shows "from file" and disables editing.
- Every key change is written to the audit log (without the key).
- Admin-only endpoints: `GET/PUT/DELETE /api/admin/sources/:name`, `POST /api/admin/sources/:name/test`.

### Endpoint
- New `GET /api/items/:id/about` → one response with: ratings, collection, links, studios, tags, keywords, tagline,
  original title, release date, countries, and per part its source (`jellyfin` | `tmdb` | `omdb`).

### Where data comes from
- **Jellyfin (always):** community rating, critic rating (if present), provider IDs (IMDb, TMDB, TVDB) → links, tagline,
  studios, tags, countries, premiere date, original title; collections: BoxSets containing the item, with their library parts.
- **TMDB (key only):** full collection with missing parts and their posters (through the existing image proxy, no key in
  URLs), keywords; IMDb ID filled in via the TMDB ID when Jellyfin lacks it.
- **OMDb (key only):** IMDb, Rotten Tomatoes and Metacritic ratings via the IMDb ID.
- **Friends' rating:** from the existing `/ratings` data.

### Cache and limits
- TMDB/OMDb responses cached 7 days, failures 1 hour, in the existing `kv` layer, keyed by external ID (shared by all users).
- OMDb budget: at most 900 calls per day (free tier is 1000); beyond that cache only; today's count visible to the admin.
- 3 s timeout per external call; a slow or down source is left out of the response, never a 500 and never a slower page.

### Visibility
- Collection parts in the library are filtered by the same rules as everywhere (role libraries, age cap, kids profile).
- Missing parts (TMDB) are not shown to kids profiles.
- "Request" only when the role may request.

### Seam (Plex fork)
- The endpoint works behind the existing `MediaServer` interface via two new optional methods: item info with provider IDs
  (`itemAbout`) and the collections of an item (`itemCollections`). Jellyfin implements both now; the fork maps Plex data
  later. Absent methods mean the Jellyfin-only parts are empty.

## Error handling

- No keys: only Jellyfin data; empty sections hidden; no "key missing" hint for viewers.
- Wrong or expired key: "Test" shows the error at once; in operation a 401 pauses that source for 1 hour; the admin page
  shows "key invalid" (Block 22 adds it to the admin warning banner).
- OMDb daily limit reached: cache only; the counter resets at midnight UTC.
- Title without IMDb/TMDB ID: links and external ratings are left out.
- `about` loads after the first paint; the browser SWR cache shows the last data at once on a second visit.

## Testing

- Backend:
  - keys stored encrypted, never in responses or logs, file takes precedence, test endpoint admin-only
  - `about` without keys, with TMDB, with OMDb; timeout and 401 pause; OMDb daily limit
  - collection filtered by role / age cap / kids; missing parts hidden for kids
  - cache hit shared between users
- Web unit: ratings line with any combination; collection order and "Continue with part N"; default tab per type.
- e2e:
  - detail page without keys
  - with mocked keys: ratings, collection with a greyed missing part and "Request", links with `rel="noopener noreferrer"`
  - phone: sticky tabs, synopsis "More"
  - TV focus through the tabs; kids profile
  - admin data sources: set key, test, remove; no key in the HTML
- Measurement: detail page scroll height before/after at 1440 and 390 px width, reported in the PR.
- Full suite, gitleaks, i18n in all 7 languages.

## Seam impact (Plex fork)

- `MediaServer.itemAbout?` and `MediaServer.itemCollections?` are additive and optional.
- The keys, cache, `/api/items/:id/about` and the UI are server-agnostic.
- The fork port happens after the upstream merge.
