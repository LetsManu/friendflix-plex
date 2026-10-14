# Security model and assurance case

This page describes what FriendFlix promises about security, where the trust boundaries are, who is expected to attack what, and why the design should hold up. It is written for admins deciding whether to run FriendFlix and for reviewers. Where something depends on how you configure your own proxy, identity provider or media server, the text says so. To report a vulnerability see [SECURITY.md](../SECURITY.md).

FriendFlix is maintained by one person. Everything below is what the code, the compose files and the CI pipeline in this repository do; it is not an independent audit.

## Security requirements

**What you can expect**

- Only people with an invitation can get an account, and only a signed-in session can reach media or personal data. Sign-in goes through your OIDC identity provider (the docs use Authentik; multi-factor authentication is configured there).
- The browser never receives a media-server token. It holds a session cookie (`ff_sid`, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS) and plays `/media/...` URLs that only the gateway can resolve.
- Every playlist and segment request is authorised by the backend (session, profile, role limits) before the gateway fetches it from the media server. Hidden titles and kids-profile restrictions are enforced server side.
- Secrets stored by FriendFlix (per-user media-server credentials, admin-saved API keys) are encrypted at rest with a key you control (`APP_ENC_KEY`). Profile PINs are stored as salted scrypt hashes.
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
| Gateway to backend | Media path to authorisation | Shared `INTERNAL_SECRET` header on `/internal/authz`; the answer (user's media token and limits) is cached for 5 s and never stored. |
| Backend and gateway to Postgres and Redis | App to data stores | Only the backend reaches them, over the `db` network which is `internal`. Redis requires a password and persistence is switched off (sessions are not written to disk). |
| Backend and gateway to media server | Admin API key and per-user tokens | Only on the `media` network (internal). The gateway allowlists upstream paths and clamps height and bitrate before forwarding. |
| FriendFlix to identity provider | OIDC discovery and code exchange | Authorization code flow with PKCE (S256), `state` and `nonce`, and a cookie binding the flow to the browser. The IdP is trusted to authenticate users and enforce MFA. |
| Cast and AirPlay receivers | TV or speaker on the viewer's network to the gateway | The receiver cannot send cookies, so it gets a short-lived, revocable cast token in the URL path. See [cast.md](cast.md). A receiver is untrusted: it only ever holds that token. |
| Web Push and notification services | Backend to push services, ntfy, Discord | Outbound only; keys and webhook URLs are admin-configured secrets. |

## Threat model

| Who | Wants | Main defences |
|---|---|---|
| Anonymous internet client | Reach media or the API without an account; find bugs in public endpoints | Everything except health, version, invite redemption and the TV pairing endpoints needs a session; the gateway rejects paths outside its allowlist; global and per-route rate limits; strict response headers. |
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
| Fail-safe defaults | Ports bind to `127.0.0.1` by default; unknown gateway paths are rejected; unauthenticated requests get 401; "Share history" is off by default; the backend refuses to start without required settings; an unreadable encrypted value is treated as unset. | `compose.yaml`, `backend/src/config.ts`, `backend/src/sources/keys.ts` |
| Economy of mechanism | Small set of building blocks: Node `crypto`, Fastify plugins, one media-server interface, one gateway allowlist. No custom cryptography or protocol. | `backend/src/crypto.ts`, [architecture.md](architecture.md) |
| Separation of privilege | Admin API key lives only in the backend; the gateway only knows `INTERNAL_SECRET` and gets user tokens on demand; the web container holds no secret; admin role comes from an IdP group (`ADMIN_GROUP`). | `compose.yaml`, [architecture.md](architecture.md) |
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

## Cryptography

| Purpose | Mechanism | Notes |
|---|---|---|
| Secrets at rest (media-server passwords and tokens, admin-saved API keys) | AES-256-GCM, random 12-byte IV, authentication tag; key `APP_ENC_KEY` (must decode to 32 bytes) | `backend/src/crypto.ts` |
| Profile PINs | scrypt, random 16-byte salt, constant-time comparison; limited failed attempts | `hashPin` / `verifyPin` |
| Cast and API tokens | 256-bit CSPRNG (`randomBytes`), base64url; only `sha256(token)` is stored in Redis | `backend/src/cast.ts`, [cast.md](cast.md) |
| Signed cast subtitle URLs | HMAC-SHA-256 with a key derived from `APP_ENC_KEY`, compared in constant time | `backend/src/cast.ts` |
| Shared secrets between services | `INTERNAL_SECRET`, `WEBHOOK_SECRET`, `METRICS_TOKEN`, compared in constant time | `backend/src/routes/internal.ts`, `backend/src/app.ts` |
| Sign-in | OIDC authorization code flow with PKCE (S256), `state`, `nonce` | `backend/src/oidc.ts` |
| Web Push | VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) | `backend/src/push.ts` |

Keep `APP_ENC_KEY` out of backups of the database: losing it makes encrypted values unreadable (the app treats them as unset), leaking it together with a database dump exposes them. Docker secrets are supported through [compose.secrets.yaml](../compose.secrets.yaml).

## Hardening

What the shipped [compose.yaml](../compose.yaml) and images do:

- **Containers:** `read_only: true` root file system with a `tmpfs` for `/tmp`, `cap_drop: [ALL]`, `security_opt: no-new-privileges:true` on backend, gateway, web and the backup sidecar; Redis runs read-only too. The app images run as the unprivileged `node` user.
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
