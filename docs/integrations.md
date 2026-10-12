# Integrations (Jellyfin, Seerr, Authentik, ntfy/Discord)

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
1. Provider: OAuth2/OpenID, confidential, redirect URI `https://portal.example.com/auth/callback`, scopes `openid profile email` + a `groups` property mapping (claim `groups`).
2. Application slug `friendflix` → `OIDC_ISSUER=https://auth.example.com/application/o/friendflix/`.
3. Group `friendflix-admins` (= `ADMIN_GROUP`): members become portal admins on first login (no invite needed).
4. **MFA mandatory:** Authenticator Validation Stage in the authentication flow: *Not configured action = Force the user to configure an authenticator*, device classes TOTP + WebAuthn. Same in the enrollment flow.
5. Invitations with account creation: see below. Without them, an invited person must already have an Authentik account; anyone who logs in without a portal invite (and is not in `ADMIN_GROUP`) gets `403 no_invite`.

### Invitations with account creation

Goal: the admin creates an invite, the friend opens the link, clicks **Konto anlegen & loslegen**, signs up in Authentik (incl. MFA) and lands logged in on the portal with the invite's role. No manual Authentik work per person.

How it works:
1. `POST /api/admin/invites` creates the portal invite and, via the Authentik API, a single-use invitation bound to the enrollment flow (`GET /api/v3/flows/instances/<slug>/`, then `POST /api/v3/stages/invitation/invitations/` with `name`, `expires`, `single_use: true`, `flow`). Expiry matches the portal invite.
2. The invite page button points at `/auth/enroll?invite=<token>`. The portal starts the OIDC login (invite stored in the server-side state, valid 30 min) and redirects to
   `https://auth.example.com/if/flow/<slug>/?itoken=<invitation>&next=/application/o/authorize/?…`.
3. After the last stage Authentik follows `next`. Authentik only accepts a **relative** `next`, which is why the portal passes the path of its own authorize request. The user is now logged in to Authentik, so the authorize request goes straight to `/auth/callback`, which redeems the invite and creates the portal + Jellyfin account.

(The invitation's `fixed_data` only pre-fills prompt fields, so it cannot carry the redirect. That's why the portal uses `next`.)

Authentik setup (tested shape: 2024.x – 2026.x):
1. **Enrollment flow**: Flows → Create, designation *Enrollment*, slug e.g. `friendflix-enrollment`, authentication *No requirement*. Stage bindings in order:
   1. *Invitation stage*, **Continue flow without invitation: off** (only invited people can sign up).
   2. *Prompt stage* (username, name, email, password, password repeat).
   3. *User Write stage* (create users as active; optionally add them to a group).
   4. *Authenticator Validation stage*, *Not configured action = Force the user to configure an authenticator*, device classes TOTP + WebAuthn (or bind TOTP/WebAuthn setup stages).
   5. *User Login stage*. **Required**: without it the person must log in again after sign-up.
   Do **not** add a *Redirect stage* or an expression policy that sets a redirect. It overrides `next` and the person ends up in the Authentik user interface instead of the portal.
2. **API token**: create a service account (Directory → Users → Create service account, e.g. `friendflix-invites`). Give it a role with the permissions *Can add Invitation*, *Can view Invitation* and *Can view Flow* (Directory → Roles → Assign permissions), or make it a superuser. Directory → Tokens → Create: user = that account, **intent API**, no expiry (or rotate it). Copy the key.
3. Portal `.env` (all three, or none):
   ```
   AUTHENTIK_URL=https://auth.example.com          # public base URL, no path
   AUTHENTIK_API_TOKEN=<token key>                  # or AUTHENTIK_API_TOKEN_FILE
   AUTHENTIK_ENROLL_FLOW=friendflix-enrollment      # the flow *slug*, not its name
   ```
   Then recreate the backend container (`docker compose up -d backend`). Compose passes the variables through with an empty default, so a missing `.env` entry silently turns the feature off.

Troubleshooting (`no_invite`, or no "Konto anlegen" button):
- The admin invite page shows the result right after creating an invite: *führt durch die Konto-Erstellung* = OK; *nicht konfiguriert* = env vars missing; *konnte nicht erstellt werden* = API error. The backend logs a warning with the reason. At startup it logs `Authentik invitations disabled: … not set` if only some variables are set.
- Log reasons: `enrollment flow "…" not found` (wrong slug); `rejected AUTHENTIK_API_TOKEN` (401: wrong token or intent); `invitation creation failed (… "Can add Invitation" …)` (403: missing permission); `Authentik unreachable` (DNS/TLS/firewall from the backend container to `AUTHENTIK_URL`).
- Check by hand from the backend container:
  `curl -H "Authorization: Bearer $AUTHENTIK_API_TOKEN" $AUTHENTIK_URL/api/v3/flows/instances/$AUTHENTIK_ENROLL_FLOW/`
- Invites created before the fix have no Authentik invitation: create a new one.
- `no_invite` after the fact (someone already has an Authentik account but no portal account): create an invite with **hat schon ein Authentik-Konto** ticked (`"enroll": false`). The link then only offers *Anmelden & freischalten*.

## ntfy / Discord
`NTFY_URL=https://ntfy.example.com/friendflix` and/or `DISCORD_WEBHOOK_URL=...` for "now available", pending wishes, voting events.

## Web Push (browser notifications)
Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (both required; `VAPID_SUBJECT` optional, default `PUBLIC_URL`) to enable per-device browser push. Generate a key pair with `node scripts/gen-vapid.mjs` (prints ready-to-paste env lines) or `npx web-push generate-vapid-keys`. The private key can be supplied as a Docker secret (`VAPID_PRIVATE_KEY_FILE`, see `compose.secrets.yaml`: `secrets/vapid_private_key` must exist; an empty file counts as unset and leaves push disabled). An invalid key pair is detected at startup, logged as a warning and also disables push. Keep the pair stable: changing it invalidates all existing subscriptions.

- Users enable it under *Einstellungen → Benachrichtigungen* (per device). Personal notices go to that user's subscriptions; announcements (movie night, "now available") only to devices that opted in. Non-owner profiles only ever see a generic "Neue Benachrichtigung" text.
- The portal must be served over HTTPS. On iOS (16.4+) the site has to be installed first (Share -> "Zum Home-Bildschirm").
- The backend only posts to the browsers' push services (FCM, Mozilla, Windows, Apple); other endpoints are rejected. Outbound HTTPS to those hosts must be allowed.
- Subscriptions are removed automatically when the push service reports them gone (404/410), after a device or session revoke, or after repeated failures for over 7 days.
