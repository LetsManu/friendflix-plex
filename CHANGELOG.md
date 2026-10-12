# Changelog
## [Unreleased]
### Browser-Fehler & E2E
- Browser error reporting: `POST /api/client-errors` (unauthenticated, rate limited, logged scrubbed, counted in `friendflix_client_errors_total`), `web/src/lib/telemetry.ts` + `hooks.client.ts` (dedupe 60 s, max 10 per page load, extension/ResizeObserver noise filtered). See docs/monitoring.md.
- Playwright browser tests in `e2e/` (API fully mocked, run against the built web app; `npm run e2e`) and an `e2e` CI job.
### Block 10 – Wünsche aus der Suche, kuratierte Reihen
- Search shows "Noch nicht in der Bibliothek" with Seerr results and a "Wünschen" button (hidden when Seerr is unavailable).
- Admins can feature up to 5 lists (Admin → Listen); they appear as rows on everyone's home page ("Empfohlen von …") and are readable by all, with titles filtered per profile. Migration 24: `lists.featured_at`.
### Block 9 – Trending, Neue Folgen, Reaktionen
- Home row "Diese Woche bei uns": what friends watched in the last 7 days (counts only; a title needs 2 viewers unless you are one of them).
- "Neue Folgen" badge on series you started that got episodes in the last 14 days.
- Reactions on films and episodes (Gefällt mir, Witzig, Wow, Traurig, Liebe + short comment), visible only after you watched it – spoiler protection like the TV Time pattern. Migration 23: `reactions`.
### Touch & images
- Touch action sheet on cards, series name on episode cards, srcset/sizes for card/hero/quick-view images, ItemModal accessibility (inert background, labelled dialog).
### Block 7 – Sprache, Watch-Status, Freunde
- Audio/subtitle language filter in Filme/Serien ("Ton", "Untertitel", quick toggle "Deutscher Ton"), backed by a background index of all MediaStreams (`item_langs`, every 12 h); the item page lists audio and subtitle languages.
- Watch status per profile: "Geplant" (Meine Liste) and "Abgebrochen" (leaves Weiterschauen and Nächste Folge), plus derived "Schaue ich gerade"/"Gesehen"; Meine Liste has tabs Geplant | Abgebrochen.
- Friends strip on the item page: who recommended it to you, friends' stars (only with "Bewertungen teilen") and who watched it (only with "Verlauf teilen").
- Gemeinsam schauen: titles on participants' lists first ("2× geplant", never who), titles someone dropped or thumbed down are left out.
- Migration 22: `item_langs`, `dropped`.
### Discovery upgrade – Suche, Personen, Filter
- Search finds people, genres, titles and episodes in grouped sections (`GET /api/search`), a 4-digit query lists titles of that year; loading/error/empty states, recent searches, `/` or Ctrl/Cmd+K focuses the search.
- Person pages (`/person/<id>`, `GET /api/people/:id`) with the filmography limited to the viewer's library; the item page shows a linked "Besetzung & Crew" row.
- Browse: decade, minimum rating and person filters (`decade`, `year`, `minRating`, `person` on `/api/library/items`), removable filter chips, Filme/Serien switch keeps filters, stale responses are dropped; library pages keep search/sort/filter in the URL.
- Item page and quick view: a failing side request (ratings, seasons, next up) no longer shows "Titel nicht gefunden"; favourite/watched/follow/rating report failures.
- Privacy: `GET /api/items/:id/ratings` requires the viewer to see the title and hides ratings of users who turned off "Bewertungen teilen".
- "Gemeinsam schauen" applies genre/runtime filters to the whole common set (up to 2000 titles) instead of the first 400.
- Migration 21: indexes `ratings(item_id)`, `thumbs(user_id)`; genre lists cached 10 min per Jellyfin user.
- Research notes: `docs/research/streaming-product-upgrade.md`.
### Block 5 – Offline-Downloads
- Filme und Folgen aufs Gerät laden und offline ansehen (Menü → Downloads, `/offline`): Server bereitet MP4-Dateien vor (HLS → ffmpeg-Remux, wiederaufnehmbar), der Browser lädt sie per Range in OPFS; Lizenzen pro Gerät mit Ablauf, Online-Prüfung und Widerruf. Rollenfelder „Downloads erlauben“, „Max. Downloads“, „Max. Download-Qualität“, „Gültigkeit (Tage)“; Admin → Wiedergabe-Check zeigt Jobs und Speicher. Neue Variablen `DOWNLOADS_ENABLED`, `DOWNLOAD_DIR`, `DOWNLOAD_CACHE_MAX_GB` u. a., neues Volume `downloads`. Kein DRM, siehe `docs/downloads.md`.
### Block 4 – PWA, push, Chromecast
- Installable app (manifest, iOS meta, service worker caching only static assets; never /api, /media, HTML or Range requests) with an offline page.
- Web push per device (Einstellungen → Benachrichtigungen, "Test senden"): VAPID keys via `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (`node scripts/gen-vapid.mjs`), endpoint allowlist, generic text on devices enabled by non-owner profiles, revoked with the device.
- Chromecast (Default Media Receiver) from Chrome/Android: short-lived, item-scoped, revocable cast tokens under `/media/c/<token>/…` checked by the gateway (CORS only there, playlist sanitizer, failed-auth limit); NPM should log nothing for `/media/c/` (see `deploy/npm/portal.advanced.conf`, `docs/cast.md`). CSP allows `https://www.gstatic.com` scripts for the Cast SDK.
### Block 3 – Digest, shared lists, reminders
- Weekly digest ("Wochenrückblick"): new films/episodes, new episodes of followed series, fulfilled wishes, friends' tips; `/digest` page, schedule via `DIGEST_DAY`/`DIGEST_HOUR` or Admin → Wochenrückblick, opt-out in settings. Personal ntfy topic per account (never the shared ntfy/Discord channel).
- Shared lists: owner invites editors/viewers, "Zu Liste hinzufügen" on cards/detail page, only titles visible to the viewer's profile are shown.
- "Erinnere mich" on Demnächst and future calendar episodes: notification when the title is in the library (Seerr webhook, optional Jellyfin `ItemAdded` webhook, 30-min fallback), deduplicated with series follows and own requests.
### Block 2 – Profiles & viewing comfort
- Profiles per account (max 5, optional 4-digit PIN, "Wer schaut gerade?"): each extra profile is a hidden Jellyfin user with the account's role policy, so progress, favourites, watchlist and viewing prefs are per profile; stream limit, requests, ratings and admin rights stay per account (admin only from the owner profile). "PIN vergessen?" re-login clears the owner PIN. Turn off Seerr's automatic Jellyfin user import so profile users don't show up there.
- Verlauf page (remove an episode or a whole series), tidier "Weiterschauen" (no near-finished/barely-started items, one entry per series, X to hide).
- "Schaust du noch?" after N autoplayed episodes or 90 min without input; subtitle style (size, colour, background, font); spoiler protection for unwatched episodes.
### Reliability block 1
- Guests: playback capped at 1080p, transcoding allowed in the role policy (re-applied once to existing users on start); watch progress no longer lost on early stop.
- Nightly playback check (`PLAYBACK_CHECK_HOUR`, -1 = off) with admin alert; watch-party size limit; home page retries failed rows.
- Fix: `compose*.yaml` did not pass `PORTAINER_*`, `UPDATE_REPO`, `GITHUB_TOKEN`, `PLAYBACK_CHECK_HOUR`, `PREVIEW_WARM` to the backend, so the update page always showed "not configured".
### Maintenance – dev toolchain upgrade
- Dev-only `npm audit` findings fixed (tinypool, @vitest/mocker, esbuild, cookie): vitest 5, Vite 8, SvelteKit 3, vite-plugin-svelte 7, adapter-node 6, TypeScript 6.
- SvelteKit 3: config moved from `svelte.config.js` into `sveltekit({...})` in `web/vite.config.ts`; `$lib` replaced by `#lib` subpath imports (`web/package.json` `imports`); `$app/stores` replaced by `#lib/page` (`toStore` over `$app/state`); `goto` uses `replace`/`reset: false`; `web/tsconfig.json` extends `$app/tsconfig`.
- TypeScript 6 no longer loads `@types/*` implicitly: `tsconfig.base.json` sets `types: ["node"]`.
### Step 21 � Languages, simpler party, preview clips, "Heute Abend"
- Language picker on the detail page (audio + subtitles, remembered per title/series, carried to the next episode).
- Hover preview: optional clip from the film itself when there is no local trailer (setting, off by default).
- Watch party: one tap "Gemeinsam schauen", invitation dialog in the room (notification or link).
- "Heute Abend" (/tonight): mood, time, film/series -> three suggestions.
- Fix: next-episode row duplicated "Weiterschauen"; next-episode button missing for an episode in progress.
### Step 16 – Review fixes + remote audio/subtitles
- Review: only a paired TV session may register as the TV (a laptop could evict the real one); pair/claim are serialised per code; max 8 phones per user, socket errors handled; LG Magic Remote pointer is kept (cursor hides after 4 s idle); the TV shows a notice when another device took over.
- Phone remote: "Nächste Folge" button and audio/subtitle pickers (track lists reported by the TV, bounded by the schema).
### Step 15 – TV mode, phone remote, local ports
- **TV mode** for smart TVs / sticks / consoles: pairing screen `/tv` (code + QR), TV gets its own 30-day session (7 days idle), listed under *Geräte*; 10-foot UI (big type, strong focus rings), geometric D-pad navigation (`lib/spatial.ts`), Back key support for Tizen/webOS/Android TV, focus memory when going back, control bar reachable with up/down in the player, media keys. `?tv=1` previews it in any browser.
- **Phone as remote** (`/remote`, menu "Fernbedienung"): play/pause, ±10/±60 s, stop, home, "continue watching" and search with *Auf TV*, "Auf Fernseher" button on detail pages. WebSocket hub `/ws/remote` (same user only, command whitelist, flood limit, revoked sessions are disconnected immediately).
- Security: pairing needs a logged-in user, one-time 10-minute code with secret poll token, phishing warning, notification + audit entry on every pairing; anonymous `/api/tv/code|claim` are exempt from CSRF (no ambient authority).
- Player: **starts automatically** now (falls back to muted start with a hint if the browser refuses sound; the first key unmutes), publishes its state for the remote.
- **Fix:** the watch page re-requested `/api/items/:id` in an endless loop (Svelte 5 dependency tracking of an inline async block), so the title never showed and the API was hammered; the loader is a function now.
- Ops: no shared Docker network with NPM needed any more – web/backend/gateway are published on `127.0.0.1:3080/3081/3082` only (`BIND_ADDR`, `*_PORT`); NPM configs and `scripts/test-plan-b.sh` updated; Plan B uses `compose.planb.yaml` (Jellyfin on `127.0.0.1:8096`); `mediaedge` network removed.
### Step 14 – Social & discovery
- Group matcher ("Was hat noch keiner von uns gesehen?"): opt-in per participant, intersection of unwatched lists with each user's own token, filters (length/genre), one click to a film-night poll.
- Scenes: share links with timestamp (`/watch/<id>?t=`), bookmarks with notes and timeline markers.
- X-Ray cast panel on pause; find subtitles via Jellyfin remote providers; picture of title mood (dynamic tint on the detail page).
- Recommend to friends, "Von Freunden empfohlen" and "Freunde haben bewertet" rows (rating sharing opt-out), thumbs up/down feeding "Weil du ... gesehen hast".
- "Demnächst" from Seerr with one-click wish; extras/bonus material, collections and studio hubs.
- Muted hover trailer previews (local trailers only), shareable Wrapped card (PNG, rendered in the browser).
### Step 13 – Streaming features
- Timeline preview thumbnails (Jellyfin trickplay) through the gateway/auth_request allowlist.
- Quality selector (Auto/1080p/720p/480p/360p, never above the role limit); "Einstellungen" menu with quality, speed and sleep timer ("nach 15/30/45/60 Min." or "nach dieser Folge").
- Picture-in-picture button.
- Viewing preferences (autoplay next, auto-skip intro, preferred audio/subtitle language, default quality) stored server-side, settings page.
- "Weil du ... gesehen hast" row and Jellyfin-based "Ähnliche Titel".
- Fix: CSS class collision made the player menus invisible (`.bar` clipped them).
### Step 12 – Own player + watch party in the player, Plan B
- Custom Netflix-style player: scrubbing timeline with buffer + hover time, ±10 s, volume, remaining time, audio/subtitle menu, speed, fullscreen of the whole stage (overlays stay visible), auto-hiding controls, touch gestures (double-tap ±10 s), spinner, toasts, keyboard shortcuts.
- Watch party inside the player (Amazon-Watch-Party style): avatar stack with host crown and buffering state, chat side panel with unread badge + fading message bubbles, reaction picker with floating emoji, "waiting for X" banner, copy invite link, host switch "Nur Host / Alle dürfen steuern", guests see locked controls with hint.
- Plan B implemented: `GET /internal/authz-nginx` + hardened nginx `auth_request` config, shared allowlist test vectors, query length/param limits (also in the gateway), `friendflix_authz_nginx_total`, `mediaedge` network, end-to-end test script against real nginx.
### Step 11 – Polish
- Gateway: images are browser-cacheable (`private, max-age=86400, stale-while-revalidate`, ETag/304 pass-through); upstream `public` is downgraded to `private`.
- Title logos (transparent PNG) in billboard and detail popup, text fallback.
- Detail popup over the current page (shallow routing, focus trap, Esc/back closes); "Mehr Infos" opens it.
- "Top 10 nach Bewertung" row with large rank numbers; posters without backdrop shown contained on a blurred copy.
- Player: "Intro/Abspann überspringen" from Jellyfin media segments (10.10+), keyboard shortcuts (Space/K, J/L/arrows, M, F).
- Emoji removed from the UI (achievements use icons); notification texts without emoji.
### Step 10 – Cinematic UI
- New design system (OLED dark, Inter self-hosted, tokens, focus rings, reduced-motion, skeleton loading, 44 px touch targets) generated with the ui-ux-pro-max skill.
- Home: full-bleed billboard, carousels with arrows + scroll-snap, hover preview cards (play, list, favorite, details), lazy-loaded genre rows.
- Transparent-to-solid top navigation, expanding search, profile menu, mobile tab bar; Browse (Filme/Serien with genre/sort/filter), "Neu & beliebt", search with wish fallback.
- Detail page with episode list + progress; immersive player page with auto-hiding chrome and "next episode" countdown; restyled invite page.
- Backend: `GET /api/watchlist/ids` for the "Meine Liste" state on cards.
### Step 9 – Improvements
- Feature: "Überrasch mich" – random unwatched movie/series, optional genre filter (`/api/library/random`, `/api/library/genres`).
- Security: sliding idle timeout (default 2 h) plus absolute lifetime (8 h) for sessions; "log out other devices" for users; admins can end all sessions of a user (audited).
- Fix: gateway session cache shortened (15 s -> 5 s) so logout/revoke takes effect on streams almost immediately.
- Fix (CI): runtime images no longer ship the base image's npm/yarn (Trivy findings).
### Step 8 – Admin, metrics, backups, hardening
- Admin status page, extended Prometheus metrics, backup script + sidecar + restore test, Docker-secrets override, strict CSP + security headers, error handler.
- Fixes: `_FILE` secret loading restricted to known settings, OIDC dev flag (`OIDC_ALLOW_INSECURE`), generic error handler (zod -> 400).
### Step 7 – Stats, achievements, now playing
- Watch-time statistics from playback events, personal Wrapped + group leaderboard, 11 achievements (state and event driven), now-playing board.
### Step 6 – Voting, wishes, notifications
- Film-night polls (one vote per user, countdown, auto-start party room), non-library winners need admin approval -> Seerr request -> auto-scheduled when available, ratings with short reviews, series calendar with follow + notifications (in-app, ntfy, Discord).
### Step 5 – Watch party
- Own WebSocket sync (no SyncPlay): host-controlled play/pause/seek with server timestamps, ~300 ms drift correction, room holds until all participants have buffered, chat + whitelisted emoji reactions, scheduled auto-start, Origin + session checks.
### Step 4 – Seerr
- Search, wishes in the user's name (mapped Seerr user), status mapping, admin approve/decline, Seerr webhook (available/pending/approved/declined), in-app notifications + ntfy/Discord push, TMDB poster proxy.
### Step 3 – Invites, roles, mapping
- Single-use hashed invite links with expiry (optional Authentik invitation), role templates applied to Jellyfin policy, admin user management (role, disable), device approval for new devices, audit log, public invite landing page.
### Step 2 – Gateway + Player
- Gateway: streaming proxy (no buffering, HTTP Range, server-side Jellyfin token, path allowlist, SSRF guard, bitrate clamp, Prometheus metrics).
- Backend: Postgres migrations, encrypted per-user Jellyfin credentials, library/search/resume/next-up/favorites/played/watchlist API, PlaybackInfo, Playing/Progress/Stopped reporting, stream limits, Jellyfin webhook + /Sessions polling fallback, /internal/authz, /metrics.
- Web: SvelteKit UI (German) with home, library, search, item detail, hls.js player (direct play default, audio/subtitle selection).
### Step 1 – Foundation
- compose.yaml with isolated networks, Fastify backend (/health, /health/ready), Authentik OIDC login (PKCE), CSRF-protected logout, Jellyfin client, OpenAPI generation script, NPM configs, gateway health stub.
### Step 0 – Bootstrap
- Repo structure, license notice (all rights reserved), .gitignore, .env.example, CI, Dependabot, gitleaks hook.
