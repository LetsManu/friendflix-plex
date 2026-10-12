# Integrations (Jellyfin, Seerr, Authentik, ntfy/Discord)

> **FriendFlix for Plex (preview):** the Jellyfin steps on this page (webhook plugin, API key) do **not** apply. Use [plex.md](plex.md) for the media-server setup ([Deutsch](de/plex.md)). The sections below on the request service, Authentik, ntfy and Discord notifications and web push apply unchanged.

Webhook URLs use the **internal Docker network** (`http://backend:3000`, Jellyfin/Seerr share the `media` network with the backend), never the public host. NPM answers `/internal/*` with 404.
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
`itemType`, `provider_tmdb`, `seriesId`, `seasonNumber` and `episodeNumber` are only used for `ItemAdded`: when a Movie/Series with that TMDB id (or an Episode) arrives, the people who pressed "Erinnere mich" are notified at once. Jellyfin gives an announced (virtual) episode a new id when its file arrives, so episode reminders are matched on series + season + episode number as well as the id; a series reminder only fires once at least one real episode exists. Without Item Added the portal checks every 30 minutes (and Seerr's MEDIA_AVAILABLE webhook fires reminders immediately). Reminders are personal: they only go to the in-app inbox and the user's own ntfy topic, never to the global ntfy/Discord channel.
Pause is derived from `isPaused` in progress events. Sessions started in the portal are tracked directly and need no webhook.

## Seerr
- Users imported from Jellyfin get default permissions. Leave "auto-approve" **off** if the admin should approve every wish.
- Settings → Notifications → Webhook:
  - Webhook URL `http://backend:3000/internal/webhook/seerr`
  - Authorization Header: `<WEBHOOK_SECRET>` (the portal accepts `Authorization` or `X-Webhook-Secret`)
  - Notification types: Request Pending Approval, Approved, Declined, Available
  - JSON payload: default template (`notification_type`, `subject`, `media.media_type`, `media.tmdbId`, `request.request_id`).
- API key: Settings → General → `SEERR_API_KEY`.
- Paths used (`/api/v1`): `/search`, `/movie/{id}`, `/tv/{id}`, `/request`, `/request/{id}/approve|decline`, `/user`, `/user/import-from-jellyfin`.
  Verify against your instance's `/api-docs`: the user import path differs between Jellyseerr/Seerr versions.

## Authentik
Moved to **[authentik.md](authentik.md)**: installation, OAuth2/OpenID provider and application (redirect URI `${PUBLIC_URL}/auth/callback`, `OIDC_ISSUER` with trailing slash), groups and `ADMIN_GROUP`, mandatory MFA, recovery, branding, troubleshooting. The complete installation of FriendFlix is in [setup.md](setup.md).

### Invitations with account creation
Moved to [authentik.md §7–§9](authentik.md#7-enrollment-flow-for-invitations): enrollment flow (`AUTHENTIK_ENROLL_FLOW`), service account and API token with least privileges (`AUTHENTIK_API_TOKEN`), `AUTHENTIK_URL`, and the troubleshooting table ([§15](authentik.md#15-troubleshooting)). Ready-made blueprints: [`deploy/authentik/`](../deploy/authentik/).

## ntfy / Discord
`NTFY_URL=https://ntfy.example.com/friendflix` and/or `DISCORD_WEBHOOK_URL=...` for "now available", pending wishes, voting events.

## Web Push (browser notifications)
Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (both required; `VAPID_SUBJECT` optional, default `PUBLIC_URL`) to enable per-device browser push. Generate a key pair with `node scripts/gen-vapid.mjs` (prints ready-to-paste env lines) or `npx web-push generate-vapid-keys`. The private key can be supplied as a Docker secret (`VAPID_PRIVATE_KEY_FILE`, see `compose.secrets.yaml`: `secrets/vapid_private_key` must exist; an empty file counts as unset and leaves push disabled). An invalid key pair is detected at startup, logged as a warning and also disables push. Keep the pair stable: changing it invalidates all existing subscriptions.

- Users enable it under *Einstellungen → Benachrichtigungen* (per device). Personal notices go to that user's subscriptions; announcements (movie night, "now available") only to devices that opted in. Non-owner profiles only ever see a generic "Neue Benachrichtigung" text.
- The portal must be served over HTTPS. On iOS (16.4+) the site has to be installed first (Share -> "Zum Home-Bildschirm").
- The backend only posts to the browsers' push services (FCM, Mozilla, Windows, Apple); other endpoints are rejected. Outbound HTTPS to those hosts must be allowed.
- Subscriptions are removed automatically when the push service reports them gone (404/410), after a device or session revoke, or after repeated failures for over 7 days.
