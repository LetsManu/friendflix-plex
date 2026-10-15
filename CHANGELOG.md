# Changelog

All notable changes, grouped by what you notice. Each release has its own section (`## [x.y.z] – Codename – date`, cut by the *Release* workflow); what is not released yet is listed under *Unreleased*.

## [Unreleased]

### FriendFlix for Plex (this fork)
- **Plex media server** behind the neutral interface: `MEDIA_SERVER=plex` selects `backend/src/plex/*` and the gateway adapter `gateway/src/upstream/plex.ts`; `compose.plex.yaml` connects the backend and gateway to an existing Plex server (`PLEX_URL`, `PLEX_TOKEN` / `PLEX_TOKEN_FILE`). Preview: tested against a fake Plex server built from Plex Media Server 1.43 answers, not released.
- **One server-side Plex token**, only in the backend and gateway environment, sent as a header and never to a client. FriendFlix enforces roles, profiles, age limits and kids profiles itself, from a Postgres mirror of the Plex library (sync every 5 minutes, notification websocket, nightly sweep). No plex.tv accounts for friends, no Plex Pass needed.
- **Signed media paths:** part, transcode-session, trickplay and chapter-still paths carry an HMAC; the gateway asks the backend per item before it fetches. Plan B is not supported with Plex (`/internal/authz-nginx` answers `501 plan_b_unsupported`).
- **Blocks 15 to 18 on Plex:** cast & info (guest stars from the episode credits), chapters with stills (when Plex generates chapter thumbnails), picture-and-sound chips and the 4K / HDR filter from Plex stream details, fresh labels (season finale only for series known to be ended), leaving soon, story so far, themed lists, calm mode, admin shell; wishes use local request-service users. Limits (no person images, no skip preview, skip intro only with Plex Pass markers, text subtitles only): feature parity table in [docs/plex.md](docs/plex.md).
- **Block 20 on Plex:** the quality chip's reason comes from the source and Plex's per-stream decision (copy / transcode); a converted stream asks Plex for the chosen rung (`maxVideoBitrate` plus a 1080p / 720p / 480p / 360p `videoResolution`), so a 4K source comes out at the quality the chip shows; the remote limit applies at the transcode start. Playback info is not prefetched on hover with Plex (capability `playbackPrefetch: false`), because that call starts the Plex transcode. `/api/home` works unchanged on the Plex implementation.
- **Block 21 on Plex (detail page):** `itemAbout` and `itemCollections` for Plex from the library mirror: tagline, original title, release date, countries, studios, Plex labels as tags, provider ids from `Guid` entries and legacy agent guids (`com.plexapp.agents.imdb://…`, `themoviedb`, `thetvdb`), community score from `audienceRating` and the Rotten Tomatoes critics score from `rating`; the collection row lists the Plex collections of a film with only the parts the profile may see (libraries, age limits, kids), in release order. `/api/items/:id/about`, the Data sources page and the optional TMDB / OMDb keys work unchanged; a TMDB part matched by a legacy-agent copy counts as in the library. The mirror gains tagline and rating-source columns (fork migration 4: movies and shows re-read their details once). Upstream's download fix (stuck at 99 %), the `/diagnose` page and the tab bar alignment come along unchanged.
- **Upstream versions, AirPlay and iPhone fixes on Plex:** AirPlay from Safari uses the same cast tokens and the gateway's compatibility playlist on the Plex cast path (Plex session playlists pass unchanged; Plex's transcoder writes no trickplay image playlist, so there is no `EnableTrickplay` equivalent to set). The footer shows "FriendFlix for Plex 1.0.0 · Arancini"; `compose.plex.yaml` points the update check (`UPDATE_REPO`) at `LetsManu/friendflix-plex`. Issue templates and CONTRIBUTING link to this repository.
- **Block 22 (admin care) on Plex:** *Live streams* reads Plex's `/status/sessions` (play method, output codecs, hardware transcoding, also other Plex apps; FriendFlix's own transcodes are matched by their play session). Plex reports no transcode reasons, so another app's transcode reads as burnt-in subtitles, audio conversion or "other". *Library care* reads `/library/sections/<id>/all?includeGuids=1` (incremental scans with `updatedAt>>=`) plus the stream details of the mirror; *Refresh metadata* calls `PUT /library/metadata/<ratingKey>/refresh`. The cast bar, the request service names (`REQUESTS_URL`, `REQUESTS_API_KEY`), the hover click and the playback-check hints come along unchanged.
- **Blocks 23 (admin users, self-service) and 25 (settings in the database, setup wizard) on Plex:** the setup wizard's media step takes the Plex address and token, checks them (`/identity`, `/library/sections`, `/status/sessions`) and saves them in the database (token encrypted, write-only); both are editable under *Admin → Settings*, which lists only the Plex media settings. A token that works but is not the server owner's is saved with a note (some features may be limited). There is no automatic token: one shared service token, no Plex accounts for friends (a PIN-link flow may follow). `.env` pins still win and show locked; existing installs keep working and can *Move* their values into the database. The gateway gets `PLEX_TOKEN` from the backend over `/internal/gateway-config` (new `gatewayKeys` on the setup provider and the adapter) and the internal secret from the bootstrap volume, so `compose.plex.yaml` needs no `.env` values and gives the gateway no token. A new Plex server (another `machineIdentifier`) rebuilds the library mirror; watch state is kept. Admin user detail shows an active account without its Plex identity as broken (repairable), and approvals, limits, export and deletion work on the synthetic Plex identities. Setup, existing installs, server change and token rotation: [docs/plex.md](docs/plex.md).
- **"FriendFlix for Plex" branding:** wordmark badge, document titles, PWA manifest, README and screenshots.
- **Docs:** README and README.de in the upstream structure worded for Plex, readable architecture diagrams (light and dark) with Plex variants for how it fits together, containers and networks, trust boundaries, press play and the media server seam in [docs/architecture.md](docs/architecture.md), re-shot screenshots (fictional titles and generated artwork) in `docs/images/en` and `docs/images/de`.

### License
- **FriendFlix is now open source** under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Running a modified version as a service for others means offering them its source code.

