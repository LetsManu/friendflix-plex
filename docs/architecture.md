# Architecture notes

## Media server seam

FriendFlix talks to its media server through one neutral interface. Today the only implementation is Jellyfin; the seam exists so that another server (a fork adds Plex, for example) can be added mostly by **adding** files instead of editing shared ones.

### Backend

| File | Role |
|---|---|
| `backend/src/media/types.ts` | The `MediaServer` interface, its `admin` sub-interface (`MediaAdmin`), the normalized DTOs (`ItemDto`, `PlaybackDto`, `TrickplayDto`, `DownloadSourceDto`, …), `MediaCapabilities` and the `MediaError` base class. Nothing in here knows Jellyfin. |
| `backend/src/media/index.ts` | `MEDIA_SERVERS` (the accepted `MEDIA_SERVER` values) and the one factory `createMediaServer()`. The only shared file that imports an implementation. |
| `backend/src/jellyfin/*` | `JellyfinService implements MediaServer` (`service.ts`), the HTTP client (`client.ts`), Jellyfin JSON → DTO mapping (`dto.ts`). `JellyfinError extends MediaError`. |

Routes and jobs use `ctx.jf` (the name is kept from the Jellyfin-only days; its type is `MediaServer`). They never build server paths themselves. A test (`backend/test/media-seam.test.ts`, "seam boundary") fails when a file outside `jellyfin/` and `media/index.ts` imports from `jellyfin/`.

What the interface covers, grouped:

- **Credentials and raw media:** `mediaAuth(user)` (token + device id for the gateway, Chromecast and Plan B), `planBAuthHeader`, `mediaFetch(user, path)` (playlists and segments from a `PlaybackDto` / `DownloadSourceDto` / `clipTranscode`; only server-relative paths, absolute and protocol-relative URLs are refused), `clipTranscode(user, info, limits)` (async; preview clips and the playback health check), `stopEncoding`, `subtitleStream(user, item, mediaSource, index, 'vtt')`.
- **Browse:** `views`, `items(ItemQuery)`, `item`, `resume`, `history`, `nextUp`, `nextEpisode`, `seasons`, `episodes`, `firstEpisode`, `upcoming`, `similar`, `lastWatched`, `unplayedIds`, `collections`, `genres`, `studios`, `facets`, `extras`, `trailers`, `trailer`, `people`, `searchPeople`, `person`, `tracks`, `segments`, `addedItems`, `itemTraits`, `continuingSeries`, `premieringEpisodes`, `availableEpisodes`, `seasonEpisodeIds`.
- **User data:** `setFavorite`, `setPlayed`, `setUserData`, `touchUserData`, `forgetItems`, `userDataVersion`.
- **Playback:** `playbackInfo`, `playMeta` (resume position + trickplay), optional `preparePlayback`, `downloadSource`, `report({ event, itemId, mediaSourceId, playSessionId, positionTicks, paused, … })`.
- **Admin-key lookups:** `searchSubtitles`, `downloadSubtitle`, `findByTmdb`, `seriesHasEpisode`, `libraryStreams` (language index).
- **`admin`:** `createIdentity`, `deleteIdentity`, `applyPolicy(id, { template, disabled, hidden, parental })`, `setDisabled`, `libraries`, `ping`, `externalSessions` ("now playing" from other apps).

Conventions: item ids are 32 lower-case hex characters (an implementation with other ids encodes them), item types and sort keys use the existing vocabulary (`Movie`, `Series`, `Episode`, `BoxSet`; `SortName`, `DateCreated`, `PremiereDate`, …), positions are in 100 ns ticks. Upstream failures throw a `MediaError` subclass with an HTTP-like `status`; `routes/_shared.ts` `wrap()` and the routes map it (listed statuses → 404, otherwise 502 `{error:'jellyfin'}` – the error name stays for API compatibility).

**Capabilities.** `ctx.jf.capabilities` says what the server can do: supported skip-segment types, trickplay, upcoming episodes, remote subtitle search, webhooks, a change feed and Plan B. The backend sends them once in `/api/me` (`server: { kind, capabilities }`, also `GET /api/server`); the web keeps them in `web/src/lib/capabilities.ts` (default: everything supported) and hides the skip buttons / timeline marks of unsupported segment types, the subtitle search and the calendar link. Jellyfin reports everything, so nothing changes visibly.

