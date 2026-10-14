# Integrations (Jellyfin, request service, Authentik, ntfy/Discord)

> **FriendFlix for Plex (preview):** the Jellyfin steps on this page (webhook plugin, API key) do **not** apply. Use [plex.md](plex.md) for the media-server setup ([Deutsch](de/plex.md)). The sections below on the request service, Authentik, ntfy and Discord notifications and web push apply unchanged. The section "What FriendFlix reads from Jellyfin" is the Jellyfin side; for Plex the same data (cast, chapters, stream details, ratings, preview thumbnails) is described in [plex.md](plex.md) (sections 4 to 6 and the feature parity table).

Webhook URLs use the **internal Docker network** (`http://backend:3000`, Jellyfin and the request service share the `media` network with the backend), never the public host. NPM answers `/internal/*` with 404.
`WEBHOOK_SECRET` is the shared secret (`.env`).

## Jellyfin webhook plugin (optional, polling `/Sessions` every 10 s is the fallback)
Plugin "Webhook" → Add Generic Destination:
- Webhook URL: `http://backend:3000/internal/webhook/jellyfin`
- Notification Type: Playback Start, Playback Progress, Playback Stop, and **Item Added** (optional, for "Erinnere mich" reminders)
- Header: `X-Webhook-Secret: <WEBHOOK_SECRET>`
- Template:
```json
{"type":"{{NotificationType}}","user":"{{NotificationUsername}}","itemId":"{{ItemId}}","name":"{{Name}}","seriesName":"{{SeriesName}}","positionTicks":"{{PlaybackPositionTicks}}","runtimeTicks":"{{RunTimeTicks}}","isPaused":"{{IsPaused}}","deviceName":"{{DeviceName}}","itemType":"{{ItemType}}","provider_tmdb":"{{Provider_tmdb}}","seriesId":"{{SeriesId}}","seasonNumber":"{{SeasonNumber}}","episodeNumber":"{{EpisodeNumber}}"}
```
`itemType`, `provider_tmdb`, `seriesId`, `seasonNumber` and `episodeNumber` are only used for `ItemAdded`: when a Movie/Series with that TMDB id (or an Episode) arrives, the people who pressed "Erinnere mich" are notified at once. Jellyfin gives an announced (virtual) episode a new id when its file arrives, so episode reminders are matched on series + season + episode number as well as the id; a series reminder only fires once at least one real episode exists. Without Item Added the portal checks every 30 minutes (and the request service's MEDIA_AVAILABLE webhook fires reminders immediately). Reminders are personal: they only go to the in-app inbox and the user's own ntfy topic, never to the global ntfy/Discord channel.
Pause is derived from `isPaused` in progress events. Sessions started in the portal are tracked directly and need no webhook.

## What FriendFlix reads from Jellyfin (no setup needed)
Besides browsing and playback, newer features read more from the library; nothing here needs a plugin, but the data has to exist in Jellyfin:
- **Cast & info** and the person pages: people with their roles (actors, guest stars, director, writers, creators), studios and tags (`fields=People,Studios,Tags`).
- **Scenes:** chapters (`fields=Chapters`); chapter pictures come from Jellyfin (`/Items/<id>/Images/Chapter/<n>`, through the gateway). Titles without chapters simply show no scene marks.
- **Picture-and-sound chips and the quality filter:** stream details of the media sources (resolution, HDR / Dolby Vision, audio channels / Atmos). The filter reads an index that the backend builds in the background with the admin key (`BACKGROUND_JOBS=true`).
- **Labels:** "Season finale" needs Jellyfin's series status (continuing / ended) and the episode dates.
- **Skip intro / credits / preview:** media segments (Jellyfin >= 10.10, e.g. from the Intro Skipper plugin).

## TMDB / OMDb (optional)
Two optional keys add data to the detail page. Nothing breaks without them; the extra rows and links are simply left out.
- **Where to get them:** a free TMDB account (Settings, API) gives the TMDB key; a free OMDb key comes from the OMDb site by email.
- **What is fetched:** TMDB supplies keywords, the collection a film belongs to and the IMDb id; OMDb supplies the IMDb, Rotten Tomatoes and Metacritic scores. Together with ids from Jellyfin they also produce the links to TMDB, IMDb, TVDB and Trakt.
- **Setting a key:** `TMDB_API_KEY` / `OMDB_API_KEY` in `.env`, or as a file with `TMDB_API_KEY_FILE` / `OMDB_API_KEY_FILE` (Docker secrets, see `compose.secrets.yaml`). Alternatively use *Admin, Data sources*, where the key is stored encrypted. A key from the environment or a file **wins** over one saved in the admin page; the page then shows it as read-only.
- **Keys never leave the server.** The browser only learns whether a key is set, where it comes from and its last four characters. Requests to TMDB and OMDb are made by the backend only.
- **Cache and limits:** successful answers are cached for 7 days, failed ones for 1 hour; each call has a 3 second limit, so a slow service cannot hold the page up. OMDb is limited to 900 calls per day (the free tier allows 1000); the admin page shows today's use. When a service answers 401 the key counts as invalid and that source is paused for 1 hour; saving a new key lifts the pause at once.
- **Terms of use:** you use your own keys, so the terms of TMDB and OMDb apply to you. This product uses the TMDB API but is not endorsed or certified by TMDB. TMDB, OMDb, IMDb, Rotten Tomatoes and Metacritic are trademarks of their respective owners; check the current terms before using the data beyond a private installation.

## Request service
- Users imported from Jellyfin get default permissions. Leave "auto-approve" **off** if the admin should approve every wish.
- **How FriendFlix accounts appear in the request service.** Wishes are always made in the account's name (`userId` in `POST /request`, sent with the admin API key); profiles share their account's request service user. The mapping is stored per account in the `users` table. The media server decides how the request service user is found (`capabilities.requestUsers`, backend only):
  - **Jellyfin** (`jellyfin-import`, unchanged): the request service user carrying the account's Jellyfin user id, imported via `/user/import-from-jellyfin` on the first wish.
  - **Other servers** (`local`, also the default when a server does not say), e.g. a Plex fork with one admin token and no per-user server account: a **local request service user** per account. On each wish the stored id is checked (`GET /user/{id}`); if it is missing or was deleted in the request service, FriendFlix looks for a request service user with the account's email (case-insensitive) and adopts it unchanged, otherwise it creates one (`POST /user` with email, the account's display name as username and a random password FriendFlix never keeps) and sets its permissions to exactly **Request** (`PUT /user/{id}`, bit 32: no admin, no auto-approve, whatever the request service's default permissions are). If that permission update fails the new user is deleted again and the wish fails. Accounts without an email (an OIDC provider without the `email` claim) use the placeholder `<account id>@friendflix.invalid` (deterministic, so the same request service user is found again; the request service cannot mail it). Parallel wishes of one account create one user (advisory lock per account). The API key needs *Manage Users* (the admin API key from Settings → General has it). These users cannot log in to the request service themselves unless the request service admin sets a password; to merge with an existing request service user, give it the same email before the first wish.
- Settings → Notifications → Webhook:
  - Webhook URL `http://backend:3000/internal/webhook/requests` (the previous path keeps working)
  - Authorization Header: `<WEBHOOK_SECRET>` (the portal accepts `Authorization` or `X-Webhook-Secret`)
  - Notification types: Request Pending Approval, Approved, Declined, Available
  - JSON payload: default template (`notification_type`, `subject`, `media.media_type`, `media.tmdbId`, `request.request_id`).
- API key: Settings → General → `REQUESTS_API_KEY` (URL: `REQUESTS_URL`, default `http://requests:5055`). The previous variable names still work and log a deprecation warning at startup.
- Paths used (`/api/v1`): `/search`, `/movie/{id}`, `/tv/{id}`, `/request`, `/request/{id}/approve|decline`, `/user`, `/user/import-from-jellyfin` (Jellyfin); `GET|PUT|DELETE /user/{id}`, `POST /user` (local users, other servers).
  Verify against your instance's `/api-docs`: the user import path differs between versions of the request service.

## Authentik
Moved to **[authentik.md](authentik.md)**: installation, OAuth2/OpenID provider and application (redirect URI `${PUBLIC_URL}/auth/callback`, `OIDC_ISSUER` with trailing slash), groups and `ADMIN_GROUP`, mandatory MFA, recovery, branding, troubleshooting. The complete installation of FriendFlix is in [setup.md](setup.md).

### Invitations with account creation
Moved to [authentik.md §7–§9](authentik.md#7-enrollment-flow-for-invitations): enrollment flow (`AUTHENTIK_ENROLL_FLOW`), service account and API token with least privileges (`AUTHENTIK_API_TOKEN`), `AUTHENTIK_URL`, and the troubleshooting table ([§15](authentik.md#15-troubleshooting)). Ready-made blueprints: [`deploy/authentik/`](../deploy/authentik/).

## ntfy / Discord
`NTFY_URL=https://ntfy.example.com/friendflix` and/or `DISCORD_WEBHOOK_URL=...` for "now available", pending wishes, voting events.

## Web Push (browser notifications)
Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (both required; `VAPID_SUBJECT` optional, default `PUBLIC_URL`) to enable per-device browser push. Generate a key pair with `node scripts/gen-vapid.mjs` (prints ready-to-paste env lines) or `npx web-push generate-vapid-keys`. The private key can be supplied as a Docker secret (`VAPID_PRIVATE_KEY_FILE`, see `compose.secrets.yaml`: `secrets/vapid_private_key` must exist; an empty file counts as unset and leaves push disabled). An invalid key pair is detected at startup, logged as a warning and also disables push. Keep the pair stable: changing it invalidates all existing subscriptions.

- Users enable it under *Einstellungen → Benachrichtigungen* (per device). Personal notices go to that user's subscriptions; announcements (movie night, "now available") only to devices that opted in. Non-owner profiles only ever see a generic "Neue Benachrichtigung" text.
- Every push also refreshes the app-icon badge (number of unread notices) on installed apps that support it, see [personal.md](personal.md).
- The portal must be served over HTTPS. On iOS (16.4+) the site has to be installed first (Share -> "Zum Home-Bildschirm").
- The backend only posts to the browsers' push services (FCM, Mozilla, Windows, Apple); other endpoints are rejected. Outbound HTTPS to those hosts must be allowed.
- Subscriptions are removed automatically when the push service reports them gone (404/410), after a device or session revoke, or after repeated failures for over 7 days.