### Versions & releases
- **Version numbers with codenames:** FriendFlix now has a SemVer version (`version.json`, starting at 1.0.0 "Arancini"). Every major version gets the next cinema snack from A to Z as its codename. The desktop footer shows "FriendFlix 1.0.0 · Arancini"; `GET /api/version` returns version, codename and build sha.
- **Releases:** the manual *Release* workflow (patch / minor / major) bumps the version, moves this changelog's Unreleased section under the new version, tags `vX.Y.Z` and creates a GitHub Release. Images are published as `X.Y.Z`, `X.Y`, `X` and `latest`, so a stack can stay on one major line with `FF_TAG=1`.
- **Admin, Update** compares the installed version with the newest GitHub release ("Update available") and shows its notes under *What's new*. Before the first release, or on a build from main, the commits ahead of the installed build stay as secondary information.
- Tap the version seven times. Just saying.

### Streaming
- **Adaptive quality:** *Auto* picks the quality your connection can carry (the last estimate is remembered per device for 7 days), steps down after a stall or a network error and steps back up once the connection is steady. A chip in the player shows "Original" or "Converted · 720p"; tap it for the reason.
- **Remote limit per role:** outside the home network each role has its own bitrate cap (defaults: friends and family 8, guests 4, admins 12 Mbit/s), set on the admin roles page. Home networks are listed in `HOME_NETWORKS`; the server and the gateway enforce the cap, so the browser cannot raise it. See docs/operations.md.
- **Explicit transcode bitrates:** converted streams ask for video and audio bitrates that match the chosen quality, so the picture is the one the chip shows.
- **Player controls:** on a PC, speed with <kbd>&lt;</kbd> and <kbd>&gt;</kbd>, the mouse wheel over the picture for volume, double-click for fullscreen. On phones larger touch targets, fewer buttons in the bar (speed and scenes under *More*), and menus close on Esc or an outside tap with focus back on the button.
- **Roomier phone player:** on phones the player fills the whole screen and keeps every control inside the safe areas (clear of the Dynamic Island, status bar and home indicator, also in landscape). The title and quality chip sit in the top bar, play/pause with −10/+10 is large in the centre, and the bottom bar shows elapsed time · seek bar · remaining time with one row of icons below it (one line in landscape). The lock moved into *More*; the volume button is hidden on iPhone and iPad, where only the hardware buttons change the volume.
- **Faster home page:** the first screen loads in one request (`GET /api/home`) instead of about a dozen, and the first row's artwork loads first. Old endpoints stay as they were.
- **AirPlay from iPhone, iPad and Mac:** in Safari (and the home-screen app) an AirPlay button appears in the player bar when an Apple TV or AirPlay 2 TV (e.g. LG webOS 2019+) is around. The TV gets a short-lived cast token URL at the current position (same flow and limits as Chromecast, `POST /api/cast/session` with `via: "airplay"`), the token is revoked when AirPlay ends and the phone continues where the TV was. Normal playback keeps hls.js; only a tap on the AirPlay button switches to native HLS (Media Source streams cannot be AirPlayed) and goes back to hls.js if no TV is picked within 30 s. If the TV cannot get its stream, the player offers *Retry* instead of falling back. The button needs casting to be enabled on the server. AirPlay started from Control Center only mirrors the screen. Subtitles are not shown on the TV yet. Phones without AirPlay or Chromecast get a hint to the TV mode (`<host>/tv`, phone as remote) in *More*. See docs/cast.md.
- **Smooth transition into the player:** playback info is fetched early when you hover, focus or touch a play button. The clicked artwork grows into a poster of the title and the picture fades in on the first frame (a plain fade with reduced motion; TV is unchanged).
- **Start-time measurement:** the player measures each playback (playback info, playlist, first segment, first frame, seeks and stalls) and reports it anonymously (no user, title or address; kept 14 days). *Admin → Playback → Start time* shows median and p90 per step for home and remote by device class, marks the slowest step and warns about long remote segments; `/diagnose` lists this device's last 5 measurements. See docs/monitoring.md.

### Watching
- **Cast & info** in the player (<kbd>I</kbd> for a peek, panel for details): cast with characters, guest stars, director, writers, studio, tags; a person opens their other titles. API `GET /api/items/:id/castinfo`.
- **Scenes:** chapter marks on the seek bar, chapter name in the scrub tip and a "Scenes" panel with stills (`GET /api/items/:id/chapters`, optional server capability `chapters`).
- **Clear voices** and **Night mode** (Web Audio, saved per profile as `audioFx`; off while casting or where unsupported).
- **Fresh labels** on cards and detail (new series, season finale, new season, new episode, new), **picture-and-sound chips** (4K, HDR, Dolby Vision, Atmos, 5.1) and **The story so far** card for series after a new-season start or a 6-week break.
- **Leaving soon:** admins set a removal date (nothing is deleted); countdown badge, home row, reminders 7 days and 1 day before for people who have the title on the watchlist or in Continue Watching (never for kids profiles).
- **Skip preview** ("next time on …"), a series-wide audio/subtitle choice, optional "Anime: original audio with subtitles", and an **Extras** tab (trailers, special features).

### Detail page
- **Ratings line** under the title: community and critic scores from Jellyfin, plus IMDb, Rotten Tomatoes and Metacritic when an OMDb key is set, and the average of your friends' ratings. Tagline, release date and country appear when the server knows them.
- **Collection row** for films that belong to a collection: the parts in order ("Part 2 of 3"), watched ticks, the current film marked, and a request button for parts that are missing from the library (not on kids profiles).
- **Details tab**, always present next to Episodes / Extras: age rating, quality, studio, original title, facts and **links** to TMDB, IMDb, TVDB and Trakt where the ids are known. The cast row stays above the tabs; the old right-hand column is gone.
- **Phone:** the tabs stick under the top bar while you scroll, and the page is much shorter (scroll height at 390 px: movie 3117 to 1897, series 3600 to 1796; at 1440 px: movie 2890 to 2244, series 3573 to 2541). API `GET /api/items/:id/about`.

