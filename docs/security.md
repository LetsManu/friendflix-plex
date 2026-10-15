# Security model and assurance case

This page describes what FriendFlix promises about security, where the trust boundaries are, who is expected to attack what, and why the design should hold up. It is written for admins deciding whether to run FriendFlix and for reviewers. Where something depends on how you configure your own proxy, identity provider or media server, the text says so. To report a vulnerability see [SECURITY.md](../SECURITY.md).

FriendFlix is maintained by one person. Everything below is what the code, the compose files and the CI pipeline in this repository do; it is not an independent audit.

## Security requirements

**What you can expect**

- Only people with an invitation, or whose sign-in request an admin approved, can get an account, and only a signed-in session can reach media or personal data. Sign-in goes through your OIDC identity provider (the docs use Authentik; multi-factor authentication is configured there).
- The browser never receives a media-server token. It holds a session cookie (`ff_sid`, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS) and plays `/media/...` URLs that only the gateway can resolve.
- Every playlist and segment request is authorised by the backend (session, profile, role limits) before the gateway fetches it from the media server. Hidden titles and kids-profile restrictions are enforced server side.
- Secrets stored by FriendFlix (per-user media-server credentials, admin-saved API keys) are encrypted at rest with a key you control (`APP_ENC_KEY`). Profile PINs are stored as salted scrypt hashes.
- Admins can see what a person watched (*Admin → Users →* a person → *History*, read from the media server). Every time an admin opens it, FriendFlix writes `user.activity_viewed` with the admin and the person to the audit log, which other admins can read. Other admin pages (usage, status) show only totals, never titles.
- Each person can download their own data and delete their own account (*My space → Account*). Deleting needs a fresh sign-in, waits 7 days so it can be undone, and then removes the account everywhere FriendFlix reaches; the audit log keeps a pseudonym instead of the name. See [Account self-service](#account-self-service).
- State-changing API calls need a per-session CSRF token. Error reports from the browser are scrubbed and stay in your server log.
- Published container images are scanned, signed and ship with an SBOM and provenance (see [Supply chain](#supply-chain)).

**What you cannot expect**

- Protection against a compromised admin account, host, Docker daemon or identity provider. Those are fully trusted.
- A hardened internet-facing edge by itself: TLS, HSTS and the public reverse proxy are yours to run ([TLS recommendation](#tls-recommendation)).
- Copy protection. There is no DRM; anyone allowed to watch a title can record it, and offline downloads are for trusted people. Expiry and revocation of downloads are enforced by the app, not by the file.
- A kids profile is a parental guard, not a lock against someone who knows the account login (see "Known limitations" in the README).
- Multi-tenant isolation. FriendFlix is for one household or friend group, not for hosting strangers ([ROADMAP.md](../ROADMAP.md), "Out of scope").
- Security of Jellyfin, your request service, Authentik or the reverse proxy; report those upstream.
- Horizontal scaling: rate limits and watch-party rooms live in the memory of the single backend replica.

## Trust boundaries

```
Internet --TLS--> reverse proxy (yours, :443)
                    |-- web      (SvelteKit, 127.0.0.1)   front network
                    |-- backend  (Fastify, 127.0.0.1)     front + db + media + egress
                    '-- gateway  (Node, 127.0.0.1)        front + media
backend --> postgres, redis    (db network, internal: no egress, no host access)
backend, gateway --> media server (media network, internal)
backend --> OIDC provider, notification services (egress)
```

Networks and ports are defined in [compose.yaml](../compose.yaml); the diagram and the "press play" flow are in [architecture.md](architecture.md).

| Boundary | Who is on each side | What crosses it and how it is checked |
|---|---|---|
| Browser to reverse proxy | Any client on the internet to your TLS terminator | HTTPS only; HSTS and TLS settings are configured at the proxy ([setup.md](setup.md)). Treated as untrusted input from here on. |
| Reverse proxy to web, backend, gateway | Your proxy to three ports bound to `127.0.0.1` (`BIND_ADDR`) | Requests are routed by path (`/api`, `/auth`, `/ws` to the backend, `/media` to the gateway). The backend sets `trustProxy` and so relies on the proxy for the client address. |
| Web to backend | SvelteKit app to API | Cookie session plus CSRF header on state-changing requests. The web container holds no secrets. |
| Gateway to backend | Media path to authorisation | Shared `INTERNAL_SECRET` header on `/internal/authz` and `/internal/gateway-config`; the authz answer (user's media token and limits) is cached for 5 s and never stored, the config answer carries only the settings revision and the media server URL. |
| Backend and gateway to Postgres and Redis | App to data stores | Only the backend reaches them, over the `db` network which is `internal`. Redis requires a password and persistence is switched off (sessions are not written to disk). |
| Backend and gateway to media server | Admin API key and per-user tokens | Only on the `media` network (internal). The gateway allowlists upstream paths and clamps height and bitrate before forwarding. |
| FriendFlix to identity provider | OIDC discovery and code exchange | Authorization code flow with PKCE (S256), `state` and `nonce`, and a cookie binding the flow to the browser. The IdP is trusted to authenticate users and enforce MFA. |
| Cast and AirPlay receivers | TV or speaker on the viewer's network to the gateway | The receiver cannot send cookies, so it gets a short-lived, revocable cast token in the URL path. See [cast.md](cast.md). A receiver is untrusted: it only ever holds that token. |
| Web Push and notification services | Backend to push services, ntfy, Discord | Outbound only; keys and webhook URLs are admin-configured secrets. |

## Threat model

| Who | Wants | Main defences |
|---|---|---|
| Anonymous internet client | Reach media or the API without an account; find bugs in public endpoints; take over a new install before its owner | Everything except health, version, invite redemption, the approval-request status (`/api/pending`, read through a signed cookie) and the TV pairing endpoints needs a session; the gateway rejects paths outside its allowlist; a new install opens only the setup wizard, behind a one-time code from the server log ([Setup wizard](#setup-wizard)); global and per-route rate limits; strict response headers. |
| Invited user (friend, family, guest) | See more than their role allows (hidden titles, higher bitrate, other people's data), stay signed in on stolen devices | Role and profile checks in the backend, bitrate and stream caps enforced by backend and gateway, device approval, session idle and absolute timeouts, per-user data scoping. |
| Kid with access to a family device | Leave a kids profile | Profile PIN (scrypt, attempt-limited). Limited by design, see above. |
| Holder of a leaked URL or cast token | Replay a stream URL | Cast tokens are random, hashed at rest, bound to the first client address, expire, are revocable and limited to two per account. |
| Malicious web page or injected script | Act as the user (CSRF/XSS), read tokens | CSRF token, `SameSite=Lax`, `HttpOnly` cookies, strict CSP, `nosniff`, `X-Frame-Options: DENY`. No media token reaches the browser. |
| Attacker with a stolen database or Redis dump | Read credentials | Media-server passwords and API keys are AES-256-GCM encrypted; PINs are scrypt hashes; Redis holds only SHA-256 hashes of cast tokens; sessions are not persisted. |
| Compromised dependency or CI | Ship malicious images | Pinned actions and base images, lockfile with `npm ci`, dependency audit, Trivy gate, signed and attested images. |
| Malicious or buggy receiver or media server | Abuse the gateway, SSRF-style fetches | Gateway only forwards allowlisted, server-relative paths; absolute and protocol-relative URLs are refused. |

Out of scope for the model: physical access to the host, a malicious admin, and attacks on the media server or IdP themselves.

## Assurance case

The claim: *a signed-out or under-privileged client cannot obtain media or another user's data, and a stolen data store or a leaked image does not reveal reusable secrets.* The argument rests on four properties, each backed by code you can read.

1. **No ambient media credentials in the browser.** The browser has a cookie and `/media/...` URLs. The media token is fetched per request by the gateway from the backend (`/internal/authz`) and never stored there. Even a full XSS in the web app has no media token to steal.
2. **Every media request is mediated.** The gateway asks the backend on each playlist and segment request ("complete mediation"), so revoking a session, disabling an account or changing a role takes effect within the 5 second cache.
3. **The data layer is not reachable from outside.** Postgres and Redis sit on an `internal` Docker network without egress or published ports; only the backend joins it.
4. **Secrets at rest are protected or hashed.** See [Cryptography](#cryptography).

These are backed by automated checks in CI (lint, type check, unit and end-to-end tests, dependency audit, image scan, a ZAP baseline scan of the built web app) described under [Supply chain](#supply-chain). Residual risks are the trusted components listed under "What you cannot expect" and any bug not yet found.

### Secure design principles

| Principle | How it is applied | Where |
|---|---|---|
| Least privilege | Containers run as non-root (`USER node`), drop all capabilities and cannot gain privileges. Only the backend sits on the db network. The gateway mounts downloads read-only. Roles cap bitrate, resolution and concurrent streams. Cast tokens are scoped to one title (poster tokens to images only). | `compose.yaml`, `backend/Dockerfile`, `gateway/Dockerfile`, `backend/src/cast.ts` |
| Complete mediation | Gateway authorises every playlist and segment through the backend; the CSRF hook runs on every state-changing `/api` request; item visibility is checked before external lookups. | `gateway/src/gateway.ts`, `backend/src/app.ts` |
| Fail-safe defaults | Ports bind to `127.0.0.1` by default; unknown gateway paths are rejected; unauthenticated requests get 401; "Share history" is off by default; the backend refuses to start without its bootstrap secrets; webhooks answer 403 while no webhook secret is set; an unreadable encrypted value is treated as unset. | `compose.yaml`, `backend/src/config.ts`, `backend/src/settings/resolve.ts` |
| Economy of mechanism | Small set of building blocks: Node `crypto`, Fastify plugins, one media-server interface, one gateway allowlist. No custom cryptography or protocol. | `backend/src/crypto.ts`, [architecture.md](architecture.md) |
| Separation of privilege | Admin API key lives only in the backend; the gateway only knows `INTERNAL_SECRET` (from its own volume) and gets user tokens on demand; the web container holds no secret; admin role comes from an IdP group (`ADMIN_GROUP`). | `compose.yaml`, [architecture.md](architecture.md) |
| Defense in depth | Proxy, then session and CSRF, then role checks, then gateway allowlist and clamps, then internal networks, then container hardening, then encryption at rest. | all of the above |

### Common weaknesses

How the OWASP Top 10 classes are addressed. This is a design summary, not a proof.

| Class | Countermeasure |
|---|---|
| Broken access control | Role and profile checks in routes; hidden items return 404; per-user scoping; gateway authorisation per request; admin routes require the admin role. |
| Cryptographic failures | AES-256-GCM with random 96-bit IV, scrypt with random salt, CSPRNG tokens, HTTPS expected at the edge, cookies `Secure` over HTTPS. |
| Injection | Input validated with zod schemas (invalid input gives 400); database access through the `pg` client with parameters (see queries in `backend/src`); Fastify's JSON parser keeps prototype-poisoning protection; request body limit 256 KiB. |
| Insecure design | This page; separate gateway; internal networks; limits per role. |
| Security misconfiguration | Secure defaults in compose, read-only root file systems, readiness check, the [operations](operations.md) and [setup](setup.md) checklists, a ZAP baseline in CI. |
| Vulnerable components | Lockfile, `npm audit --omit=dev --audit-level=high` in CI, Trivy image scan, Dependabot for npm, Docker and Actions. |
| Identification and authentication failures | OIDC with PKCE, `state` and `nonce`; MFA at the IdP; sliding idle timeout (`SESSION_IDLE_SECONDS`, default 2 h) and absolute lifetime (`SESSION_TTL_SECONDS`, default 8 h); device approval; PIN attempt limits. |
| Software and data integrity failures | Pinned base-image digests and action SHAs, signed images with attestations, `npm ci`. |
| Logging and monitoring failures | Admin audit log, `/metrics` (bearer token when `METRICS_TOKEN` is set; also block it at the proxy), slow-request logs, scrubbed client error reports ([monitoring.md](monitoring.md)). |
| Server-side request forgery | The gateway forwards only allowlisted server-relative paths; `mediaFetch` refuses absolute and protocol-relative URLs. External lookups use fixed provider hosts. |

## Account self-service

Each person manages their own account on *My space → Account* (`/me/account`, main profile only; kids and other profiles cannot open it). Admins have matching actions on *Admin → Users →* a person. Everything here is audited; self-service entries record which fields changed (`{ fields }`), never the old or new values.

The account page also tells the person what admins can see: **"Admins can see which titles you watched recently. Every look at them is recorded in the audit log."** This is the same history view described under [Security requirements](#security-requirements) (`user.activity_viewed`).

### Re-authentication

Deleting the account needs a sign-in that is at most **10 minutes** old. The account page sends the person through `GET /auth/reauth`, an OIDC login with `prompt=login` and `max_age=0`, so the identity provider asks for the password and MFA even when its session is still valid. The callback checks that the identity provider's `auth_time` is at most 2 minutes old and that the `sub` is the session's own (a different person gets nothing and an audit entry `session.reauth_mismatch`). It then stamps the portal session with the time (`reauthAt`, audit `session.reauth`). Sensitive routes check the stamp with one guard, `requireRecentAuth`, and answer `401 reauth_required` without it. *Admin → Settings* checks the same stamp for sensitive changes ([Settings and generated secrets](#settings-and-generated-secrets)).

A later release replaces only the producer: an in-app password screen through Authentik's flow executor sets the same stamp, and the guard stays as it is. Until then, changing the password and two-factor methods happens on Authentik's own user settings page ([authentik.md §8.4](authentik.md#84-account-page-and-account-deletion)). The e-mail address is read-only in FriendFlix for now; a later release may change that.

### Download my data

*Your data → Download my data* (`GET /api/account/export`) builds one JSON file on demand and streams it; nothing is stored on the server. It needs the owner session but no re-authentication, is limited to 5 downloads per hour, and is audited (`account.export`). Every query names its columns and reads only the account's own rows, so a column added later never leaks by accident.

What it contains:

- **Account:** id, name, e-mail, role, avatar, created, access until.
- **Profiles:** name, avatar, kids flag and age limit, owner flag, created.
- **Lists:** own lists in full (description, look, items with your own notes; items others added are marked `addedByMe: false` without who). Lists you are a member of: only their name and the items you added.
- **Watchlist and more:** watchlist, bookmarks with notes, reminders, followed series, series audio/subtitle choices, titles hidden from *Continue watching*.
- **Ratings:** stars with reviews, thumbs, reactions with comments.
- **History:** the media server's watch history per profile (up to 1,000 items each, marked `truncated` when there is more and `error` when the media server could not answer), plus FriendFlix's own watch-time totals per title and per day.
- **Requests:** title, type, date and current state (the state is asked of the request service for the newest 100).
- **Devices:** label, approved, first and last seen.
- **Notifications:** weekly digest on/off, whether an ntfy topic is set, the number of push subscriptions, and each notice's kind, date and read state.
- **What you wrote in shared places:** your episode comments (also deleted ones, flagged), your poll choices (the poll's title only for polls you created), recommendations you sent (title and note, without the recipient).
- **Achievements.**

What it never contains: other people's ids, names or notes; notification texts (they are rendered with other people's names); device ids; push endpoints and keys; the ntfy topic itself (it works like a password); PIN hashes; the Authentik `sub`; any media-server credential.

### Account deletion

*Delete account* first offers the data download, then asks for the fresh sign-in. The last active admin cannot delete their own account (`last_admin`: make someone else admin first).

**At once** (`POST /api/account/delete`, audit `user.deletion_requested`):

- The account is locked: `deletion_at = now + 7 days`, `locked_reason = 'deletion'`. Every session ends on every device, offline licences are revoked, and the media-server users of the account and its profiles are disabled.
- The admins get a notice with the name and the date.
- The Authentik user stays **active** for now: signing in is how the person restores the account.

**Grace period (7 days):** signing in again shows "Your account is being deleted – restore?" (`/restore`, reached through a signed `ff_restore` cookie valid for 15 minutes). *Restore my account* unlocks it (or, if the person's access ended meanwhile, keeps it locked as "access ended"); *Keep the deletion* leaves it scheduled. Admins can *Restore account* or *Delete now* on the person's page (delete now moves the date to now; the next run, within a minute, starts the deletion). Unlocking a deletion-locked account from the list is a restore as well.

**Final deletion.** A background job runs every 60 seconds. It first claims a due account: from that moment nothing can be restored, and a sign-in answers `403 account_deleted`. Then it runs six steps, each safe to repeat, and remembers the last one that finished, so a restart continues where it stopped:

1. **Media server:** the account's user and every profile user are deleted (one already gone counts as done).
2. **Request service:** the linked request-service user is deleted (404 counts as done).
3. **Offline licences:** revoked again (the lock already did it; repeated for safety).
4. **FriendFlix rows:** in one transaction, the account and everything that hangs off it (profiles, lists, watchlist, ratings, history, devices, push subscriptions, limits …), the person's approval request, and the admin notices that name the person (those linking to the account and those keyed by its id). Redis caches for the account and its profiles are cleared.
5. **Audit log:** in every entry the person made or that is about them, the keys `name`, `email`, `jellyfin`, `username` and `ip` (and names nested in profile changes) are removed and replaced by the **pseudonym**. Entries of the person's approval request (`user.rejected`, which can quote the name in the admin's message) are scrubbed the same way, message included.
6. **Authentik:** the user is **deactivated** (`is_active: false`), never deleted. Deleting it is the owner's call; the steps are in [authentik.md §8.4](authentik.md#84-account-page-and-account-deletion). Without the Authentik API token (or when the user is not found) this step is skipped and recorded as `authentik: not_configured` / `not_found`. **The Authentik user then stays active: the person can sign in again and lands in the approval queue as a new person (a member of `ADMIN_GROUP` gets a new admin account instead).**

When all six are done, the admins get a notice with the pseudonym and the audit log gets `user.deleted`.

**When a step fails** it stores only an error code (never a message that could quote a URL or token), audits `user.deletion_failed` and notifies the admins once per step. The step is then **retried once a minute, without backoff, until it succeeds or an admin fixes the cause** (for example the media server is down, or the Authentik token lacks *Can change User*). *Admin → Users*, filter *Deletion pending*, shows such an account as "Cleanup step n of 6" with the error. See [operations.md](operations.md#kontolöschung).

### The pseudonym

`deleted-` plus the first 8 hex characters of `HMAC-SHA256(APP_ENC_KEY, "friendflix deleted v1|" + account id)`, for example `deleted-3f9a1c07`. It is stable (every entry of the same person gets the same one, so the log still reads as one story) and cannot be turned back into the account id without the key. The audit views show it wherever the name used to be.

### What stays, and for how long

- **The deletion record:** account id, pseudonym, start and end time, kept for good so the audit views can resolve the pseudonym. The name, e-mail, Authentik `sub`, media-server ids and request-service id it held during the cleanup are cleared when the deletion finishes.
- **The audit log:** entries stay (there is no automatic pruning), with the pseudonym instead of the name.
- **The deactivated Authentik user** until the owner deletes it.
- **Database backups** made before the deletion still contain the account until they rotate out (`BACKUP_KEEP_DAYS`, default 14 days; copies elsewhere follow your own rules). Restoring such a dump brings the account back.
- **Places FriendFlix does not scrub**, where the person's name may remain:
  - invite notes (an admin's free text, which may name the invitee);
  - notices in other people's inboxes that were rendered with the name: list invitations, watch-party invitations and recommendations (including the sender's note);
  - the admins' "new sign-in waiting for approval" notice;
  - `user.rejected` audit entries of a request that never became this account (for example: rejected, then joined through an invite);
  - free text other people wrote, such as a list or poll title, a comment or an admin's note in another audit entry.
- Items (and their notes) the person added to other people's lists stay, without who added them.
- A deleted admin's own administrative audit entries lose their name-type keys too (hub, source or item names), which removes some non-personal detail.

## Settings and generated secrets

Settings live in the database and are changed by admins in *Admin → Settings*; the secrets needed before the database can be read are generated on the host. The rules:

- **Bootstrap volume.** The `bootstrap` service writes the database and Redis passwords, `APP_ENC_KEY` and `INTERNAL_SECRET` into the `bootstrap` volume and exits. It runs as root with no capability but `CHOWN`, a read-only root file system and no network. Files are owned by `root:10001` with mode `0440`, the directory `0750`; only the containers that need them join group `10001` (`backend`, `redis`, the `backup` sidecar, and the gateway, which mounts only its own `bootstrap-gateway` volume; Postgres reads its password file as root in its entrypoint). Writes are atomic and synced to disk. It logs file names and actions, never values. It refuses to replace an empty `postgres_password` or `app_enc_key` on a volume that holds other files, because a new value would lock out the existing data.
- **Gateway-only volume.** The gateway mounts `bootstrap-gateway`, which holds a copy of `INTERNAL_SECRET` and nothing else: it never sees the database password or the encryption key, and it is still not on the `db` network. It gets its media server URL from the backend (`GET /internal/gateway-config`, behind `INTERNAL_SECRET`) and logs only the URL's origin.
- **Environment wins.** A value from the environment or a `_FILE` secret cannot be changed from the web UI; the page shows it locked. Saved values are validated against the same schema as environment values.
- **Write-only secrets.** Secret settings are encrypted with `APP_ENC_KEY` (see [Cryptography](#cryptography)) in the `settings` table. `GET /api/admin/settings` never returns them: only *set* / *not set*, the change date and, for data-source API keys, the last four characters. Credentials inside a non-secret URL (user info, ntfy's `auth` query) are shown redacted, and a submitted URL that still holds the redaction is refused. A generated webhook secret is returned once, with `Cache-Control: no-store`; the VAPID private key never leaves the server.
- **Fresh sign-in for sensitive changes.** Saving a secret, `PUBLIC_URL`, `HOME_NETWORKS`, `ADMIN_GROUP`, `NTFY_URL` / `NTFY_BASE_URL`, any `OIDC_*` or `AUTHENTIK_*` value or a URL a stored credential is sent to, generating a secret, and any save or test that would send a stored credential to a changed host need a sign-in at most 10 minutes old ([Re-authentication](#re-authentication)). So does replacing or removing a data-source key in *Admin → Data sources*. **Move** / **Move all** (`settings.import_env`) needs no fresh sign-in: it copies a value that is already in effect from the environment into the database and returns nothing; changing it later follows the rules above.
- **Checks and logs carry codes, not data.** Each save probes the affected service with the candidate values; probe results and validation errors are codes, never an upstream body. The audit log records `settings.update`, `settings.import_env` and `settings.generate` with key names only.
- **Revision-only broadcast.** After a save the backend publishes only the new revision number on the Redis channel `ff:settings:rev`; every instance then reloads from the database (and polls the revision every 30 s in case a message is lost). Values never travel over Redis. A stored value that cannot be decrypted or fails validation is ignored, flagged in the UI and logged by key name only.
- **No Docker socket.** No FriendFlix container gets `/var/run/docker.sock`; the web app cannot control Docker.

## Setup wizard

A new install has no admin and no sign-in yet, so the first run is protected by a one-time code instead (`backend/src/setup/`, `backend/src/routes/setup.ts`):

- **Setup mode.** Until setup completes, every route except `/health`, `/api/version`, `/api/setup/*`, `/internal/gateway-config` and the first admin's `/auth/login` / `/auth/callback` (only with a valid setup session) answers `503 setup_required`, and background jobs do nothing; those two sign-in routes, browser navigations, send a request without a setup session back to the wizard (`/setup`, or `/setup?expired=1` from the callback) instead. The gate matches the route pattern, so unknown or encoded paths are gated too. Once setup is complete, the public `GET /api/setup/state` answers `{ "complete": true }` and nothing else.
- **Setup code.** The backend that runs the background jobs (`BACKGROUND_JOBS=true`) issues a 12-character code (Crockford base32, 60 bits) at start and prints it once to its log; only `sha256` of it is stored, compared in constant time, and it never appears in an answer or another log line. It is valid for 24 hours; every restart replaces it.
- **Limits.** 5 tries per 15 minutes per client address (a route rate limit, counted per backend instance and based on the client address the proxy reports through `trustProxy`: a client that can set its own `X-Forwarded-For` at your proxy gets around it) and 10 wrong codes in total, counted in the database across instances, after which the code is invalidated until the next restart. Anyone who can reach the portal before setup is done can therefore lock the code (but not guess it): finish setup promptly or restrict access until it is done ([setup.md](setup.md#the-setup-code)).
- **Setup session.** A valid code sets `ff_setup` (random token, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, 2 hours sliding; Redis holds only its hash) and the readable `ff_setup_csrf` (`SameSite=Strict`). Every write needs the header `x-ff-setup-csrf` equal to both. `ff_setup` is Lax, not Strict, because the identity provider's redirect back to `/auth/callback` is a cross-site navigation when Authentik runs on another site; writes stay protected by the header, which a cross-site page cannot set. The endpoints answer `409 setup_complete` once setup is done, whatever cookies are sent.
- **First admin.** The sign-in started from the wizard (`/auth/login?setup=1`) is bound to the setup session that started it; the callback refuses it from any other setup session. It creates the account as admin and marks setup complete in one database transaction, so exactly one account becomes admin this way, even with several backends; the role does not depend on any group. Completion clears the code, deletes every setup session and writes `setup.completed` to the audit log. Installs that already have accounts are marked complete by the migration and never enter setup mode.
- **Server-side requests (SSRF).** The wizard makes the backend send requests to addresses the code holder types (public address, media server, Authentik), and *Admin → Settings* does the same for admins. This is by design: the code holder is the owner of the install. The requests go to `http`/`https` URLs only (the automatic Jellyfin and Authentik steps also refuse user info in the URL), never follow redirects and have short deadlines; only fixed result codes come back, never an upstream body.
- **The setup code is owner-equivalent, including the credentials the environment provides.** During setup, saving and testing in the wizard skip the re-authentication that *Admin → Settings* asks for when a destination changes. A probe can therefore send a secret from `.env` to an address typed in the wizard, for example an environment `JELLYFIN_ADMIN_API_KEY` to a typed `JELLYFIN_URL`, or an environment `AUTHENTIK_API_TOKEN` to a typed `AUTHENTIK_URL` (an address set in the environment cannot be changed). On an install that already has a full `.env` but no accounts, anyone who can read the backend log can use the code to send those secrets anywhere: keep the logs as private as `.env`, and finish setup promptly. After setup, admins cannot do this.
- **One-time credentials.** The Authentik superuser API token and the Jellyfin administrator's password are used for that one request: never stored, logged or put into an error, and the bodies of `/api/setup/*` and `/api/admin/settings*` are kept out of error logs. What is saved instead is a Jellyfin API key named `FriendFlix` (revoked again if saving it fails) and the Authentik service account's token with only the permissions FriendFlix needs. Revoke the superuser token in Authentik afterwards ([authentik.md](authentik.md#3-automatic-setup-from-friendflix)).

## Cryptography

| Purpose | Mechanism | Notes |
|---|---|---|
| Secrets at rest (media-server passwords and tokens, secret settings saved in *Admin → Settings*) | AES-256-GCM, random 12-byte IV, authentication tag; key `APP_ENC_KEY` (must decode to 32 bytes) | `backend/src/crypto.ts` |
| Profile PINs | scrypt, random 16-byte salt, constant-time comparison; limited failed attempts | `hashPin` / `verifyPin` |
| Cast and API tokens | 256-bit CSPRNG (`randomBytes`), base64url; only `sha256(token)` is stored in Redis | `backend/src/cast.ts`, [cast.md](cast.md) |
| Signed cast subtitle URLs | HMAC-SHA-256 with a key derived from `APP_ENC_KEY`, compared in constant time | `backend/src/cast.ts` |
| Audit pseudonym of a deleted account | `deleted-` + 8 hex characters of HMAC-SHA-256 keyed with `APP_ENC_KEY` over the account id | `backend/src/deletion.ts` |
| Shared secrets between services | `INTERNAL_SECRET`, `WEBHOOK_SECRET`, `METRICS_TOKEN`, compared in constant time | `backend/src/routes/internal.ts`, `backend/src/app.ts` |
| Sign-in | OIDC authorization code flow with PKCE (S256), `state`, `nonce` | `backend/src/oidc.ts` |
| Web Push | VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) | `backend/src/push.ts` |

`APP_ENC_KEY` lives in the `bootstrap` volume (or in `.env` / a Docker secret on installs that set it). Back the volume up apart from the database dumps (`scripts/backup-bootstrap.sh`): losing it makes encrypted values unreadable (the app treats them as unset and flags them for re-entry), leaking it together with a database dump exposes them. Docker secrets are supported through [compose.secrets.yaml](../compose.secrets.yaml).

## Hardening

What the shipped [compose.yaml](../compose.yaml) and images do:

- **Containers:** `read_only: true` root file system with a `tmpfs` for `/tmp`, `cap_drop: [ALL]`, `security_opt: no-new-privileges:true` on backend, gateway, web and the backup sidecar; Redis runs read-only as its own user. The app images run as the unprivileged `node` user. The one-shot `bootstrap` service runs as root, but read-only, without network and with `CHOWN` as its only capability ([Settings and generated secrets](#settings-and-generated-secrets)).
- **Images:** base images pinned by digest; `npm`, `npx` and `yarn` are removed from the runtime images; production dependencies only; Alpine security updates applied at build; health checks.
- **Network:** only the three app ports are published, bound to `127.0.0.1`; `db` and `media` networks are `internal`; Redis requires a password and keeps no data on disk.
- **API headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin` (relaxed only for the Chromecast subtitle route) and `Cache-Control: no-store` unless a route sets its own.
- **Web UI headers:** strict Content-Security-Policy from SvelteKit (own origin; the Google Cast sender SDK path is allowed only for casting; trailers load from `youtube-nocookie.com`).
- **HSTS** is set at the reverse proxy ("Force SSL, HTTP/2, HSTS" in [setup.md](setup.md)), not by the app, because the app does not terminate TLS.
- **Rate limits:** a global limit of 600 requests per minute per client, tighter limits on sensitive routes (TV pairing, client error beacon, social endpoints, downloads), failed-token blocking in the gateway and per-account stream and cast-token limits.
- **Request handling:** 256 KiB body limit, schema validation, errors return generic messages (details only in the log).
- **Sessions:** server-side in Redis, sliding idle and absolute expiry, per-session CSRF token, revocation on sign-out-everywhere and account disable.

### TLS recommendation

Terminate TLS at your reverse proxy and allow **TLS 1.2 and 1.3 only**, preferring 1.3. Use ECDHE key exchange with AEAD ciphers (AES-GCM or ChaCha20-Poly1305), disable SSLv3, TLS 1.0 and 1.1, enable HSTS, and use certificates from a public CA (for example Let's Encrypt). FriendFlix does not set these itself; check your proxy configuration against a tool such as the Mozilla SSL configuration generator or SSL Labs.

## Supply chain

Verified from the workflows in [.github/workflows](../.github/workflows):

- **Pinned inputs:** GitHub Actions are pinned to commit SHAs, the Dockerfile base images and the ZAP image to digests; Dependabot proposes updates for npm, Docker and Actions weekly.
- **CI gate:** lint, type check, tests on a Node matrix, `npm audit` for production dependencies (high and above), end-to-end tests, secret scanning with gitleaks.
- **Images:** built once, pushed as a candidate, then scanned by Trivy on that exact digest (SARIF goes to code scanning, a gate step fails the build on findings per its configuration).
- **SBOM and provenance:** BuildKit SPDX SBOM and SLSA provenance (`mode=max`) are attached to each image; GitHub artifact attestations (provenance and SBOM) are published next to it.
- **Signing:** the promoted digest is signed with cosign keyless (GitHub OIDC, Fulcio certificate, Rekor log); there are no long-lived signing keys. Release tags are promotions of the already scanned digest, not rebuilds.
- **DAST:** an OWASP ZAP baseline scan of the built web app fails the pipeline on High alerts; accepted findings are listed in `.zap/rules.tsv`.
- **Scorecard:** the OpenSSF Scorecard workflow publishes supply-chain scores.
- **Static analysis:** ESLint with the rules in `eslint.config.js`, TypeScript strict mode, and CodeQL (GitHub code scanning default setup, JavaScript/TypeScript and Actions queries) on every pull request and push to main; new high-severity alerts block the merge.

To verify an image yourself, check the cosign signature and attestation with the GitHub OIDC identity of this repository's `publish.yml` workflow (for example `cosign verify` with `--certificate-identity-regexp` and `--certificate-oidc-issuer https://token.actions.githubusercontent.com`) or `gh attestation verify`.
