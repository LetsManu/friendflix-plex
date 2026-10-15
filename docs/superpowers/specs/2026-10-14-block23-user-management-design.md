# Block 23 – User management and in-app login (design)

Date: 2026-10-14 · Status: design approved in chat; this written spec is for review

## Goal

User management that is state of the art for a private streaming portal:
- Admins see and manage everything about an account in one place.
- Users manage their own account themselves.
- Signing in, resetting a password and setting up 2FA all happen in FriendFlix screens. Authentik stays the account store, but its pages are no longer shown.

Owner decisions (chat, 2026-10-14):
- **Scope:** a user detail page, per-user limits with access-until, Authentik actions from FriendFlix, and lifecycle and privacy (approval queue, invites merged in, bulk actions, export and deletion).
- **Self-service:** full.
- **First Authentik login without an invite:** goes to an approval queue.
- **Access-until reached:** the account is locked. User and admins are notified 3 days before and on the day; extending takes one click.
- **Admin view of watching:** shows titles too.
- **Deleting your own account:** 7-day grace period.
- **Login:** FriendFlix drives Authentik in the background (flow executor API) and shows its own screens. SMTP is available; Authentik sends the e-mails.

Not in scope:
- Replacing Authentik.
- FriendFlix-native passwords.
- Live TV limits: added in Block 24.
- Plex fork port: a follow-up. The adapters keep the seam.

## Part A – Admin user management

### A1. User list (`/admin/users`, rebuilt)
- Search over name, e-mail and Jellyfin username.
- Filters:
  - role
  - status: active / locked / pending approval / expiring in 7 days / deletion pending
  - last active: 7 / 30 / 90+ days
- Columns, all sortable except avatar:
  - avatar, name, e-mail, role
  - number of profiles and devices
  - last active
  - 2FA state (from Authentik, cached 10 min; "–" without the Authentik API)
  - access until
- Bulk selection and actions: change role, lock, unlock, set or extend access-until, sign out everywhere. Bulk actions need a confirmation dialog that lists the names.
- **Tab "Waiting for approval":** each person shows name, e-mail, when they asked and the Authentik source. Approve with role (+ optional access-until), or reject (with an optional message).
- **Tab "Invites":** today's invites page moves here.
  - Invite fields: role, max uses (default 1), invite expiry, optional access-until for accounts made from it, a note, a QR code and a copy link.
  - Per invite, the accounts it created.
  - The old route redirects.

### A2. User detail page (`/admin/users/<id>`)
- **Header:**
  - avatar, name, e-mail, role, status chip, access until
  - 2FA/passkey state
  - created / last active
- **Quick actions:**
  - lock or unlock
  - sign out everywhere
  - change role
  - extend access (+30 days, +90 days, date, unlimited)
  - send a password-reset e-mail
  - send a 2FA-setup e-mail