### Data sources
- **Optional TMDB and OMDb keys** (`TMDB_API_KEY` / `OMDB_API_KEY`, or the `_FILE` variants), or set in *Admin, Data sources*: the page shows whether a key is active, where it comes from, lets you test, replace and remove it. Without keys everything still works, the extra data is just left out.
- Answers are cached (7 days, failures 1 hour), every call has a 3 s limit, OMDb is held to 900 calls per day, and a rejected key (401) pauses that source for an hour. Keys stay on the server and are never sent to the browser. See docs/integrations.md.

### Discovering
- **Brand hubs** (up to 8 tiles from a studio, collection, tag or genre; hub pages with *New*, *Popular*, *Movies*, *Series*, A–Z).
- **Themed lists** (emoji, cover colour) that admins pin as home rows; the lists page becomes an editorial page.
- Several **Because you watched …** rows, **Simulcast** page (airing series by weekday and season, "Anime only"), 4K / HDR **browse filters** from a background quality index.
- Search for people, genres, titles and episodes; decade, rating and person filters; person pages.

### Together
- Watch-party **emoji reactions** that float over the picture (rate limited, reduced-motion aware).
- **Episode comments** from friends, withheld until you have watched the episode (plain text, owner-admin moderation).
- Reactions with short comments, "This week with us", reminders, shared and curated lists, group matcher, movie-night polls, wishes from search – see the earlier work below.

### Family and kids
- **Kids profiles:** age limit 0 / 6 / 12 enforced by the server, own `/kids` home and search, every social and account route refused (`kids_profile`, WebSocket close 4403), PIN-gated switching, TV pairing locked to the kids profile.
- **Welcome** for new profiles (`/welcome`): confirm name and colour, pick three liked titles.
- **Calm mode** per profile: no autoplay previews or trailers, no cold-start intro, less motion.
- Owner PIN reset needs a fresh Authentik login and is refused on kid-locked devices.

### Phone and TV
- **Downloads in the background:** on Android (Chrome, Edge, Samsung Internet) a new download runs as a Background Fetch with a progress notification and keeps going with the app closed or the screen locked; the next ready download starts on its own. On iPhone, where iOS stops web apps in the background, a download pauses cleanly instead of showing "Waiting" and continues at the same spot the moment the app is open again. See docs/downloads.md.
- **Cast bar:** casting (Chromecast or AirPlay) keeps running while you browse; a bar at the bottom controls the TV, Play buttons send titles straight to it, the next episode continues on the TV when autoplay is allowed (otherwise the bar offers it), and logging out or switching profile stops it. See docs/cast.md.
- PWA **shortcuts** (Continue Watching, Watchlist, Search, Downloads), an **icon badge** with unread notifications, and a **web manifest in the profile's language** (`/manifest.webmanifest?lang=`).
- Phone layout polish, touch action sheet on cards; TV pairing from kids profiles.
- Seven interface languages (English, German, French, Spanish, Italian, Turkish, Polish) with server texts in the recipient's language and a localized offline page.
- **Fix:** offline downloads no longer stay stuck at "Preparing · 99 %" after the server has finished preparing; the download now starts (also for downloads left in that state on a device).
- **Fix:** in the iPhone home-screen app the header and the top bars (player, offline page, profiles, kids, overlays) no longer sit under the status bar and the Dynamic Island; sticky bars and page content move down with them. Browsers, Android and TV are unchanged.

### Account
- **Account page** (*My space → Account*, `/me/account`, main profile only): change your name and colour (the name is written to Authentik too when the API token is set), see your e-mail (read-only for now) and your two-factor state, with a "Manage on the sign-in page" link to Authentik's user settings. *Sessions & devices* signs out one device (it stays approved), removes one, or signs out all others. A note says that admins can see which titles you watched recently and that every look is audited.
- **Download my data:** one JSON file with your account, profiles, lists, watchlist, ratings, history, requests, devices, notification settings and what you wrote in shared places; never other people's data, notification texts or secrets. Built on demand and streamed, at most 5 per hour (`GET /api/account/export`).
- **Delete account** with a 7-day grace period: after a fresh sign-in (≤ 10 min; `prompt=login`, `max_age=0`) the account is locked at once and the admins are notified. Signing in again within 7 days offers *Restore* (`/restore`); admins can *Restore account* or *Delete now*, and the user list has a *Deletion pending* filter. A background job then deletes the media-server and request-service users, revokes offline licences, deletes the FriendFlix rows, replaces the name in the audit log with a pseudonym (`deleted-<8 hex>`) and deactivates (never deletes) the Authentik user. Each step is resumable; audited at start, on a step's first failure and at the end; a failing step notifies the admins once and is retried every minute. The last active admin cannot delete their own account. See docs/security.md (export contents, deletion steps, what stays) and docs/operations.md.
- **Upgrade note:** the Authentik service account needs the new permission *Can change User* (`authentik_core.change_user`, global in Authentik) for the name change and the deactivation. Re-import `deploy/authentik/friendflix-blueprint.yaml` (or `friendflix-service-account.yaml`). Without it, renaming answers "The sign-in page did not accept the change" and deletions stop at cleanup step 6 until the permission is there or you deactivate the Authentik user by hand (FriendFlix then sees it is inactive and finishes). Without the Authentik API at all, a deleted person's Authentik user stays active: they can sign in again and land in the approval queue as a new person (a member of `ADMIN_GROUP` gets a new admin account instead). See docs/authentik.md §8.4.