**Configuration.** `MEDIA_SERVER` (default `jellyfin`; the only accepted value in this repository) selects the implementation in the backend and in the gateway. Each kind lists its required settings in `config.ts` (`MEDIA_REQUIRED`: `JELLYFIN_URL`, `JELLYFIN_ADMIN_API_KEY` for Jellyfin); `mediaConfigProblems()` in `media/index.ts` can refuse settings a kind cannot work with at startup.

### Hooks for servers that work differently

All optional or no-ops for Jellyfin, so nothing changes there:

| Hook | Where it runs | Purpose (e.g. Plex) |
|---|---|---|
| `preparePlayback?(user, info, opts)` | `POST /api/playback/info` and the cast start, right after `playbackInfo()`, before the client loads the master playlist | transcode decision plus per-account audio/subtitle selection under a lock; returns the `PlaybackDto` with session-bound URLs. Doing it inside `playbackInfo()` is equally fine. `clipTranscode()` is async for the same reason. |
| `subtitleStream()` + `capabilities.subtitleExtract` | `GET /api/items/:id/subtitle/:ms/:index/stream.vtt` (visibility-checked) | servers that cannot deliver WebVTT: the implementation extracts/converts and puts this URL into `PlaybackDto.subtitles[].url`. Jellyfin: `false`, subtitles keep their gateway path. |
| `webhookEvents?(body)` | `POST /internal/webhook/<kind>` (Jellyfin: `/internal/webhook/jellyfin`, path unchanged) | translates the server's webhook into neutral `MediaEvent`s (`itemAdded`, `itemRemoved`, `playback`). |
| `start?(runtime)` / `stop?()` | `server.ts` after listen / on SIGTERM | change feeds (websocket, sync jobs) that call `runtime.dispatch(event)`. |

Every event, whatever its source, goes through `media/events.ts` `dispatchMediaEvent()`: reminders ("Erinnere mich"), "now playing" entries and user-data caches, then `bus` event `media.event` for other features. `report()` takes a neutral body; the Jellyfin field mapping (`/Sessions/Playing…`) lives in the Jellyfin implementation.

### Gateway

`gateway/src/upstream/types.ts` defines the `Upstream` adapter: the path allowlists (cookie and Chromecast), the direct-stream and image patterns, the query parameters that carry credentials or caps, and `authHeaders(credentials)`. `gateway/src/upstream/jellyfin.ts` is the Jellyfin adapter, `gateway/src/upstream/index.ts` holds the registry and `selectUpstream(MEDIA_SERVER)`, which refuses unknown values. `createGateway({ upstream, upstreamUrl, … })` takes the adapter; everything else (authorization against the backend, clamping, cast scope checks, playlist sanitising with the adapter's credential parameters, downloads) stays generic. Two optional adapter hooks (absent for Jellyfin):

- `authorize(ctx)` – per-request access check after the allowlist / session / direct-stream checks, for servers the gateway reaches with one server-wide token. `ctx.checkItem(itemId, kind)` asks the backend `POST /internal/authz/item {sid, itemId, kind}` (internal secret; answers `{allow}` from the active profile's visibility via `ctx.jf.item`, 401 without a usable session; memoised 5 s on both sides, dropped on a profile switch). On the Chromecast route it compares with the token's item scope. `false` → 403, a throw → 503.
- `rewrite(path, query)` – maps the public `/media/…` shape (what the web and the DTOs use) to the upstream request; the result must stay server-relative (else 502). The shared `test-vectors/media-paths.json` results are unchanged for the Jellyfin adapter.

### Adding an implementation (fork)

New files only:

1. `backend/src/<kind>/…` with a class implementing `MediaServer` (and its errors extending `MediaError`), reporting honest `capabilities`, plus whichever hooks it needs.
2. `gateway/src/upstream/<kind>.ts` with an `Upstream` adapter (and `urlEnv` for its base URL).
3. Tests and a compose override (e.g. `compose.<kind>.yaml`) that sets `MEDIA_SERVER=<kind>`.

Shared lines to touch:

- `backend/src/media/index.ts`: add the kind to `MEDIA_SERVERS` and one line to `factories` (plus its import); refuse unsupported settings in `mediaConfigProblems()` if needed.
- `backend/src/config.ts`: the kind's own variables and its `MEDIA_REQUIRED` entry.
- `gateway/src/upstream/index.ts`: one entry in `UPSTREAMS` (plus its import).

Everything else (routes, jobs, the web, the gateway core) works through the interface.