- **Tabs:**
  - **Overview:**
    - totals for 7 / 30 days and all time: hours watched, streams, downloads, requests
    - linked accounts (Jellyfin user, request service) with health, plus a "Repair link" action. It re-applies the role template and re-links the request-service user, using what exists today.
  - **Profiles:** name, kids flag and age limit, avatar, last used. Admins can rename profiles or reset a profile PIN.
  - **Devices & sessions:** device, last seen and approval state. Actions per device: approve, remove, or sign out just that session.
  - **Downloads:** active licences, with revoke (existing admin download functions).
  - **Activity:** recently watched titles per profile (last 50) with date and progress.
    - Opening this tab writes `user.activity_viewed` to the audit log.
    - The privacy notice (docs/security.md and the user's account page) says admins can see it.
  - **Limits:** override per person; an empty field means "as role".
    - parallel streams
    - remote bitrate cap
    - max downloads and download quality
    - requests per week (if the request service is on)
  - **Audit:** all audit entries where this user is the target or the actor.
- **Safety rules:**
  - No admin can lock, demote or delete themselves.
  - The last active admin cannot be demoted, locked or deleted.
  - Every change is audited with from/to values.

### A3. Access until (expiry)
- A `users.access_until` column (nullable timestamptz).
- The minute tick does the following:
  - At 3 days before: push + e-mail to the user, and an admin notice (banner issue and push to admins). Sent once, tracked by `expiry_notified_at`.
  - When `access_until` is reached:
    1. Lock the account, using the same code path as the admin lock (Jellyfin disabled, sessions revoked, offline licences revoked).
    2. Audit it as `user.expired`.
    3. Notify the user and the admins.
- Extending an expired account unlocks it, if it was locked only by expiry (`locked_reason = 'expired'`).

### A4. Per-user limits
- A `user_limits` table with columns `user_id, max_streams, remote_bitrate, max_downloads, download_quality, requests_per_week`, each nullable.
- `effectiveRole` becomes `effectiveLimits(ctx, user)`: the role template, overlaid by the user row.
- Every place that enforces role limits today uses it. That covers the backend checks, the gateway authz answer and the `roleMaxBitrate` sent to the player.
- Cached like the roles (about 30 s) and invalidated on change.

### A5. Approval queue
- When OIDC succeeds for an unknown subject and there is no invite token:
  - Create a `pending` user row. There is no Jellyfin account yet.
  - Show the screen "Waiting for approval".
  - Notify admins by push, plus a banner issue.
- **Approve:** create the Jellyfin account and the links as an invite would, set the role and access-until, and notify the user (e-mail via SMTP, push if they enabled it).
- **Reject:** delete the pending row and optionally e-mail the message.
- Pending users cannot reach any API besides `/api/me` (status) and logout.

## Part B – Self-service (account page `/me` → "Account")
- **Profile:** name, avatar, e-mail. The change goes through the Authentik API (the user's own attributes). An e-mail change sends a confirmation through Authentik's e-mail stage if the flow has one.
- **Security:**
  - Change password.
  - 2FA state.
  - Add or remove TOTP, add or remove a passkey, regenerate recovery codes.
  - All of it in FriendFlix screens (see Part C), with recent re-authentication required (≤ 10 min).
- **Sessions & devices:** list with "this device", sign out one, sign out all others (existing endpoints, new UI).
- **Your data:** "Download my data" produces a JSON file built on demand and streamed. It contains:
  - account, profiles, lists, watchlist, ratings, watch history (positions and dates), requests, devices, notification settings
  - no other users' data
- **Delete account:**
  - Confirmation re-authenticates first, and the data export is offered before.
  - The account is locked at once (`deletion_at = now + 7 days`, `locked_reason = 'deletion'`).
  - Admins are notified.
  - Signing in again within 7 days shows "Your account is scheduled for deletion – restore?". Restoring unlocks it.
  - Admins can also restore or delete now.
  - **Final deletion:**
    1. Jellyfin user (and profile users) deleted.
    2. Request-service user unlinked or deleted (per its API).
    3. Offline licences revoked.
    4. FriendFlix rows deleted (profiles, lists, history, devices, push subscriptions).
    5. Audit entries keep a pseudonym (`deleted-<short hash>`) instead of the name.
    6. The Authentik user is deactivated, not deleted. Deleting it is the owner's call, documented.

## Part C – In-app login through Authentik's flow executor

### How it works
Authentik's own UI is a client of `GET/POST /api/v3/flows/executor/<flow-slug>/`. That API returns JSON challenges (`component`: `ak-stage-identification`, `ak-stage-password`, `ak-stage-authenticator-validate`, `ak-stage-authenticator-totp`, `ak-stage-authenticator-webauthn`, `ak-stage-email`, `ak-stage-prompt`, `xak-flow-redirect`, …) and takes the answers.

FriendFlix runs the flow **from the backend**, acting as the browser, and renders each challenge with its own Svelte components:

1. `POST /auth/flow/start { kind: 'login' | 'recovery' | 'enroll' | 'setup-totp' | 'setup-webauthn' | 'change-password', invite? }`
   - The backend opens the flow (the slug comes from config) and keeps the Authentik cookie jar for this attempt in Redis.
   - The jar is encrypted with the existing crypto helper, has a 10-minute TTL, and is keyed by a random flow id in an httpOnly cookie.
   - The backend returns the first challenge, sanitised. FriendFlix passes on only the fields the components need, never Authentik URLs or tokens.
2. `POST /auth/flow/answer { ...stage answer }`: the backend forwards the answer and returns the next challenge, or the end state.
3. **End of a login flow** (`xak-flow-redirect` or flow completion):
   - The backend calls the OIDC authorize endpoint with the jar's Authentik session (`prompt=none`, PKCE, the existing client) and gets the code without any UI.
   - It exchanges the code like `/auth/callback` does today and creates the FriendFlix session.
   - The Authentik session in the jar is then ended and the jar deleted.
   - The provider must allow implicit consent; the setup checker verifies this.
4. **Recovery, setup and change flows** end in a FriendFlix success screen.
   - Recovery: the e-mail link from Authentik points to `https://<app>/reset?token=…`. That needs a custom e-mail template in the recovery flow, documented and shipped as a template file. FriendFlix continues the flow with the token.

### Screens
New Svelte components in `web/src/lib/auth/`, one per supported stage, in FriendFlix's look and in 7 languages:
- identification (user or e-mail)
- password
- TOTP code
- passkey (WebAuthn)
- recovery code
- e-mail sent ("check your inbox")
- prompt fields (enrollment: name, e-mail, password ×2)
- consent (should not appear: treated as an error with a hint)
- "access denied" (Authentik's deny stage message)

An **unknown stage** falls back to "Continue on the sign-in page" (today's redirect flow), so a custom Authentik flow never locks anyone out.

### Passkeys
- WebAuthn challenges carry Authentik's RP ID.
- They work in FriendFlix only when the app's host is the RP ID or a subdomain of it. Example: app `tv.example.com`, Authentik `auth.example.com`, WebAuthn stage RP ID `example.com`.
- The setup checker detects a mismatch:
  - FriendFlix then hides the passkey option in its own screens.
  - It offers "Set up passkey on the sign-in page" (Authentik popup) instead.
  - This is documented in docs/authentik.md.

### Security
- Rate limits per IP and per username, on top of Authentik's own.
- The backend sends `X-Forwarded-For` with the client IP. docs/authentik.md explains adding FriendFlix as a trusted proxy, so Authentik's reputation and brute-force policies see the real IP and not the server's.
- Passwords and codes are never logged or stored. Request bodies of `/auth/flow/*` are excluded from error logs.
- CSRF follows the existing double-submit pattern, and flow ids are single-use per step.
- A config switch `LOGIN_UI=app|authentik` (default `app` when the Authentik API is configured, else `authentik`). With `authentik`, today's redirect login stays. The redirect is always reachable at `/auth/login?classic=1` as a fallback.

### Config
New variables, all optional; the defaults are Authentik's default slugs:
- `AUTHENTIK_LOGIN_FLOW`, `AUTHENTIK_RECOVERY_FLOW`
- `AUTHENTIK_TOTP_SETUP_FLOW`, `AUTHENTIK_WEBAUTHN_SETUP_FLOW`, `AUTHENTIK_PASSWORD_CHANGE_FLOW`
- the existing `AUTHENTIK_ENROLL_FLOW`

Admin → Status gets a check for each flow: it exists, its stages are supported, and the provider has implicit consent.

## Data changes
- `users`:
  - `status text not null default 'active'` (`active | pending | locked`)
  - `locked_reason text`
  - `access_until timestamptz`
  - `expiry_notified_at timestamptz`
  - `deletion_at timestamptz`
  - `avatar text`
  - `last_active timestamptz`, derived from devices but stored for sorting
- `disabled` stays for compatibility; it is set when `status = 'locked'`.
- New tables:
  - `user_limits`
  - `invite_uses (invite_id, user_id, at)`
  - `approval_requests (user_id, requested_at, source, note)`
- Invites get `max_uses`, `uses`, `access_days`, `note`.

## Error handling
- Authentik down or the API token invalid:
  - The login screen shows "Sign-in service unavailable" with a retry, and the classic redirect as a link.
  - Admin actions show the Authentik error briefly.
- Flow timeout (10 min): "Session expired, start again".
- Jellyfin errors during approve or delete: the step is retried by the tick; the admin sees "pending cleanup" until it is done.

## Testing
- **Unit:**
  - effectiveLimits overlay
  - expiry tick (notify once, lock, unlock on extend)
  - approval and rejection
  - deletion grace, restore and final cleanup (with fake Jellyfin, request service and Authentik)
  - export content (no other users' data)
  - last-admin guard
  - flow executor client with recorded Authentik challenge fixtures: login with password, password + TOTP, recovery with token, unknown stage fallback, redirect end, jar expiry
  - sanitising (no URLs or tokens leak)
- **e2e (mocked API):**
  - user list filters and bulk actions
  - detail tabs and the activity audit
  - approval tab
  - invites tab with QR
  - self-service export and delete flow
  - login screens for each stage, on phone and desktop, with a11y names
- Coverage thresholds hold. The new strings are in all 7 languages.
- **Manual against a real Authentik:**
  - login with password + TOTP
  - recovery e-mail link into the app
  - TOTP setup
  - passkey (only with a matching RP ID)

## Phases
1. **Admin side:** data changes, user list, detail page, limits, expiry, approval queue, invites tab.
2. **Self-service:** account page, export, deletion with grace.
3. **In-app login:**
   - the flow executor client and the login and recovery screens
   - setup flows (TOTP, passkey, password change)
   - status checks and docs for Authentik settings (templates, trusted proxy, RP ID, implicit consent)

Each phase is its own PR.