### Admin
- **New admin area on a shared UI kit** (`web/src/lib/ui`, docs/ui-kit.md): toasts with Undo, confirm dialogs, data tables with paging and phone cards, status pills, stat tiles; no more native `alert()` / `confirm()`.
- Grouped sidebar (People · Content · Operations) with pending badges, a phone list, and an **overview** (system health, things waiting for a decision with inline approve / decline, plain-sentence activity, storage) from `GET /api/admin/summary`.
- Pages rebuilt on the kit: users, roles, devices, invitations (QR), audit log (server paging and filters), requests, polls, lists, hubs, leaving soon, previews, playback, digest, update, status. Paging, filter and sort params on the list endpoints (response shapes only gained fields).
- Device "unapprove" / remove signs the device out everywhere; admins cannot remove their own device; preview clear / regenerate are audited.
- **Admin: health.** *Status* now shows traffic lights for media server, database, Redis, gateway, login (OIDC issuer check), request service, TMDB / OMDb and the playback check, with response times; disks for downloads, previews and the database (used / free, FriendFlix's own share, one entry when both share a volume; levels from `HEALTH_DISK_WARN_PCT` / `HEALTH_DISK_CRIT_PCT` / `HEALTH_DB_WARN_GB`); active streams with play method, transcode reasons, codecs and hardware flag (also from other apps); failed playbacks of the last 24 h and an error log grouped by kind (server 5xx and background jobs for 7 days, browser and playback reports in memory only). A snapshot is built every 60 s in the background, so the page never waits for a slow service (`GET /api/admin/health`, `?refresh=1` to recheck now). The player reports a playback that really fails (kind `playback`, title id and a short code only). Only reports from a signed-in browser raise the error levels and the banner (anonymous playback reports are not counted at all).
- **Admin: warning banner.** Admins (main profile) see a slim banner under the app bar when something is red or amber, in plain words with a link to the status page. Each issue can be dismissed and stays away until it changes (another level or reason); never shown in the player, a watch party, TV mode, on kids or other profiles.
- **Admin: library hygiene** (*Content → Library care*): finds titles with missing info (overview, poster, backdrop, year, provider ids), language problems (no audio, unknown audio, foreign audio without subtitles, only forced or only image subtitles, measured against the household's languages), duplicates (same ids, same title and year, same episode twice) and file problems (no file, zero runtime, very high bitrate, 10-bit HEVC, codecs that always convert). Filter tiles per category, search, sort, "ignore" per issue, "refresh metadata" per title, and *Check now*. Scans run in the background every 30 minutes (only what changed; a full sweep every 7 days and shortly after new media arrives). Needs the optional media server methods `libraryHygiene` / `refreshMetadata` (Jellyfin has both).
- **Admin: usage** (*People → Usage*): per account for 7, 30 or 90 days: watch time (films / series), titles, streams, share converted with the most common reason, devices and last seen; a row opens a daily bar chart, the devices and the reasons. Aggregates only, no titles. Streams and conversions are counted from today on (`play_daily`), so the first weeks fill up gradually.
- **Admin: user management** (*People → Users*), with tabs *Users*, *Waiting for approval* and *Invites* (`/admin/invites` redirects there):
  - **User list** with avatar, role, profiles, devices, last active and access-until; filters by role, status (active, locked, waiting for approval, expires within 7 days) and last activity; checkboxes for **bulk actions** (change role, lock, unlock, set access-until, sign out everywhere; up to 200 at once, all or nothing). Nobody can lock or demote themselves, and the last active admin can be neither demoted nor locked (`last_admin`). Every change is audited with from / to.
  - **Access until:** an end date per account. FriendFlix reminds the person and the admins three days ahead and locks the account on the day (reason "access ended"); extending it unlocks only accounts locked for that reason, never a manual lock.
  - **Approval queue:** a first sign-in without an invite no longer ends in `no_invite`. The person sees *Request sent* (`/pending`, it updates by itself), the admins get a notification and a warning-banner line ("2 sign-ins are waiting for approval", link to the queue), and an admin approves with a role and optional access-until, or rejects with an optional message.
  - **Invites with several uses** (1 – 50) and **access days** (each new account gets an access-until), shown as "1/3" with the accounts made from each invite; two people taking the last use at once never both get an account.
  - **A page per person** (`/admin/users/<id>`): usage totals, profiles (rename, reset PIN), devices and sessions (sign out one device), downloads, viewing history (each look is written to the audit log), **own limits** that override the role (streams, remote bitrate, downloads, download quality, requests per month), the audit log, linked accounts with *Repair*, and with the Authentik API the **two-factor state** and **Send password link** (needs Authentik 2024.4 or newer and the new service-account permissions in `deploy/authentik/*.yaml`; new optional settings `AUTHENTIK_RECOVERY_FLOW`, `AUTHENTIK_TOTP_SETUP_FLOW`). See docs/authentik.md and docs/operations.md.

### Settings
- **Settings in the database:** every setting that used to need a `.env` line (sign-in, media server, request service, notifications, push, data sources, downloads, playback, updates, health, sessions) is stored in the database and changed under **Admin → Settings**, live on every backend instance (a save publishes only a revision number; other instances reload within seconds, at the latest after 30 s). A value from the environment or a `_FILE` secret still wins and shows locked (*From environment*). Each save tests the affected service first (*Save anyway* when it is only unreachable); secrets are write-only (*Set* / *Not set*, *Replace*, *Remove*); one setting (`DOWNLOAD_CREATE_PER_HOUR`) needs a backend restart and says so. Saving a secret, `PUBLIC_URL`, `HOME_NETWORKS`, `ADMIN_GROUP`, `NTFY_*`, `OIDC_*` / `AUTHENTIK_*` or an address a saved key goes to needs a fresh sign-in, and so does replacing or removing a key under *Admin → Data sources*. Audited with key names only. *Generate new* creates the webhook secret (shown once), *Generate key pair* the Web Push keys. See docs/setup.md and docs/security.md.
- **Setup wizard:** a new install is `docker compose up` and a browser. The backend prints a one-time setup code to its log (`docker compose logs backend | grep "setup code"`, valid 24 h, 5 tries per 15 min per address, locked after 10 wrong codes in total, a restart issues a new one); until setup completes everything else answers `503 setup_required`. The wizard sets the public address (with a reachability check), the media server (*Create API key automatically* signs in to Jellyfin once with an administrator's username and password, creates the key `FriendFlix` and signs out; Jellyfin's own setup must be finished), sign-in (*Automatic* sets up Authentik with a one-time superuser API token: groups, the OAuth2 provider with grant type `authorization_code` and the exact redirect URI, the application, the service account and its token, the enrollment and recovery flows and the brand's password link, in about 30 seconds; or *By hand* with a checklist) and the first admin: the account that signs in from the wizard becomes admin and completes setup (exactly one, also with several backends). Optional extras follow (request service, data sources, downloads, push keys, ntfy/Discord, webhook secret, Portainer). The admin token and the Jellyfin password are never stored or logged; revoke the token in Authentik afterwards. Values from the environment show locked and their steps can be skipped. Existing installs never see the wizard. See docs/setup.md §8, docs/authentik.md §3 and docs/security.md.
- **No secrets to generate by hand:** the new one-shot `bootstrap` service creates the database and Redis passwords, `APP_ENC_KEY` and `INTERNAL_SECRET` in the Docker volume `bootstrap` (root:10001, 0440; the gateway gets only `INTERNAL_SECRET`, in its own volume) and every other service waits for it. The compose files no longer require any variable: a new install needs no `.env` at all.
- **The gateway follows the media server setting:** it fetches the media server URL from the backend at start, every 30 s and right after a change; until one is set, `/media/` answers 503 while `/health` stays up. An environment `JELLYFIN_URL` still wins.
- **The request service is optional:** without `REQUESTS_URL` and `REQUESTS_API_KEY` wishes, the upcoming row and the admin request pages are hidden; *Requests* still lists reminders. Without a webhook secret the webhooks answer 403.
- **Backup = database dump + the `bootstrap` volume:** `scripts/backup-bootstrap.sh` writes it to a tarball. Keep it apart from the dumps; a database restored without it cannot read its secret settings (they show as unreadable and must be entered again) or the stored Jellyfin passwords. See docs/operations.md.
- **Upgrade note:** pull and `up -d`; `.env` keeps working. The `bootstrap` service copies `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_ENC_KEY` and `INTERNAL_SECRET` from `.env` into the volume. Keep them in `.env` until `docker compose logs bootstrap` shows `from environment` for each; removing one earlier generates a new value that does not match the database. An empty `postgres_password` or `app_enc_key` on a used volume stops the `bootstrap` service with an error (set the value in `.env` or restore the volume backup). *Move* / *Move all* in Admin → Settings copies `.env` values into the database before you remove them. A `PUBLIC_URL` with a path or query now starts with its origin and logs one warning (FriendFlix runs at the root only). Override files must not set `POSTGRES_PASSWORD` on the `postgres` service any more. Plan B: read `INTERNAL_SECRET` from the volume as shown in docs/operations.md. The unused `ORIGIN` line of the `web` service is gone. Full list: docs/setup.md §14.

### Media servers and requests
- Jellyfin sits behind a neutral **`MediaServer` interface** (backend) and an **`Upstream` adapter** (gateway), chosen with `MEDIA_SERVER` (default and only value here: `jellyfin`). Capabilities go to the web in `/api/me`; unsupported UI is hidden. Seam hooks for other servers: `MediaDeps.db`, `validateConfig(env)`, `playlist(body, ctx)`, signed cast subtitle URLs, `/internal/authz-nginx` answering 501 `plan_b_unsupported`. Block 17 added the optional `credits`, `chapters`, `mediaTraits`, `libraryMediaTraits` and `libraryContinuingSeriesIds`. Block 20 added the optional capability `playbackPrefetch` (absent = `true`; `false` for servers whose playback info starts the transcode: the web then only warms the player code on hover / focus, no playback info). See docs/architecture.md (containers and networks, press play, seam diagrams).
- **Wishes without Jellyfin accounts:** capability `requestUsers` (`jellyfin-import` for Jellyfin, `local` otherwise) maps each account to a local request-service user (stored id, else same e-mail, else a new user with only the Request permission). See docs/integrations.md.
- **Changed: request service settings renamed** (`REQUESTS_URL`, `REQUESTS_API_KEY`, `REQUESTS_API_KEY_FILE`, compose service `requests`, default URL `http://requests:5055`, webhook path `/internal/webhook/requests`). The old `SEERR_*` names still work and log a deprecation warning at startup (variable names only, never values); the service keeps `seerr` as a network alias and the old webhook path keeps working; the data volume is unchanged (the compose key `requests-config` points at the existing `friendflix_seerr-config` volume).
  **Upgrade note:** rename `SEERR_URL` / `SEERR_API_KEY` in `.env` to `REQUESTS_URL` / `REQUESTS_API_KEY` when convenient (`http://seerr:5055` keeps resolving). With `compose.secrets.yaml`, rename the secret file before `up`: `mv secrets/seerr_api_key secrets/requests_api_key` (compose refuses to start while `secrets/requests_api_key` is missing). Your own override files that name the service `seerr` (e.g. a setup override with ports) must say `requests`.
- Offline downloads re-check that the licence's profile can still see the title and revoke it otherwise. `compose*.yaml` no longer forces `JELLYFIN_URL`; it can also be set in *Admin → Settings → Media server*.

### Security, supply chain and operations
- CI builds carry SBOM and provenance; Trivy findings go to code scanning; `publish.yml` signs each promoted digest with cosign (keyless) and adds GitHub attestations (verification in docs/operations.md).
- **Reproducible images:** rebuilding a commit gives the same image digest (commit time as `SOURCE_DATE_EPOCH`, `rewrite-timestamp`, pinned BuildKit, no cache for published images, web version from the git sha instead of the build clock, no blanket `apk upgrade`). The CI job `reproducible` rebuilds every image from scratch and compares; `scripts/reproduce-image.sh` lets anyone check a release (docs/reproducible-builds.md).
- New **OWASP ZAP baseline scan** job (`.zap/rules.tsv`, report artifact `zap-report`) that `publish` waits for; **OpenSSF Scorecard** workflow and badge; recommended branch protection.
- Optional **Prometheus + Grafana** stack (`compose.monitoring.yaml`, internal network, provisioned datasource and dashboard, no default admin password). Browser errors are reported (scrubbed) to the backend log and counted in `friendflix_client_errors_total`.
- Backup sidecar with verified dumps and a restore test, `Server-Timing` on every response, faster API and media path (single-flight auth, item memo, compression).
- Playwright browser tests with a fully mocked API (desktop and phone) in CI; setup guide and Authentik guide in English and German; README in English and German with screenshots.

### Under the hood
- Migrations 21–33: indexes, `item_langs` / `dropped`, `reactions`, `lists.featured_at`, brand hubs, comments, kids and onboarding columns, `leaving_soon`, themed lists (`lists.themed`, `emoji`, `cover_color`, `featured_pos`), quality index.
- New i18n areas `anime`, `hubs`, `kids`, `together`, `fresh`, `scenes`, `mine`, `ui`, `adminPeople`, `adminContent` in all 7 languages (docs/i18n.md).
- Dev toolchain upgrade (Vite 8, SvelteKit 3, vitest 5, TypeScript 6; `#lib` subpath imports).
- Test coverage gates: at least 90 % statements and 80 % branches in backend, gateway and web (every TypeScript module counts); CI fails below the per-package thresholds (CONTRIBUTING.md).

## Earlier work

The history before the groups above, newest first, as originally written.

#### Browser-Fehler & E2E
- Browser error reporting: `POST /api/client-errors` (unauthenticated, rate limited, logged scrubbed, counted in `friendflix_client_errors_total`), `web/src/lib/telemetry.ts` + `hooks.client.ts` (dedupe 60 s, max 10 per page load, extension/ResizeObserver noise filtered). See docs/monitoring.md.
- Playwright browser tests in `e2e/` (API fully mocked, run against the built web app; `npm run e2e`) and an `e2e` CI job.
#### Block 10 – Wünsche aus der Suche, kuratierte Reihen
- Search shows "Noch nicht in der Bibliothek" with request service results and a "Wünschen" button (hidden when the request service is unavailable).
- Admins can feature up to 5 lists (Admin → Listen); they appear as rows on everyone's home page ("Empfohlen von …") and are readable by all, with titles filtered per profile. Migration 24: `lists.featured_at`.
#### Block 9 – Trending, Neue Folgen, Reaktionen
- Home row "Diese Woche bei uns": what friends watched in the last 7 days (counts only; a title needs 2 viewers unless you are one of them).
- "Neue Folgen" badge on series you started that got episodes in the last 14 days.
- Reactions on films and episodes (Gefällt mir, Witzig, Wow, Traurig, Liebe + short comment), visible only after you watched it – spoiler protection like the TV Time pattern. Migration 23: `reactions`.
#### Touch & images
- Touch action sheet on cards, series name on episode cards, srcset/sizes for card/hero/quick-view images, ItemModal accessibility (inert background, labelled dialog).
#### Block 7 – Sprache, Watch-Status, Freunde
- Audio/subtitle language filter in Filme/Serien ("Ton", "Untertitel", quick toggle "Deutscher Ton"), backed by a background index of all MediaStreams (`item_langs`, every 12 h); the item page lists audio and subtitle languages.
- Watch status per profile: "Geplant" (Merkliste) and "Abgebrochen" (leaves Weiterschauen and Nächste Folge), plus derived "Schaue ich gerade"/"Gesehen"; Merkliste has tabs Geplant | Abgebrochen.
- Friends strip on the item page: who recommended it to you, friends' stars (only with "Bewertungen teilen") and who watched it (only with "Verlauf teilen").
- Gemeinsam schauen: titles on participants' lists first ("2× geplant", never who), titles someone dropped or thumbed down are left out.
- Migration 22: `item_langs`, `dropped`.
#### Discovery upgrade – Suche, Personen, Filter
- Search finds people, genres, titles and episodes in grouped sections (`GET /api/search`), a 4-digit query lists titles of that year; loading/error/empty states, recent searches, `/` or Ctrl/Cmd+K focuses the search.
- Person pages (`/person/<id>`, `GET /api/people/:id`) with the filmography limited to the viewer's library; the item page shows a linked "Besetzung & Crew" row.
- Browse: decade, minimum rating and person filters (`decade`, `year`, `minRating`, `person` on `/api/library/items`), removable filter chips, Filme/Serien switch keeps filters, stale responses are dropped; library pages keep search/sort/filter in the URL.
- Item page and quick view: a failing side request (ratings, seasons, next up) no longer shows "Titel nicht gefunden"; favourite/watched/follow/rating report failures.
- Privacy: `GET /api/items/:id/ratings` requires the viewer to see the title and hides ratings of users who turned off "Bewertungen teilen".
- "Gemeinsam schauen" applies genre/runtime filters to the whole common set (up to 2000 titles) instead of the first 400.
- Migration 21: indexes `ratings(item_id)`, `thumbs(user_id)`; genre lists cached 10 min per Jellyfin user.
- Research notes: `docs/research/streaming-product-upgrade.md`.
#### Block 5 – Offline-Downloads
- Filme und Folgen aufs Gerät laden und offline ansehen (Menü → Downloads, `/offline`): Server bereitet MP4-Dateien vor (HLS → ffmpeg-Remux, wiederaufnehmbar), der Browser lädt sie per Range in OPFS; Lizenzen pro Gerät mit Ablauf, Online-Prüfung und Widerruf. Rollenfelder „Downloads erlauben“, „Max. Downloads“, „Max. Download-Qualität“, „Gültigkeit (Tage)“; Admin → Wiedergabe-Check zeigt Jobs und Speicher. Neue Variablen `DOWNLOADS_ENABLED`, `DOWNLOAD_DIR`, `DOWNLOAD_CACHE_MAX_GB` u. a., neues Volume `downloads`. Kein DRM, siehe `docs/downloads.md`.
#### Block 4 – PWA, push, Chromecast
- Installable app (manifest, iOS meta, service worker caching only static assets; never /api, /media, HTML or Range requests) with an offline page.
- Web push per device (Einstellungen → Benachrichtigungen, "Test senden"): VAPID keys via `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (`node scripts/gen-vapid.mjs`), endpoint allowlist, generic text on devices enabled by non-owner profiles, revoked with the device.
- Chromecast (Default Media Receiver) from Chrome/Android: short-lived, item-scoped, revocable cast tokens under `/media/c/<token>/…` checked by the gateway (CORS only there, playlist sanitizer, failed-auth limit); NPM should log nothing for `/media/c/` (see `deploy/npm/portal.advanced.conf`, `docs/cast.md`). CSP allows `https://www.gstatic.com` scripts for the Cast SDK.
#### Block 3 – Digest, shared lists, reminders
- Weekly digest ("Wochenrückblick"): new films/episodes, new episodes of followed series, fulfilled wishes, friends' tips; `/digest` page, schedule via `DIGEST_DAY`/`DIGEST_HOUR` or Admin → Wochenrückblick, opt-out in settings. Personal ntfy topic per account (never the shared ntfy/Discord channel).
- Shared lists: owner invites editors/viewers, "Zu Liste hinzufügen" on cards/detail page, only titles visible to the viewer's profile are shown.
- "Erinnere mich" on Demnächst and future calendar episodes: notification when the title is in the library (request service webhook, optional Jellyfin `ItemAdded` webhook, 30-min fallback), deduplicated with series follows and own requests.
#### Block 2 – Profiles & viewing comfort
- Profiles per account (max 5, optional 4-digit PIN, "Wer ist heute dabei?"): each extra profile is a hidden Jellyfin user with the account's role policy, so progress, favourites, watchlist and viewing prefs are per profile; stream limit, requests, ratings and admin rights stay per account (admin only from the owner profile). "PIN vergessen?" re-login clears the owner PIN. Turn off the request service's automatic Jellyfin user import so profile users don't show up there.
- Verlauf page (remove an episode or a whole series), tidier "Weiterschauen" (no near-finished/barely-started items, one entry per series, X to hide).
- "Noch da?" after N autoplayed episodes or 90 min without input; subtitle style (size, colour, background, font); spoiler protection for unwatched episodes.
#### Reliability block 1
- Guests: playback capped at 1080p, transcoding allowed in the role policy (re-applied once to existing users on start); watch progress no longer lost on early stop.
- Nightly playback check (`PLAYBACK_CHECK_HOUR`, -1 = off) with admin alert; watch-party size limit; home page retries failed rows.
- Fix: `compose*.yaml` did not pass `PORTAINER_*`, `UPDATE_REPO`, `GITHUB_TOKEN`, `PLAYBACK_CHECK_HOUR`, `PREVIEW_WARM` to the backend, so the update page always showed "not configured".
#### Maintenance – dev toolchain upgrade
- Dev-only `npm audit` findings fixed (tinypool, @vitest/mocker, esbuild, cookie): vitest 5, Vite 8, SvelteKit 3, vite-plugin-svelte 7, adapter-node 6, TypeScript 6.
- SvelteKit 3: config moved from `svelte.config.js` into `sveltekit({...})` in `web/vite.config.ts`; `$lib` replaced by `#lib` subpath imports (`web/package.json` `imports`); `$app/stores` replaced by `#lib/page` (`toStore` over `$app/state`); `goto` uses `replace`/`reset: false`; `web/tsconfig.json` extends `$app/tsconfig`.
- TypeScript 6 no longer loads `@types/*` implicitly: `tsconfig.base.json` sets `types: ["node"]`.
#### Step 21 – Languages, simpler party, preview clips, "Heute Abend"
- Language picker on the detail page (audio + subtitles, remembered per title/series, carried to the next episode).
- Hover preview: optional clip from the film itself when there is no local trailer (setting, off by default).
- Watch party: one tap "Gemeinsam schauen", invitation dialog in the room (notification or link).
- "Heute Abend" (/tonight): mood, time, film/series -> three suggestions.
- Fix: next-episode row duplicated "Weiterschauen"; next-episode button missing for an episode in progress.
#### Step 16 – Review fixes + remote audio/subtitles
- Review: only a paired TV session may register as the TV (a laptop could evict the real one); pair/claim are serialised per code; max 8 phones per user, socket errors handled; LG Magic Remote pointer is kept (cursor hides after 4 s idle); the TV shows a notice when another device took over.
- Phone remote: "Nächste Folge" button and audio/subtitle pickers (track lists reported by the TV, bounded by the schema).
#### Step 15 – TV mode, phone remote, local ports
- **TV mode** for smart TVs / sticks / consoles: pairing screen `/tv` (code + QR), TV gets its own 30-day session (7 days idle), listed under *Geräte*; 10-foot UI (big type, strong focus rings), geometric D-pad navigation (`lib/spatial.ts`), Back key support for Tizen/webOS/Android TV, focus memory when going back, control bar reachable with up/down in the player, media keys. `?tv=1` previews it in any browser.
- **Phone as remote** (`/remote`, menu "Fernbedienung"): play/pause, ±10/±60 s, stop, home, "continue watching" and search with *Auf TV*, "Auf Fernseher" button on detail pages. WebSocket hub `/ws/remote` (same user only, command whitelist, flood limit, revoked sessions are disconnected immediately).
- Security: pairing needs a logged-in user, one-time 10-minute code with secret poll token, phishing warning, notification + audit entry on every pairing; anonymous `/api/tv/code|claim` are exempt from CSRF (no ambient authority).
- Player: **starts automatically** now (falls back to muted start with a hint if the browser refuses sound; the first key unmutes), publishes its state for the remote.
- **Fix:** the watch page re-requested `/api/items/:id` in an endless loop (Svelte 5 dependency tracking of an inline async block), so the title never showed and the API was hammered; the loader is a function now.
- Ops: no shared Docker network with NPM needed any more – web/backend/gateway are published on `127.0.0.1:3080/3081/3082` only (`BIND_ADDR`, `*_PORT`); NPM configs and `scripts/test-plan-b.sh` updated; Plan B uses `compose.planb.yaml` (Jellyfin on `127.0.0.1:8096`); `mediaedge` network removed.
#### Step 14 – Social & discovery
- Group matcher ("Was hat noch keiner von uns gesehen?"): opt-in per participant, intersection of unwatched lists with each user's own token, filters (length/genre), one click to a film-night poll.
- Scenes: share links with timestamp (`/watch/<id>?t=`), bookmarks with notes and timeline markers.
- Cast panel on pause; find subtitles via Jellyfin remote providers; picture of title mood (dynamic tint on the detail page).
- Recommend to friends, "Von Freunden empfohlen" and "Freunde haben bewertet" rows (rating sharing opt-out), thumbs up/down feeding "Weil du ... gesehen hast".
- "Demnächst" from the request service with one-click wish; extras/bonus material, collections and studio hubs.
- Muted hover trailer previews (local trailers only), shareable year-in-review card (PNG, rendered in the browser).
#### Step 13 – Streaming features
- Timeline preview thumbnails (Jellyfin trickplay) through the gateway/auth_request allowlist.
- Quality selector (Auto/1080p/720p/480p/360p, never above the role limit); "Einstellungen" menu with quality, speed and sleep timer ("nach 15/30/45/60 Min." or "nach dieser Folge").
- Picture-in-picture button.
- Viewing preferences (autoplay next, auto-skip intro, preferred audio/subtitle language, default quality) stored server-side, settings page.
- "Weil du ... gesehen hast" row and Jellyfin-based "Ähnliche Titel".
- Fix: CSS class collision made the player menus invisible (`.bar` clipped them).
#### Step 12 – Own player + watch party in the player, Plan B
- Custom player: scrubbing timeline with buffer + hover time, ±10 s, volume, remaining time, audio/subtitle menu, speed, fullscreen of the whole stage (overlays stay visible), auto-hiding controls, touch gestures (double-tap ±10 s), spinner, toasts, keyboard shortcuts.
- Watch party inside the player (shared playback): avatar stack with host crown and buffering state, chat side panel with unread badge + fading message bubbles, reaction picker with floating emoji, "waiting for X" banner, copy invite link, host switch "Nur Host / Alle dürfen steuern", guests see locked controls with hint.
- Plan B implemented: `GET /internal/authz-nginx` + hardened nginx `auth_request` config, shared allowlist test vectors, query length/param limits (also in the gateway), `friendflix_authz_nginx_total`, `mediaedge` network, end-to-end test script against real nginx.
#### Step 11 – Polish
- Gateway: images are browser-cacheable (`private, max-age=86400, stale-while-revalidate`, ETag/304 pass-through); upstream `public` is downgraded to `private`.
- Title logos (transparent PNG) in billboard and detail popup, text fallback.
- Detail popup over the current page (shallow routing, focus trap, Esc/back closes); "Mehr Infos" opens it.
- "Top 10 nach Bewertung" row with large rank numbers; posters without backdrop shown contained on a blurred copy.
- Player: "Intro/Abspann überspringen" from Jellyfin media segments (10.10+), keyboard shortcuts (Space/K, J/L/arrows, M, F).
- Emoji removed from the UI (achievements use icons); notification texts without emoji.
#### Step 10 – Cinematic UI
- New design system (OLED dark, Inter self-hosted, tokens, focus rings, reduced-motion, skeleton loading, 44 px touch targets) generated with the ui-ux-pro-max skill.
- Home: full-bleed billboard, carousels with arrows + scroll-snap, hover preview cards (play, list, favorite, details), lazy-loaded genre rows.
- Transparent-to-solid top navigation, expanding search, profile menu, mobile tab bar; Browse (Filme/Serien with genre/sort/filter), "Neu & demnächst", search with wish fallback.
- Detail page with episode list + progress; immersive player page with auto-hiding chrome and "next episode" countdown; restyled invite page.
- Backend: `GET /api/watchlist/ids` for the "Merkliste" state on cards.
#### Step 9 – Improvements
- Feature: "Überrasch mich" – random unwatched movie/series, optional genre filter (`/api/library/random`, `/api/library/genres`).
- Security: sliding idle timeout (default 2 h) plus absolute lifetime (8 h) for sessions; "log out other devices" for users; admins can end all sessions of a user (audited).
- Fix: gateway session cache shortened (15 s -> 5 s) so logout/revoke takes effect on streams almost immediately.
- Fix (CI): runtime images no longer ship the base image's npm/yarn (Trivy findings).
#### Step 8 – Admin, metrics, backups, hardening
- Admin status page, extended Prometheus metrics, backup script + sidecar + restore test, Docker-secrets override, strict CSP + security headers, error handler.
- Fixes: `_FILE` secret loading restricted to known settings, OIDC dev flag (`OIDC_ALLOW_INSECURE`), generic error handler (zod -> 400).
#### Step 7 – Stats, achievements, now playing
- Watch-time statistics from playback events, personal year in review + group leaderboard, 11 achievements (state and event driven), now-playing board.
#### Step 6 – Voting, wishes, notifications
- Film-night polls (one vote per user, countdown, auto-start party room), non-library winners need admin approval -> request service request -> auto-scheduled when available, ratings with short reviews, series calendar with follow + notifications (in-app, ntfy, Discord).
#### Step 5 – Watch party
- Own WebSocket sync (no SyncPlay): host-controlled play/pause/seek with server timestamps, ~300 ms drift correction, room holds until all participants have buffered, chat + whitelisted emoji reactions, scheduled auto-start, Origin + session checks.
#### Step 4 – Request service
- Search, wishes in the user's name (mapped request service user), status mapping, admin approve/decline, request service webhook (available/pending/approved/declined), in-app notifications + ntfy/Discord push, TMDB poster proxy.
#### Step 3 – Invites, roles, mapping
- Single-use hashed invite links with expiry (optional Authentik invitation), role templates applied to Jellyfin policy, admin user management (role, disable), device approval for new devices, audit log, public invite landing page.
#### Step 2 – Gateway + Player
- Gateway: streaming proxy (no buffering, HTTP Range, server-side Jellyfin token, path allowlist, SSRF guard, bitrate clamp, Prometheus metrics).
- Backend: Postgres migrations, encrypted per-user Jellyfin credentials, library/search/resume/next-up/favorites/played/watchlist API, PlaybackInfo, Playing/Progress/Stopped reporting, stream limits, Jellyfin webhook + /Sessions polling fallback, /internal/authz, /metrics.
- Web: SvelteKit UI (German) with home, library, search, item detail, hls.js player (direct play default, audio/subtitle selection).
#### Step 1 – Foundation
- compose.yaml with isolated networks, Fastify backend (/health, /health/ready), Authentik OIDC login (PKCE), CSRF-protected logout, Jellyfin client, OpenAPI generation script, NPM configs, gateway health stub.
#### Step 0 – Bootstrap
- Repo structure, license notice (all rights reserved), .gitignore, .env.example, CI, Dependabot, gitleaks hook.
