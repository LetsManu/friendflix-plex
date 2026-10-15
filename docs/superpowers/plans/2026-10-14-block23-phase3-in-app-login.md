# Block 23 Phase 3 – In-App Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People sign in, recover their password, enrol from an invite and manage their own 2FA in FriendFlix screens, over a cover-wall background. Authentik stays the account store, and its flow executor runs invisibly behind the backend.

**Architecture:**
- The backend acts as the browser towards Authentik's flow executor (`/api/v3/flows/executor/<slug>/`). It keeps a per-attempt cookie jar, encrypted in Redis, and turns every challenge into a small, sanitised FriendFlix step DTO.
- At the end of a login flow it runs a silent OIDC authorize (`prompt=none`) with the jar and reuses the existing callback logic, now extracted into `finishLogin`.
- The web side gets `/login` and `/reset` pages with one Svelte component per step, plus a public, cached cover-wall endpoint fed through the media seam.

**Tech Stack:** Fastify + zod + Redis (kv) + Postgres (backend), openid-client (existing), SvelteKit (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-block23-user-management-design.md`. This plan covers:
- Part C, including the owner decision under "Screens" (cover wall and copy)
- the A5 approval queue, invites and lock/expiry as they apply at login
- the Part B "Security" bullet (per the controller's scope ruling)
- the Part B e-mail change with confirmation of the new address (owner decision 2026-10-14, moved from phase 2 to 3b)

Phase 2 items (data export, deletion grace, the account page itself) are out of scope.

**Split (proposed):** 12 tasks. Execute as two PRs:
- **3a (Tasks 1–9):** in-app login (including passkeys in-app where Authentik honours the forwarded host), recovery, enrolment, cover wall, status checks, docs.
- **3b (Tasks 10–12):** in-app re-authentication, account security, and the e-mail change with confirmation of the new address (moved here from phase 2 by owner decision; phase 2 shows the address read-only).

3b depends on 3a and on phase 2's `requireRecentAuth` (see Task 10).

## Global Constraints

- Passwords, codes and tokens are never logged or stored. `/auth/flow/*` request bodies are excluded from error logs.
- Authentik URLs and tokens are never sent to the client.
- `LOGIN_UI=app|authentik`. The fallback `/auth/login?classic=1` is always reachable.
- Unknown stage → "Continue on the sign-in page".
- Rate limits per IP and per username. `X-Forwarded-For` forwarding is documented.
- CSRF uses double-submit, and flow step ids are single-use.
- 7 locales.
- The word "Seerr" never appears in user-facing text.
- No trademark look-alikes.
- README screenshots use fictional titles and generated art only.
- The media server is reached only through the seam (`ctx.jf`). The Plex fork must keep compiling, so the seam methods are optional.

Carried over from phase 1:
- Migrations are appended to `MIGRATIONS` in `backend/src/db.ts` only. This phase needs none: settings live in `app_settings`, flow state in kv.
- Authentik calls go only through `backend/src/authentik.ts` (admin API) and the new `backend/src/akflow.ts` (flow executor).
- No new dependencies. QR codes use `web/src/lib/qr.ts`.
- Backend tests live in `backend/test/*.test.ts` with `makeEnv`/`resetDb`. e2e tests live in `e2e/tests/login*.spec.ts` (+ `.mobile.spec.ts`), with mocks in `e2e/mocks/login.ts`.
- Coverage thresholds hold. Lint, typecheck and `spdx:check` are clean.
- New web strings go in a new area `login` (`web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/login.ts`, registered in each `index.ts`). German is the source, with the copy from the spec's owner decision. New backend strings (status checks) go in the backend i18n for all 7 languages.

## Authentik Findings (researched 2026-10-14 against `goauthentik/authentik@main`, then verified 2026-10-14 by running `ghcr.io/goauthentik/server:2026.8.3` with the default blueprints)

"Verified by running" below means: exercised against a local 2026.8.3 (server + worker + Postgres) with a Node cookie-jar client, an SMTP sink and a software WebAuthn authenticator. "Source" means the Python source inside that image, so exactly 2026.8.3. The evidence log and scripts are kept outside the repo.

**Executor** (verified by running)
- Source: [flows/views/executor.py](https://github.com/goauthentik/authentik/blob/main/authentik/flows/views/executor.py).
- `GET /api/v3/flows/executor/<slug>/?query=<urlencoded querystring>` returns the current challenge. `POST` to the same URL with a JSON body answers it. The view is `AllowAny`.
- The plan lives in the Django session, under the cookie `authentik_session` (`root/settings.py`). A login also sets `authentik_csrf`, `authentik_device` and `authentik_user_switching`; the jar keeps every cookie it gets.
- After a valid answer, `stage_ok` redirects to the executor URL itself. `to_stage_response` returns that as a real **302 to the same path**, not as a challenge. The client must follow it with a `GET` that carries the jar (`redirect: 'manual'`). Observed: up to 2 hops (POST → 302 → GET → 302 → GET → 200). An invalid answer comes back as 200 directly.
- The `component` key in an answer is optional (answers without it were accepted).
- Other redirects become `{component: 'xak-flow-redirect', to, final_redirect}`. `final_redirect: true` marks the end of the flow (U6).
- `pending_user_avatar` is a `data:` URI with the default avatar setting (it is dropped either way).

**Challenge shapes** ([flows/challenge.py](https://github.com/goauthentik/authentik/blob/main/authentik/flows/challenge.py))
- Every challenge has `component`, an optional `flow_info {title, background, cancel_url, layout, messages}` and an optional `response_errors {field: [{string, code}]}`.
- `WithUserInfoChallenge` adds `pending_user` and `pending_user_avatar` (a URL, which is dropped).
- Other components: `ak-stage-access-denied {error_message}`, `xak-flow-shell {body}` (HTML) and `ak-stage-flow-error`.

**Stage by stage**

| Component | Challenge fields | Answer | Source |
|---|---|---|---|
| `ak-stage-identification` | `user_fields`, `password_fields` (password inline), `enroll_url?`, `recovery_url?`, `passwordless_url?`, `captcha_stage?`, `passkey_challenge?`, `primary_action`, `allow_show_password` | `{uid_field, password?, captcha_token?, passkey?}` | [identification/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/identification/stage.py) |
| `ak-stage-password` | `recovery_url?`, `allow_show_password` | `{password}` | [password/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/password/stage.py) |
| `ak-stage-authenticator-validate` | `device_challenges[{device_class: totp\|static\|webauthn\|duo\|sms\|email, device_uid, challenge, last_used}]`, `configuration_stages[{pk, name, verbose_name, meta_model_name}]` | `{code?, webauthn?, selected_challenge?, selected_stage?}` | [validate/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_validate/stage.py), [challenge.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_validate/challenge.py) |
| `ak-stage-authenticator-totp` | `config_url` (an `otpauth://` URI) | `{code}` | [totp/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_totp/stage.py) |
| `ak-stage-authenticator-static` | `codes[]` | `{}` (confirms) | [static/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_static/stage.py) |
| `ak-stage-email` | no fields (`title` "Email sent.") | Any POST is "invalid" by design and **re-sends** the mail. Rate limited per address (`recovery_max_attempts`). | [email/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/email/stage.py) |
| `ak-stage-prompt` | `fields[{field_key, label, type, required, placeholder, initial_value, order, sub_text, choices}]` | `{<field_key>: value}` | [prompt/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/prompt/stage.py) |
| `ak-stage-authenticator-webauthn` | `registration` (PublicKeyCredentialCreationOptions JSON: `rp {id, name}`, `user`, `challenge`, …) | `{response: <RegistrationResponseJSON>}` | [webauthn/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_webauthn/stage.py) |
| `ak-stage-consent` (e-mail link interstitial, see below) | `header_text` "Continue to confirm this email address.", `token` (uuid), `permissions: []` | `{token}` | [email/flow.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/email/flow.py) |

Notes on the table (all verified by running unless marked "source"):
- **Identification:** for an unknown user (when "pretend" is off), validation fails with "Failed to authenticate.". With `webauthn_stage` set on the identification stage, the challenge carries `passkey_challenge` (PublicKeyCredentialRequestOptions JSON with `rpId`), answered with `{passkey: <AuthenticationResponseJSON>}`; this signs in without password and MFA.
- **Codes:** a TOTP code and a recovery (static) code are both checked from the same `code` field (`validate_challenge_code` tries every TOTP and static device). A TOTP code that was already used (for example the one typed at setup) is rejected again within its 30 s window.
- **Error shapes:** wrong password → `response_errors.password[{code:'invalid'}]`; wrong code → `response_errors.code[{code:'invalid'}]`; password mismatch in a prompt → `response_errors.non_field_errors[{string:"Passwords don't match.", code:'invalid'}]` (the string is localised, so FriendFlix checks the mismatch itself, see Task 2); a POST on the e-mail stage re-sends and answers `non_field_errors[{code:'email-sent'}]`, which is **not** a failure.
- **Recovery link:** the e-mail's template context is `url`, `user`, `expires` and **`token`** (the FlowToken key, 60 characters). A link that returns to the flow is `GET /api/v3/flows/executor/<recovery-slug>/?query=flow_token%3D<token>`, which restores the pickled plan (`QS_KEY_TOKEN = "flow_token"`).
- **E-mail link interstitial (new, not on the original list):** since the anti-link-scanner change, every e-mail-stage token plan starts with an in-memory `EmailTokenRevocationConsentStageView`. Opening the link returns `ak-stage-consent` with `header_text` "Continue to confirm this email address." and a `token`. Only answering `{token}` deletes the FlowToken and continues the plan. A token that was already used starts a new plan (identification), or "access denied" for a flow that needs authentication.
- **Custom templates** are read from `/templates` (`email.template_dir`). The 2026.8.3 image does **not** create that directory, so it must be mounted ([email stage docs](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/email/)). The example recovery blueprint binds identification (10), e-mail (20), the password prompt (30), user write (40) and user login (100) ([flows-recovery-email-verification.yaml](https://github.com/goauthentik/authentik/blob/main/blueprints/example/flows-recovery-email-verification.yaml)). 2026.8.3 also ships `flows-recovery-email-mfa-verification.yaml`, which adds an authenticator-validate stage at order 21 after the e-mail stage; the `mfa` screen handles it.
- **Unknown identifier in recovery:** the flow still answers `ak-stage-email` (no disclosure); no mail is sent.
- **E-mail recipient (source):** the e-mail stage sends to the plan context key `email` when set, otherwise to `pending_user.email`, and fails with "No pending user" (→ access denied "Unknown error") when the plan has no `pending_user`, which is the case for a logged-in `stage_configuration` flow. See "E-mail change" below.
- **Invitation token:** it travels as `itoken` in `query` ([invitation/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/invitation/stage.py)) (source only, not run).
- **Flow bindings API:** `flows/bindings/?target=<pk>` gives `stage_obj.component` as the admin **form** name (`ak-stage-email-form`), not the challenge component. Checks must use `stage_obj.meta_model_name` (`authentik_stages_email.emailstage`, …).

**Silent OIDC authorize** (verified by running; [providers/oauth2/views/authorize.py](https://github.com/goauthentik/authentik/blob/main/authentik/providers/oauth2/views/authorize.py), [flows/planner.py](https://github.com/goauthentik/authentik/blob/main/authentik/flows/planner.py) `to_redirect`)
- With a logged-in session, the authorize endpoint plans the provider's authorization flow and appends `OAuthFulfillmentStage`.
- If no other stage is left (implicit consent), it answers **302 directly to `redirect_uri?code=…&state=…`** (`prompt=none`, PKCE S256). The code exchanged normally; the ID token carried `amr: ['pwd','mfa']` and `auth_time`.
- With an explicit-consent authorization flow, `prompt=none` does **not** return `consent_required`: it answers **302 to `/if/flow/<authorization-flow>/?…`** (Task 4 maps that to `classic/consent`).
- `prompt=none` without a session gives `error=login_required`.
- **New in 2026.8:** OAuth2 providers have `grant_types`. Providers migrated from older releases get all grant types (migration `0032`), but a provider created through the API on 2026.8 defaults to `[]`, and then every authorize fails with `invalid_request` ("Invalid grant_type for provider"). The status check (Task 9) requires `authorization_code`.
- A jar whose flow ran with `X-Forwarded-Host` (passkeys, below) still works for authorize sent without it; the session is not host-bound.

**WebAuthn** ([authenticator_webauthn/utils.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_webauthn/utils.py); source and verified by running)
- `get_rp_id(request)` is `request.get_host()` without the port, and `get_origin(request)` is `request.build_absolute_uri("/")` without the trailing slash. Registration (`authenticator_webauthn/stage.py`), the validate stage and the identification passkey all use them. The stage has no RP ID or origin setting. py_webauthn 3.0.0 would accept a list of origins, but Authentik always passes one string.
- `settings.py` does not set `USE_X_FORWARDED_HOST`, but Authentik's Rust front server rewrites the Host from `X-Forwarded-Host` (and the scheme from `X-Forwarded-Proto`) **for requests from `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS`** (default: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, …). Measured: a setup challenge has `rp.id = 127.0.0.1` without the header and `rp.id = friend.example.com` with `X-Forwarded-Host: friend.example.com`. With the caller outside the trusted CIDRs, the header is ignored.
- So the FriendFlix backend, as a trusted proxy, can make Authentik compute RP ID = app host and expected origin = `https://<app host>`. With a software authenticator using origin `https://friend.example.com`, these all passed: in-app registration, password plus passkey as second factor, and passwordless passkey on identification. A wrong origin was rejected. The same credential is not offered on Authentik's own host (different RP ID). See Ruling 1.
- Brand resolution also follows the forwarded host (`brands/utils.py`, exact or suffix match on the brand domain).
- Anonymous probe: `GET <OIDC_ISSUER>.well-known/openid-configuration` with `X-Forwarded-Host/Proto` returns `issuer` on the forwarded host exactly when Authentik trusts the caller. Task 9 uses this probe.

**CSRF** (U1, verified by running)
- Settings: cookie `authentik_csrf`, header `X-authentik-CSRF`. The DRF authentication classes are `TokenAuthentication` and `SessionAuthentication`.
- Anonymous login, recovery and enrolment POSTs need no CSRF header (DRF enforces CSRF only for session-authenticated users).
- POSTs in a flow run as a logged-in user (setup flows and e-mail change, Task 10) need `X-authentik-CSRF` equal to the jar's `authentik_csrf` cookie. When the request counts as HTTPS (a real TLS origin, or `X-Forwarded-Proto: https` from a trusted proxy), they also need `Origin` **or** `Referer` matching `<scheme>://<effective host>`, where the effective host is the `X-Forwarded-Host` value when one is sent. On plain HTTP the header alone is enough.
- A CSRF failure is **HTTP 500 with an HTML body** (`PermissionDenied: CSRF Failed: …`), not 403. `akExec` maps it to `502 authentik_error` like any other non-JSON answer.

**Client IP:** Authentik trusts `X-Forwarded-For` (and `-Host`/`-Proto`) only from `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS`. The docs describe adding the FriendFlix backend there. The backend should reach Authentik directly (internal URL), because a reverse proxy in between usually overwrites `X-Forwarded-Host`.

**Admin device API** (U2, verified by running): `GET authenticators/admin/all/?user=<pk>` lists devices (string `pk`, `meta_model_name`, `name`, `last_used`). `DELETE authenticators/admin/{totp,static,webauthn}/<pk>/` with the API token → 204; without a token → 403. `providers/oauth2/` filters by `client_id`.

**Verified assumptions** (formerly "Unverified"; the tests still use recorded fixtures, now recorded from 2026.8.3):
- **U1 – CSRF for logged-in flow POSTs:** confirmed with the details above. Header always; plus `Origin` (or `Referer`) when the request counts as HTTPS; the origin must use the forwarded host when one is sent. Anonymous flows need nothing. Failure is a 500 HTML. *Verified by running.*
- **U2 – device DELETE with the API token:** works (204) for `totp`, `static` and `webauthn`. *Verified by running.*
- **U3 – ending the session through the invalidation flow:** `GET /api/v3/flows/executor/default-invalidation-flow/` with the jar answers `xak-flow-redirect {to:'/', final_redirect:true}` and deletes `authentik_session`. Afterwards `core/users/me/` is 403 and `prompt=none` gives `login_required`. *Verified by running.*
- **U4 – static setup run twice:** it creates a **second** static device (6 new codes), and the codes of the first device **stay valid**. Task 10 therefore deletes the old static devices itself, after the new codes are confirmed. *Verified by running.*
- **U5 – Jellyfin `OfficialRatings`:** pipe-delimited (`PipeDelimitedCollectionModelBinder`), an exact and case-sensitive match on the stored string: `FSK 12`, `FSK-12` and `fsk-12` are three different values, and a comma-separated list matches nothing. An API key without `userId` queries all libraries. `maxOfficialRating` is unusable as a safety filter: even with `hasParentalRating=true` it still returned unrated items. *Verified by running Jellyfin 10.11.11, and from source at `v10.11.11` (`ItemsController.GetItems`, `BaseItemRepository`).*
- **U6 – end signal on 2026.8.x:** `xak-flow-redirect` with `final_redirect: true` arrives at the end of the authentication, setup, recovery and invalidation flows on 2026.8.3. The extra rule (a redirect to `/` or `/if/user/` also ends) stays, for older releases. *Verified by running.*

**E-mail change** (owner decision, see Ruling 10; verified by running, as a blueprint as well)
- The flow (`designation: stage_configuration`, `authentication: require_authenticated`) is: prompt stage with one `email` field (10) → e-mail stage (20) → user write (`user_creation_mode: never_create`) (30).
- The e-mail stage binding has `evaluate_on_plan: false`, `re_evaluate_policies: true` and an expression policy. Re-evaluated policies get `flow_plan` and the plan context (`flows/markers.py`). The policy is:
  ```python
  plan = context["flow_plan"]
  plan.context["pending_user"] = request.user
  plan.context["email"] = context["prompt_data"]["email"]
  return True
  ```
- Observed: the mail goes **only to the new address**; the user's e-mail is unchanged until the link is used. The link, opened in a fresh jar without any session, gives the consent interstitial; after `{token}` the flow ends with `final_redirect` and the address is changed. The link opener gets no Authentik session, and a second use is "access denied".
- Authentik does not enforce unique e-mail addresses. FriendFlix checks that itself (Task 10).

## Rulings Against the Spec

1. **Passkeys in-app are built, through a forwarded app host, with the classic page as fallback** (revised after verification; this replaces "not built"). The spec's "RP ID is a parent domain" condition cannot be met: Authentik's RP ID is always exactly the request host. But the request host is the **forwarded** host when the caller is a trusted proxy, and Authentik derives both the RP ID and the expected origin from it (Findings → WebAuthn). So:
   - **Mechanism:** for the jar kinds that can meet WebAuthn (`login`, `reauth`, `setup-webauthn`), `akExec` sends `X-Forwarded-Host: <PUBLIC_URL host>` and `X-Forwarded-Proto: https`, plus `Origin: <PUBLIC_URL origin>` (with the CSRF header on logged-in jars). Authentik then issues challenges for RP ID `<app host>` and checks the origin `https://<app host>`. The browser runs `navigator.credentials.get/create` on the FriendFlix page with those options, and the backend forwards the credential JSON unchanged. Verified by running: registration, passkey as second factor, and passwordless passkey on identification.
   - **Not for recovery and enrolment jars:** a forwarded host would also change the brand lookup and the `url` in Authentik's default mail templates.
   - **Guard per challenge:** a WebAuthn challenge whose `rpId` / `rp.id` is not the PUBLIC_URL host means that Authentik ignored the forwarded host (FriendFlix is not a trusted proxy, or a proxy rewrote the header). It maps to the classic link, never to a broken ceremony.
   - **Preconditions** (all checked by the status check, Task 9):
     - PUBLIC_URL is `https://` (WebAuthn needs a secure context; `localhost` is fine in development)
     - the backend's address is in `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS`
     - the backend reaches Authentik without a header-rewriting proxy in between
     - `PASSKEYS_IN_APP` is not `off` (env, `auto` by default). With `auto`, the cached probe result decides; `off` always uses the classic page.
   - **Trade-off, documented in docs/authentik.md:** a passkey belongs to one RP ID. Passkeys created in FriendFlix (RP ID = app host) do not work on Authentik's own pages or in other apps behind Authentik. Passkeys created on Authentik's pages (RP ID = Authentik host) do not work in FriendFlix. FriendFlix screens therefore always keep "Auf der Anmeldeseite mit Passkey anmelden" as a secondary link, and a browser `NotAllowedError` shows that link.
   - **Options rejected:**
     - WebAuthn Related Origin Requests (`/.well-known/webauthn`) would need RP ID = Authentik host with origin = app host. Authentik derives both from the same host and passes py_webauthn one origin string, so this cannot work without patching Authentik.
     - An iframe of Authentik's page is not used: cross-origin WebAuthn needs `allow="publickey-credentials-*"`, and Authentik's framing headers are not under our control.
     - A popup on the Authentik host does work without anything special (it is the classic page). It stays the fallback, not the default, because it leaves the app.
   - **Unchanged:**
     - Removing a passkey stays in-app, through the admin device API.
     - When passkeys in-app are unavailable, "Mit Passkey anmelden", "Passkey verwenden" and "Add a passkey" go to the classic page (`/auth/login?classic=1`, or `/auth/flow/classic/webauthn-setup` for setup).
     - Re-authentication by passkey uses the in-app ceremony when it is available, and otherwise phase 2's OIDC redirect (`prompt=login`).
   - **Status:** the status check reports `passkeys: 'in-app' | 'sign-in page'`, with the reason.
2. **`ak-stage-authenticator-totp` passes the `otpauth://` URI to the client.** It is the user's own new secret, not an Authentik URL or API token, and the QR code is drawn from it. It is never logged, and it is dropped from kv once the step completes. The recovery codes from `ak-stage-authenticator-static` are shown once on the same terms. **The WebAuthn options** (challenge, `rp`, `user {id, name, displayName}`, `allowCredentials`) are passed to the client on the same terms: the browser API needs them, and they contain no Authentik URL or token.
3. **Recovery does not sign in.** Verified: the example recovery flow ends in `user_login` and does create an Authentik session (also with the MFA variant, whose second factor comes after the mail). FriendFlix ends the jar's Authentik session, deletes the jar and shows "Password changed – sign in". Otherwise a mail account alone would bypass FriendFlix's own login checks (approval, lock/expiry) and, with the plain example flow, 2FA.
4. **`?resetPin=1` stays on the classic redirect.** It needs IdP `auth_time` (`max_age=0`), which the flow does not give. `/auth/login?invite=` and `/auth/enroll` lead to `/login?invite=` in app mode.
5. **E-mail-sent screen:** the mockup's "E-Mail-App öffnen" button is dropped, because there is no reliable cross-platform target. The address is the identifier the person typed, masked (`a•••@example.com`), and is omitted when it was a username. The link lifetime is not shown, because Authentik does not report it.
6. **Cover-wall safe set** (owner decision 2026-10-14: age limit up to FSK 12 and equivalents, titles from **all** libraries; controller ruling: unrated stays excluded):
   - Libraries: **all** libraries of the media server. The query has no `ParentId`; with the admin API key and no `userId`, Jellyfin searches every library (verified). The guest role's library list is no longer used.
   - Ratings: `OfficialRating ∈ LOGIN_ART_RATINGS`, an exact and case-sensitive allow-list (U5). It covers the spellings Jellyfin stores (its 10.11 rating tables plus country-prefixed metadata values):
     ```
     DE/AT/CH  'FSK 0','FSK-0','FSK 6','FSK-6','FSK 12','FSK-12','DE-0','DE-6','DE-12','0','6','12'
     US        'G','PG','TV-Y','TV-Y7','TV-Y7-FV','TV-G','TV-PG'
     GB        'U','PG','12A','GB-U','GB-PG','GB-12','GB-12A'
     ```
     Excluded on purpose:
     - `PG-13` and `TV-14` (13 and 14 are above 12)
     - anything unrated or empty
     - unknown strings such as `NR`, `Unrated` or `Approved`
     - any spelling not in the list, which fails safe
   - The filter is the allow-list only. `maxOfficialRating` is **not** used: it lets unrated items through (U5).
   - Types: Movie and Series only, with a primary image.
   - Kids and restricted libraries need no special rule any more: what counts is the item's own rating. Items from restricted libraries show only when they are rated ≤ 12, and only as a cover without a title.
   - This is documented in docs/security.md (all libraries, the allow-list, unrated excluded, no titles or ids).
7. **Access-until reached but not yet locked by the tick:** `finishLogin` locks it right away (`lockUser(...,'expired')`) and refuses the login. This applies to both login paths.
8. **Re-auth stamp** (controller ruling): the session field is `reauthAt` (epoch ms; phase 2 calls it `reauth_at`, and the merge must use one name). The guard is `requireRecentAuth(ctx, 10 * 60_000)`.
9. **Brute force:** one per-username limit for every flow kind, counted on failed answers only. The e-mail stage's `email-sent` "error" (a resend) is not a failure and is not counted.
10. **E-mail change (owner decision, moved from phase 2 into 3b):**
    - "Change e-mail with confirmation of the new address" runs in FriendFlix screens under `/me` → Account, behind `requireRecentAuth(10 min)`, through the Authentik flow `friendflix-email-change`.
    - The flow is shipped as a blueprint plus a mail template, like the recovery template. Its prompt asks for the new address, the e-mail stage mails a link to the **new** address, and user write applies it only after the link is used (Findings → E-mail change).
    - The link leads to `https://<app>/confirm-email?token=…`. FriendFlix continues the flow there, then copies the new address from Authentik into `users.email`.
    - Audit `account.email` with `{ fields: ['email'] }` only, never the addresses. 7 locales.
11. **E-mail links need a click in FriendFlix:** `/reset?token=` and `/confirm-email?token=` do not call Authentik on page load. They show one button ("Weiter" / "Adresse bestätigen"), and only that click resumes the flow and answers Authentik's link interstitial. This keeps Authentik's protection against mail scanners that open links (a scanner that loads the page does not use up the token).

## Review Focus

1. A person whose `access_until` passed minutes ago (the tick has not run yet) signs in in-app: refused as locked, the account is now locked, and there is no session. (Test in Task 4.)
2. The same flow step is submitted twice (double click, or a replay of a captured request): the second gets `409 step_used`, and Authentik sees exactly one POST. (Test in Task 3.)
3. A custom Authentik flow with a captcha or an SMS/Duo stage: the screen says "Continue on the sign-in page", and the link works without losing the invite. (Test in Task 2, and e2e in Task 7.)
4. The flow sits idle for more than 10 minutes and is then answered: "Session expired, start again". No Authentik call is made with a stale jar. (Test in Task 3.)
5. Authentik is down while the login page loads: the cover wall still renders, and the card shows "Sign-in service unavailable" with retry and the classic link. (Test in Task 3, and e2e in Task 7.)
6. Authentik does not honour the forwarded host (FriendFlix outside the trusted CIDRs): a WebAuthn challenge with the wrong `rpId` becomes the classic link, the status check says `passkeys: 'sign-in page'` with the reason, and no recovery or enrolment jar ever sends `X-Forwarded-Host`. (Tests in Tasks 1, 2 and 9.)
7. An e-mail-change link opened by a mail scanner (page load only, no click) leaves the token usable. The change applies only after the click, mail goes only to the new address, and the audit has no address in it. (Tests in Tasks 10 and 11.)

---

## Part 3a – In-app login (PR 1)

### Task 1: Config and flow executor client

**Files:**
- Modify: `backend/src/config.ts`
- Create: `backend/src/akflow.ts`
- Test: `backend/test/akflow.test.ts`
- Create: `backend/test/fixtures/akflow/*.json` (challenge shapes per the Findings table, recorded from Authentik 2026.8.3 with fictional users and `example.com` hosts only; never a real owner domain or token)
- Create: `backend/test/akflow-fake.ts` (a fake Authentik: `Response`s with `set-cookie`, 302 to self, a stateful stage list)

**Interfaces (produces):**
- Config, all `opt`:
  - `LOGIN_UI` (`z.enum(['app','authentik']).optional()`)
  - `AUTHENTIK_LOGIN_FLOW` (default `default-authentication-flow`)
  - `AUTHENTIK_TOTP_SETUP_FLOW` (exists; default `default-authenticator-totp-setup`)
  - `AUTHENTIK_STATIC_SETUP_FLOW` (default `default-authenticator-static-setup`)
  - `AUTHENTIK_WEBAUTHN_SETUP_FLOW` (default `default-authenticator-webauthn-setup`)
  - `AUTHENTIK_PASSWORD_CHANGE_FLOW` (default `default-password-change`)
  - `AUTHENTIK_INVALIDATION_FLOW` (default `default-invalidation-flow`)
  - `AUTHENTIK_EMAIL_CHANGE_FLOW` (default `friendflix-email-change`, the shipped blueprint; Task 10)
  - `AUTHENTIK_RECOVERY_FLOW` and `AUTHENTIK_ENROLL_FLOW` already exist
  - `PASSKEYS_IN_APP` (`z.enum(['auto','off'])`, default `auto`; Ruling 1)
  - `loginUi(cfg): 'app' | 'authentik'`: `cfg.LOGIN_UI ?? (AUTHENTIK_URL && AUTHENTIK_API_TOKEN ? 'app' : 'authentik')`
  - `flowSlug(cfg, kind: FlowKind): string | undefined` (`email-confirm` → the e-mail-change slug, `recovery-resume` → the recovery slug)
- `type FlowKind = 'login' | 'recovery' | 'recovery-resume' | 'enroll' | 'reauth' | 'setup-totp' | 'setup-static' | 'setup-webauthn' | 'change-password' | 'change-email' | 'email-confirm'`
- `const FORWARD_HOST_KINDS: FlowKind[] = ['login', 'reauth', 'setup-webauthn']`: the kinds that may meet WebAuthn (Ruling 1). Recovery, enrolment and every e-mail flow never forward the host.
- `interface Jar { cookies: Record<string, string>; slug: string; query: string; kind: FlowKind; createdAt: number; step: string; identifier?: string; invite?: string; userId?: string; then?: FlowKind; forwardHost: boolean }`. `forwardHost` = `FORWARD_HOST_KINDS.includes(kind) && passkeysInApp(ctx)`, fixed when the jar is created. It is inherited when a `reauth` jar continues with `then` (and set for `setup-webauthn`).
- `passkeysInApp(ctx): Promise<boolean>`: `PASSKEYS_IN_APP !== 'off'`, PUBLIC_URL is `https:` (or the host is `localhost`), and the cached probe `forwardedHostHonoured` from Task 9 is true. The probe is cached 10 min in kv; when it is missing it is run once, with a 3 s timeout, and counts as false on error.
- `saveJar(ctx, flowId, jar): Promise<void>`: `encrypt(ctx.encKey, JSON)` under kv `akflow:<sha256(flowId)>`, TTL 600. The TTL is **not** extended (a 10-minute absolute limit from `createdAt`).
- `loadJar(ctx, flowId): Promise<Jar | null>` and `dropJar(ctx, flowId)`.
- `akExec(ctx, jar, method: 'GET' | 'POST', body?: object, clientIp?: string): Promise<{ challenge: RawChallenge; jar: Jar }>`:
  - URL: `<AUTHENTIK_URL>/api/v3/flows/executor/<slug>/?query=<encodeURIComponent(jar.query)>`.
  - Headers: `accept: application/json`, `x-forwarded-for: clientIp`, and `cookie` from the jar.
  - When `jar.forwardHost`: `x-forwarded-host: <PUBLIC_URL host>`, `x-forwarded-proto: https`, and `origin: <PUBLIC_URL origin>` on every executor call (GET and POST).
  - When the jar has `authentik_csrf` (a logged-in jar; U1, verified): `x-authentik-csrf: <cookie>` on POSTs. The `origin` must then be the **effective** origin: `<PUBLIC_URL origin>` when `forwardHost`, else `<AUTHENTIK_URL origin>`. Add `referer: <effective origin><executor path>` as well; either one suffices, and sending both is harmless.
  - `redirect: 'manual'`, with a 302 to the same path followed by a GET (at most 5 hops; 2 were observed). `getSetCookie()` merges into the jar; `Max-Age=0`, an empty value or an expired `Expires` deletes the cookie (the invalidation flow clears `authentik_session` that way).
  - Timeout 8 s. A network error gives `HttpError(503,'authentik_unavailable')`. A non-JSON or 5xx answer gives `HttpError(502,'authentik_error')`; this includes Authentik's CSRF failure, which is a 500 with an HTML body. No response body or URL is ever put into an error.
- `akGet(ctx, jar, absoluteOrRelativeUrl): Promise<Response>`: one jar-carrying GET with `redirect: 'manual'`, used for authorize and invalidation. It **never** sends `x-forwarded-host` or `-proto`; authorize must see Authentik's real host, so that the issuer matches.

- [ ] **Step 1: Write the failing tests** (`akflow.test.ts`):
  - `exec GET sends the query double-encoded and stores set-cookie in the jar`: `calls[0].search === '?query=next%3D%252F'` for `jar.query='next=%2F'`, and `jar.cookies.authentik_session === 's1'`.
  - `POST follows the 302 to self with a GET carrying the new cookie`: two calls, `POST` then `GET`, and the returned `challenge.component === 'ak-stage-password'`.
  - `jar round-trips encrypted and the kv value contains no cookie value`: `!(await kv.get(key)).includes('s1')`.
  - `jar older than 600 s is null` (fake clock via `createdAt`).
  - `network error -> 503 authentik_unavailable, message has no URL`.
  - `x-forwarded-for carries the client ip`.
  - `csrf header is sent only when the jar has authentik_csrf`.
  - `logged-in jar without forwardHost sends origin = AUTHENTIK_URL origin; with forwardHost sends origin = PUBLIC_URL origin and x-forwarded-host/proto`.
  - `recovery and enroll jars never send x-forwarded-host, even when passkeys are in-app` (Review Focus 6).
  - `akGet never sends x-forwarded-host`.
  - `a 500 text/html answer (Authentik CSRF failure) -> 502 authentik_error`.
  - `302 -> 302 -> 200 chain is followed with the jar` (2 hops, as recorded).
  - `set-cookie with an empty value deletes the cookie`.
- [ ] **Step 2: Run `npm test -w backend -- akflow` and confirm it fails.**
- [ ] **Step 3: Implement the config keys and `akflow.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm run typecheck -w backend`.
- [ ] **Step 5: Commit** `feat(auth): Authentik flow executor client with encrypted cookie jar`.

### Task 2: Challenge sanitiser (step DTOs)

**Files:**
- Create: `backend/src/flowSteps.ts`
- Test: `backend/test/flow-steps.test.ts`

**Interfaces (produces):**
```ts
type FlowError = 'invalid' | 'code_invalid' | 'password_mismatch' | 'required' | 'rate_limited' | 'email_in_use';
type PasskeyGet = { challenge: string; rpId: string; allowCredentials: Array<{ id: string; type: 'public-key'; transports?: string[] }>; userVerification?: string; timeout?: number };
type PasskeyCreate = { challenge: string; rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; pubKeyCredParams: unknown[]; excludeCredentials?: unknown[]; authenticatorSelection?: unknown; attestation?: string; timeout?: number };
type FlowStep =
  | { stage: 'identify'; step: string; passwordInline: boolean; canRecover: boolean; canEnroll: boolean; passkey: PasskeyGet | null }
  | { stage: 'password'; step: string; identity: string; canRecover: boolean }
  | { stage: 'mfa'; step: string; totp: boolean; recovery: boolean; passkey: PasskeyGet | null; passkeyClassic: boolean }
  | { stage: 'passkey-setup'; step: string; options: PasskeyCreate }
  | { stage: 'email-sent'; step: string; to: string | null }
  | { stage: 'prompt'; step: string; fields: Array<{ key: string; type: 'text' | 'username' | 'email' | 'password'; label: string; required: boolean }> }
  | { stage: 'totp-setup'; step: string; otpauth: string }
  | { stage: 'recovery-codes'; step: string; codes: string[] }
  | { stage: 'denied' }
  | { stage: 'classic'; reason: 'unsupported_stage' | 'external_redirect' | 'consent' | 'passkey_origin' }
  | { stage: 'expired' } | { stage: 'unavailable' }
  | { stage: 'locked' }
  | { stage: 'done'; next: string };
toStep(raw: RawChallenge, jar: Jar, step: string, appHost: string): FlowStep | { internal: 'end' } | { internal: 'select-stage'; pk: string } | { internal: 'link-confirm'; token: string }
toAnswer(step: FlowStep['stage'], body: unknown, raw: RawChallenge): object   // zod-validated per stage; throws HttpError(400,'bad_request')
stepErrors(raw: RawChallenge): FlowError[]   // from response_errors codes; unknown → 'invalid'; 'email-sent' → [] (not an error)
maskEmail(identifier: string): string | null  // 'anna@example.com' → 'a•••@example.com'; no '@' → null
```

Mapping rules (`webauthnOk(rpId) = jar.forwardHost && rpId === appHost`, Ruling 1):
- **Identification:**
  - `captcha_stage` set → `classic/unsupported_stage`.
  - `passkey` = `passkey_challenge` when `webauthnOk(passkey_challenge.rpId)`, else `null`. The web shows "Mit Passkey anmelden" in-app when it is set, else as the classic link.
- **Authenticator validate:**
  - `totp` = a device class `totp` is present; `recovery` = `static` is present.
  - `passkey` = the `webauthn` entry's `challenge` when it is present and `webauthnOk(challenge.rpId)`; `passkeyClassic` = a `webauthn` entry is present but `passkey` is null.
  - Only `sms`, `duo` or `email` (and no usable TOTP, static or in-app passkey) → classic. Only `webauthn` with `passkey === null` → `classic/passkey_origin`.
  - Empty `device_challenges` with a TOTP entry in `configuration_stages` (`meta_model_name === 'authentik_stages_authenticator_totp.authenticatortotpstage'`) → `{internal:'select-stage', pk}`. Otherwise classic. (2026.8.3 sends `configuration_stages: []` when devices exist.)
- **`ak-stage-authenticator-webauthn`:** `passkey-setup` with `options = registration` when `webauthnOk(registration.rp.id)`, else `classic/passkey_origin`. `rp.name` (Authentik's brand title, "authentik" by default) is replaced by `'FriendFlix'`. The RP name is shown to the user only and is not part of the signed data.
- **Prompt:**
  - Only the field types `text`, `username`, `email`, `password` and the hidden types `static`/`separator` (both skipped) are shown; any other type → classic.
  - Labels come through as Authentik text. `password`/`password_repeat` fields get FriendFlix labels by `field_key`, and so does `email` in the `change-email` kind.
- **`xak-flow-redirect`:** `final_redirect === true`, or `to` equal to `/`, `/if/user/` or a path starting with `/application/o/authorize` → `{internal:'end'}`. Any other external `to` → `classic/external_redirect`.
- **Other components:**
  - `ak-stage-access-denied` → `denied`
  - `ak-stage-consent`:
    - It becomes `{internal:'link-confirm', token}` only when **all** of these hold: the jar kind is `recovery-resume` or `email-confirm`, `jar.query` starts with `flow_token=`, the challenge has `permissions: []` and `additional_permissions: []`, and it is the first challenge of the jar. That is Authentik's e-mail link interstitial (Findings).
    - Otherwise → `classic/consent`.
  - `ak-stage-email` → `email-sent` (`to` = `maskEmail(jar.identifier)`, or for `change-email` the masked new address)
  - anything else → `classic/unsupported_stage`
- **Errors:** `stepErrors` ignores the code `email-sent` (a resend). Password mismatch is caught before Authentik is called (see the prompt answer), because Authentik's own mismatch error is a localised `non_field_errors` string with code `invalid`.
- **Answers:**
  - `mfa`, either `{ code: /^\d{6}$/ | /^[A-Za-z0-9]{8,32}$/ }` → `{ code }`, or `{ webauthn: Credential }` → `{ webauthn }`
  - `identify`, either `{ identifier: 1..254, password?: 1..1024 }` → `{ uid_field, password? }`, or `{ passkey: Credential }` → `{ passkey }`
  - `passkey-setup`: `{ response: Credential }` → `{ response }`
  - `Credential` (zod, strict) is `{ id, rawId: base64url ≤ 1024; type: 'public-key'; response: { clientDataJSON, authenticatorData?, signature?, userHandle?, attestationObject?, transports? } (each base64url ≤ 16 KiB); clientExtensionResults?: {}; authenticatorAttachment?: string }`. It is passed through unchanged.
  - `prompt`: when both `password` and `password_repeat` are present and differ → `HttpError(400)` with `{ errors: ['password_mismatch'] }`, without calling Authentik.
  - `recovery-codes` and `email-sent` (resend) → `{}`

- [ ] **Step 1: Write the failing tests**, one per fixture:
  - `identification maps without urls`
  - `password keeps the typed identifier as identity, not pending_user_avatar`
  - `validate with totp+static+webauthn, forwardHost and rpId = app host → mfa {totp, recovery, passkey: options, passkeyClassic: false}`
  - `validate with webauthn whose rpId is Authentik's host → passkey null, passkeyClassic true` (Review Focus 6)
  - `validate with only webauthn and a wrong rpId → classic passkey_origin`
  - `identification passkey_challenge with app rpId → identify.passkey set; without forwardHost → null`
  - `webauthn setup with app rp.id → passkey-setup; otherwise classic passkey_origin`
  - `email link consent in a recovery-resume jar → internal link-confirm; consent with permissions or in a login jar → classic consent`
  - `email-sent resend error is not an error`
  - `prompt password mismatch → password_mismatch without an Authentik call`
  - `credential answers reject extra keys and oversize fields`
  - `validate with only sms → classic`
  - `captcha → classic`
  - `unknown component → classic unsupported_stage`
  - `final redirect → end`
  - `prompt with a date field → classic`
  - `totp setup passes only otpauth`
  - `response_errors map to codes`
  - `no-leak`: for every fixture, `JSON.stringify(toStep(...))` matches none of `/https?:\/\//`, `authentik`, `flow_token`, `cancel_url`, `avatar` (the `totp-setup` `otpauth://` URI and the passkey options are allowed per Ruling 2; the passkey `rpId`/`rp.id` is the app host, never Authentik's)
  - `toAnswer rejects extra keys and over-long values`
- [ ] **Step 2: Run `npm test -w backend -- flow-steps` and confirm it fails.**
- [ ] **Step 3: Implement `flowSteps.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat(auth): sanitised flow steps for Authentik challenges`.

### Task 3: Flow routes, CSRF, single-use steps, rate limits, LOGIN_UI switch

**Files:**
- Create: `backend/src/routes/authFlow.ts` (register it in `app.ts` after `authRoutes`)
- Modify: `backend/src/routes/auth.ts` (`GET /auth/login`)
- Test: `backend/test/auth-flow.test.ts`

**Interfaces (produces):**
- **Cookies:**
  - `ff_flow`: httpOnly, `sameSite: 'strict'`, `path: '/auth/flow'`, 600 s, value `randomToken()`.
  - `ff_flow_csrf`: readable (not httpOnly), `sameSite: 'strict'`, `path: '/'`, 600 s.
- **CSRF:** every POST under `/auth/flow/` must send the header `x-ff-flow-csrf` equal to the `ff_flow_csrf` cookie (timing-safe), or it gets `403 csrf`. When the jar has `userId`, the session `x-csrf-token` is checked too.
- **`GET /auth/flow/config`** (no auth) → `{ mode: 'app'|'authentik', recovery: boolean, enroll: boolean }`. `recovery` is true when the recovery slug resolves (cached 10 min). It also sets a fresh `ff_flow_csrf`.
- **`POST /auth/flow/start`** with `{ kind: 'login'|'recovery'|'enroll', invite?: string ≤ 128 }`:
  - Mode `authentik` → `409 classic`.
  - `enroll` needs a valid invite with `authentik_invite` (`410 invite_invalid`) and sets `jar.query = 'itoken=<akInvite>'`. `login` with an invite keeps it in `jar.invite`.
  - The answer is the first `FlowStep`, with a new `step` id (`randomToken(16)`).
- **`POST /auth/flow/answer`** with `{ step: string, stage: FlowStep['stage'], ...answer }`:
  - No jar → `{stage:'expired'}`.
  - `step !== jar.step` → `409 step_used`. The jar's `step` is rotated **before** Authentik is called.
  - `{internal:'select-stage'}` is answered automatically: `{selected_stage: pk}`, then the next challenge.
  - `{internal:'end'}` → Task 4's `completeFlow`.
  - `{internal:'link-confirm'}` can only come from `resume` (Task 5). Anywhere else it is `classic/consent`.
- **`POST /auth/flow/cancel`**: ends the session and deletes the jar (Task 4's `endAkSession`), and clears the cookies.
- **Rate limits:**
  - per IP: `start` 20/min, `answer` 30/min, `config` 60/min (route `config.rateLimit`)
  - per username: kv `flowfail:<sha256(lower(identifier))>`, incremented when an answer comes back with `response_errors` that `stepErrors` maps to at least one error (so not the `email-sent` resend). At ≥ 10 within 900 s the next answer is refused with `{ errors: ['rate_limited'] }`, without calling Authentik. A failed passkey assertion counts like a wrong code.
- **Body hygiene:**
  - All handlers catch and map errors to codes: `HttpError` → `{error: code}`; anything else → `500 {error:'internal'}`.
  - Errors are logged as `req.log.warn({ route, code })` only. Never `err`, never `req.body`.
  - The `onResponse` error log keys stay route patterns (existing).
- **Authentik errors:** 503 or 502 from `akExec` → `{ stage: 'unavailable' }` with HTTP 200, so the card can show retry plus classic.
- **`GET /auth/login`:** when `loginUi(cfg) === 'app'` and there is no `classic=1` and no `resetPin=1`, redirect to `/login`, plus `?invite=` when one was given. `/auth/enroll?invite=` also goes to `/login?invite=…&enroll=1` in app mode.

- [ ] **Step 1: Write the failing tests** (`auth-flow.test.ts`, using `akflow-fake.ts` with identification → password → end):
  - `config reports app mode when the API is configured, authentik otherwise`
  - `start without csrf header → 403`
  - `start returns identify with a step id and sets ff_flow`
  - `replaying a step id → 409 step_used and Authentik saw one POST` (Review Focus 2)
  - `answer after 601 s → expired, no Authentik call` (Review Focus 4)
  - `ten failed passwords for one identifier → rate_limited without calling Authentik; another identifier still works`
  - `an email-sent resend does not count as a failure`
  - `Authentik unreachable → stage unavailable` (Review Focus 5)
  - `a password in the body never appears in captured log lines`: build the app with a pino stream into an array, make the fake throw, and check that no line contains the password
  - `/auth/login redirects to /login in app mode, stays on the IdP with classic=1 and with resetPin=1`
  - `LOGIN_UI=authentik: start → 409 classic`
- [ ] **Step 2: Run `npm test -w backend -- auth-flow` and confirm it fails.**
- [ ] **Step 3: Implement `authFlow.ts` and the `/auth/login` change.**
- [ ] **Step 4: Run the tests and confirm they pass**, along with `fixes-auth.test.ts` and `approval.test.ts`.
- [ ] **Step 5: Commit** `feat(auth): /auth/flow routes with single-use steps, csrf and rate limits`.

### Task 4: Finishing a login – silent authorize, shared finishLogin, ending the Authentik session

**Files:**
- Modify: `backend/src/oidc.ts`
- Create: `backend/src/loginFinish.ts` (moves the post-claims logic out of `/auth/callback`)
- Modify: `backend/src/routes/auth.ts` (the callback uses it) and `backend/src/routes/authFlow.ts`
- Test: `backend/test/login-finish.test.ts`

**Interfaces:**
- `OidcProvider.start(opts?: { forceLogin?: boolean; silent?: boolean })`: `silent` adds `prompt=none`. The `finish(...)` signature is unchanged. Update the test fake in `helpers.ts`.
- `finishLogin(ctx, req, reply, claims: OidcClaims, opts: { invite?: string; resetPin?: boolean }): Promise<LoginOutcome>`, where `type LoginOutcome = { kind: 'session' } | { kind: 'pending' } | { kind: 'locked' } | { kind: 'invite_invalid' }`. It does exactly today's callback work:
  - provisioning, invite claim/release, approval request plus the `ff_pending` cookie, the admin-group promotion, the resetPin part
  - session, device, audit `login` with `{ ip, ui: 'app' | 'classic' }`
  - **plus Ruling 7:** `access_until <= now()` and not disabled → `lockUser(ctx, null, id, 'expired')`, audit `user.expired`, and return `locked`
  - The callback maps the outcome to its current redirects or 403. The flow route maps it to `{stage:'done', next: '/' | '/pending'}` or `{stage:'locked'}`.
- `completeFlow(ctx, req, reply, flowId, jar): Promise<FlowStep>`:
  - For `login` and `enroll`: `ctx.oidc.start({ silent: true })`, then `akGet(authorizeUrl)` with the jar. The 302 `Location` must start with `PUBLIC_URL/auth/callback`, then `ctx.oidc.finish(new URL(location), saved)`, then `finishLogin(..., { invite: jar.invite })`.
  - A `Location` to `/if/flow/…` → `classic/consent`. This is what 2026.8.3 does for an explicit-consent provider with `prompt=none` (verified); `consent_required` is not sent. An `error=` parameter in `Location` → `classic/consent` for `consent_required` (older releases), `unavailable` for anything else (including `invalid_request` from a provider without the `authorization_code` grant type, which the status check names).
  - The authorize request goes through `akGet` without forwarded headers, even after a jar ran with `forwardHost` (verified to work).
  - For `recovery` (Ruling 3): `{ stage: 'done', next: '/login?reset=1' }`.
  - Always `endAkSession(ctx, jar)` and `dropJar` afterwards, in a `finally`.
- `endAkSession(ctx, jar): Promise<void>`: a best-effort `akGet` of the invalidation flow's executor URL (`/api/v3/flows/executor/<AUTHENTIK_INVALIDATION_FLOW>/`). U3 is verified: one GET answers `final_redirect` and clears `authentik_session`. It never throws.

- [ ] **Step 1: Write the failing tests:**
  - `silent authorize carries the jar cookie and yields a session` (the fake Authentik answers authorize with a 302 to `PUBLIC_URL/auth/callback?code=c&state=<state>`; the fake OIDC returns claims for a known user)
  - `unknown user without invite → pending, ff_pending cookie set, one approval request` (reuses A5)
  - `with invite → account provisioned and the invite use recorded`
  - `disabled user → locked`
  - `access_until in the past → locked, users.disabled=true, locked_reason='expired', audit user.expired, no ff_sid` (Review Focus 1)
  - `authorize redirects to an authorization flow → classic consent`
  - `the invalidation flow is called and the jar is gone after done`
  - `classic /auth/callback still behaves as before` (existing `fixes-auth` and `approval` suites green)
- [ ] **Step 2: Run `npm test -w backend -- login-finish approval fixes-auth` and confirm it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole backend suite and confirm it passes.**
- [ ] **Step 5: Commit** `feat(auth): finish in-app logins with a silent authorize and shared finishLogin`.

### Task 5: Recovery – e-mail link into the app

**Files:**
- Modify: `backend/src/routes/authFlow.ts`
- Create: `deploy/authentik/templates/friendflix-recovery.html` (Django template)
- Test: extend `backend/test/auth-flow.test.ts`

**Interfaces:**
- `POST /auth/flow/start { kind: 'recovery', identifier?: string }`: when `identifier` is given (from the password screen's "Passwort vergessen?"), the backend answers the recovery flow's identification itself and returns the next step, normally `email-sent`.
- A resend is an `answer` with `stage: 'email-sent'`. It POSTs `{}` (Authentik re-sends and applies its own rate limit). FriendFlix also allows one resend per 60 s per jar, or `{errors:['rate_limited']}`.
- `POST /auth/flow/resume { token: string 16..256, kind?: 'recovery' }` (from the button on `/reset?token=`, Ruling 11):
  - It creates a new jar with `kind: 'recovery-resume'` and `query = 'flow_token=<token>'`, then GETs the executor.
  - The first challenge must be `{internal:'link-confirm', token}` (Authentik's link interstitial, verified on 2026.8.3). The backend answers `{ token }` itself, since the user's click is the confirmation, and returns the next step (`prompt` with password ×2, or `mfa` with the MFA example flow).
  - For older releases without the interstitial, a direct `prompt` is accepted as well.
  - An invalid or used token, or Authentik answering identification or access denied, → `{stage:'expired'}`.
  - The token is never logged; the route has a rate limit of 10/min/IP. Task 10 adds `kind: 'email-confirm'`.
- Template file: it extends `email/base.html`, and states as its first line the one value the owner replaces: `https://friendflix.example.com/reset?token={{ token }}`. The copy is short, in English, with a `{% trans %}` wrapper. Verified: the e-mail stage passes `token` to custom templates. Docs: the `/templates` mount is required, because the 2026.8.3 image has no such directory.

- [ ] **Step 1: Write the failing tests:**
  - `forgot password with identifier → email-sent with masked address`
  - `resend within 60 s → rate_limited, no Authentik call`
  - `resume with token restores the plan (fake checks query=flow_token%3D…), answers the link interstitial with its token, and returns prompt with two password fields`
  - `resume where the first challenge is a consent with permissions → classic consent, the interstitial is not auto-answered`
  - `password mismatch → errors password_mismatch, no Authentik call`
  - `used token (fake answers identification) → expired`
  - `recovery end → done next=/login?reset=1, no session cookie, invalidation called`
  - `bad token → expired`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement the routes and the template.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat(auth): in-app password recovery with the e-mail link back into FriendFlix`.

### Task 6: Cover wall backend

**Files:**
- Modify: `backend/src/media/types.ts` (optional `MediaAdmin` methods) and `backend/src/jellyfin/service.ts` or `client.ts` (the Jellyfin implementation)
- Create: `backend/src/loginArt.ts` and `backend/src/routes/publicArt.ts` (registered in `app.ts`)
- Test: `backend/test/login-art.test.ts`

**Interfaces (produces):**
- `MediaAdmin.loginArtIds?(q: { ratings: readonly string[]; limit: number }): Promise<string[]>`. Jellyfin: `/Items?Recursive=true&IncludeItemTypes=Movie,Series&ImageTypes=Primary&SortBy=Random&OfficialRatings=<a|b|…>&Limit=<n>`, with the admin API key and **no** `userId` and **no** `ParentId`, so every library is searched (owner decision; U5 verified on Jellyfin 10.11.11).
  - The ratings are joined with `|` and the whole value is URL-encoded once (it contains spaces, as in `FSK 12`). A comma-joined list matches nothing (verified).
  - Do not add `maxOfficialRating`/`hasParentalRating`: they let unrated items through (verified).
  - Defence in depth: the backend drops any returned item whose `OfficialRating` (requested via `Fields=OfficialRating`) is not in the allow-list, before it caches the image.
- `MediaAdmin.posterThumb?(id: string, maxWidth: number): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/webp' } | null>`. Jellyfin: `/Items/<id>/Images/Primary?maxWidth=<w>&quality=70&format=Jpg` (verified: `image/jpeg`).
- `LOGIN_ART_RATINGS` (Ruling 6), `LOGIN_ART_COUNT = 36`, `LOGIN_ART_WIDTH = 200`, `LOGIN_ART_TTL = 3600`.
- `getLoginArtSettings(ctx): Promise<{ coverWall: boolean }>` and `setLoginArtSettings(ctx, s)`, stored in `app_settings` key `login_art` (default `{ coverWall: true }`).
- `currentArtSet(ctx): Promise<{ set: string; count: number } | null>`:
  - Returns null when off, when the seam methods are absent or when there are no ids.
  - Building is guarded by `kv.setnx('loginart:building', 1, 60)`.
  - It stores kv `loginart:current` = `{set, count}` and `loginart:<set>:<i>` = base64 bytes plus the type, all with TTL 3600. `set = randomToken(9)`.
  - Failures of single images are skipped.
- **Routes** (no auth, no CSRF, `Cross-Origin-Resource-Policy: same-origin` as today):
  - `GET /api/public/login-art` → `{ images: string[] }`, as `/api/public/login-art/<set>/<i>` paths, with `cache-control: public, max-age=3600`. Rate limit 30/min/IP.
  - `GET /api/public/login-art/:set/:i` → the image bytes, with `cache-control: public, max-age=3600, immutable`; unknown → 404. Rate limit 300/min/IP. `set` matches `^[A-Za-z0-9_-]{12}$` and `i` matches `^\d{1,2}$`.
- `GET|PUT /api/admin/login-settings` with `{ coverWall: boolean }` (admin, audited `settings.login_art`).

- [ ] **Step 1: Write the failing tests:**
  - `login-art lists paths only: no item ids, no media-server host, no tags`: assert the JSON does not contain the fake Jellyfin host or any fake item id
  - `second call within the hour reuses the set (one Jellyfin listing call)`
  - `query has no ParentId and no userId (all libraries) and carries the pipe-joined, URL-encoded rating allow-list incl. "FSK 12"`
  - `an item returned with a rating outside the allow-list (or none) is dropped`
  - `LOGIN_ART_RATINGS contains no PG-13, TV-14, NR or empty value`
  - `coverWall off → images []`
  - `media server without loginArtIds → images []` (seam optional)
  - `image route serves bytes with immutable cache; bad set → 404`
  - `admin toggle is audited`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and `npm run typecheck -w backend` and confirm they pass.**
- [ ] **Step 5: Commit** `feat(login): public cover-wall images from the library through the media seam`.

### Task 7: Web – login page, cover wall, sign-in screens

**Files:**
- Create:
  - `web/src/routes/login/+page.svelte`
  - `web/src/lib/auth/AuthShell.svelte` (logo, wall and card)
  - `web/src/lib/auth/CoverWall.svelte`
  - `web/src/lib/auth/flow.ts` (client and state machine)
  - `web/src/lib/auth/flow.test.ts`
  - `web/src/lib/auth/Identify.svelte`, `Password.svelte`, `Mfa.svelte` (6 boxes plus the recovery-code toggle), `Notice.svelte` (denied / locked / expired / unavailable / classic)
- Modify: `web/src/routes/pending/+page.svelte` (uses `AuthShell`, copy screen 5)
- Locales: `login.ts` × 7 and the `index.ts` registrations
- e2e: `e2e/mocks/login.ts`, `e2e/tests/login.spec.ts`, `e2e/tests/login.mobile.spec.ts`

**Interfaces (produces), in `flow.ts`:**
- `flowConfig(): Promise<{ mode; recovery; enroll }>`
- `startFlow(kind, extra?)`, `answer(step: FlowStep, body)`, `cancelFlow()`: these send `x-ff-flow-csrf` from `document.cookie`.
- The `FlowStep` type mirrors Task 2 (copied, not imported).
- `codeFromBoxes(digits: string[]): string`
- `pasteCode(text: string): string[]`, which keeps only digits, max 6
- `wallColumns(images: string[], cols = 5): string[][]`, which round-robins and repeats each column twice for a seamless loop
- `fallbackArt(seed: number, n: number): Array<{ from: string; to: string; angle: number }>`, built from the app's palette tokens, with no text
- `passkeyGet(options: PasskeyGet): Promise<Credential>` and `passkeyCreate(options: PasskeyCreate): Promise<Credential>`:
  - They use `PublicKeyCredential.parseRequestOptionsFromJSON` / `parseCreationOptionsFromJSON` and `credential.toJSON()` where the browser has them, and otherwise a small base64url conversion.
  - They throw `'passkey_cancelled'` on `NotAllowedError` / `AbortError` and `'passkey_unsupported'` when `window.PublicKeyCredential` is missing.

**Behaviour:**
- **Mode:** with `mode === 'authentik'`, `/login` sets `location.href = '/auth/login?classic=1'`.
- **Identification:**
  - "Mit Passkey anmelden": when `step.passkey` is set, it runs `passkeyGet` in-app and answers `{ passkey }`. Otherwise it goes to classic.
  - On `passkey_cancelled` the card shows "Kein passender Passkey gefunden?" with the classic link "Auf der Anmeldeseite mit Passkey anmelden" (Ruling 1, trade-off).
  - "Noch kein Konto? Einladung einlösen" opens an inline field for the invite link or token and goes to `/invite/<token>` (the existing page).
- **Password:** the identity pill shows the identifier, and "ändern" restarts the flow. Show-password toggle. "Passwort vergessen?" appears only when `recovery`.
- **TOTP:** auto-submit on the 6th digit, and paste fills all boxes. "Stattdessen Wiederherstellungscode nutzen" swaps in one text field.
- **Passkey on the MFA screen:** "Passkey verwenden" runs `passkeyGet(step.passkey)` in-app when it is set; when only `passkeyClassic` is set, it goes to classic. When the only factor is a passkey (no TOTP or static), the screen starts with the passkey button and no code boxes.
- **Notices:**
  - Classic: "Auf der Anmeldeseite fortfahren" → `/auth/login?classic=1`, plus `&invite=` when present.
  - Unavailable: retry plus a classic link.
  - Expired: "Sitzung abgelaufen, bitte neu starten".
  - `done` → `location.href = next`.
- **Cover wall:**
  - 5 columns rotated −10°, alternating `up` and `down` keyframes at 44–59 s, with a dimming gradient toward the card (values from the mockup CSS).
  - `@media (prefers-reduced-motion: reduce)` stops the animation.
  - Images use `loading="lazy" decoding="async" alt="" aria-hidden="true"`. The wall is `aria-hidden` and not focusable.
  - No images → `fallbackArt` tiles.
  - Desktop: the card is centred, `max-width: 420px`. Phone: the card is pinned to the bottom with a 16px gutter.
- **Accessibility:**
  - Every input has a `<label>`. Errors go to `aria-live="polite"`, and focus moves to the first field on each step.
  - The 6 boxes are one group with `aria-label` "Bestätigungscode", and each box has `inputmode="numeric" autocomplete="one-time-code"` (the first box) or `off`.
  - `autocomplete` is `username` / `current-password` / `new-password` as appropriate.

- [ ] **Step 1: Write the failing tests.**
  - Unit (`flow.test.ts`):
    - `pasteCode('12 34-56x') → ['1','2','3','4','5','6']`
    - `wallColumns(36 images) gives 5 columns, each doubled`
    - `fallbackArt is deterministic for a seed`
    - `answer sends x-ff-flow-csrf from the cookie`
    - `passkeyGet converts base64url options and returns JSON; NotAllowedError → passkey_cancelled`
  - e2e (desktop + mobile, mocks in `login.ts` with a scripted step sequence):
    - `password + TOTP login reaches home`
    - `passkey as second factor: Chromium virtual authenticator (CDP WebAuthn.addVirtualAuthenticator), the mock receives { webauthn } with clientDataJSON origin = the app origin, and the flow reaches home` (desktop Chromium only)
    - `passwordless "Mit Passkey anmelden" with a virtual authenticator sends { passkey }`
    - `passkey cancelled shows the classic passkey link`
    - `mfa step with passkeyClassic only links to the sign-in page`
    - `wrong password shows the error and keeps the identity pill`
    - `paste fills six boxes and submits`
    - `recovery-code toggle`
    - `unknown stage shows "Auf der Anmeldeseite fortfahren" linking /auth/login?classic=1&invite=…` (Review Focus 3)
    - `service unavailable keeps the wall and offers retry` (Review Focus 5)
    - `reduced motion: wall columns have no animation` (`page.emulateMedia({ reducedMotion: 'reduce' })`, computed `animation-name === 'none'`)
    - `wall images are same-origin /api/public paths`
    - a11y: `each step has labelled inputs and a heading`
    - `pending page uses the shell`
- [ ] **Step 2: Run `npm test -w web -- auth` and `npx playwright test login` and confirm they fail.**
- [ ] **Step 3: Implement the components, the page and the 7 locale files.**
- [ ] **Step 4: Run the unit tests, the e2e tests (desktop + mobile) and `npm run typecheck -w web`, and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): in-app sign-in screens over a cover wall`.

### Task 8: Web – recovery, reset link and enrolment screens

**Files:**
- Create:
  - `web/src/routes/reset/+page.svelte`
  - `web/src/lib/auth/EmailSent.svelte`
  - `web/src/lib/auth/PromptFields.svelte`
  - `web/src/lib/auth/TotpSetup.svelte` (QR from `qrPath(otpauth)`, the secret shown in groups of 4, a 6-box confirmation)
  - `web/src/lib/auth/RecoveryCodes.svelte` (list, copy and download as `.txt`, a "Gespeichert" confirmation)
- Modify: `web/src/routes/login/+page.svelte` (the `?invite=&enroll=1` start, and the `?reset=1` banner) and `web/src/routes/invite/[token]/+page.svelte` (in app mode, "Konto anlegen" → `/login?invite=…&enroll=1`)
- Locales: `login.ts` × 7
- e2e: `e2e/tests/login-recovery.spec.ts` and `login-enroll.spec.ts` (+ mobile)

**Behaviour:**
- **E-mail sent:** "Erneut senden (m:ss)" counts down from 60 s and then enables. "Zurück zur Anmeldung" cancels.
- **`/reset?token=`:**
  - On load it only moves the token into component state and calls `history.replaceState` to drop it from the URL. It shows "Neues Passwort festlegen" with the button "Weiter". Authentik is not called yet (Ruling 11).
  - The button calls `resume`.
  - Shows the prompt (two password fields, with a strength hint only from Authentik's errors).
  - Ends on "Passwort geändert" with a button to `/login`.
- **Enrolment:** prompt fields, then `totp-setup` and `recovery-codes` when the flow has them, then `done` → `/` (or `/pending`).
- **Secrets on screen:** `otpauth` and the recovery codes stay in component state only. They are not stored, and they are cleared on destroy.

- [ ] **Step 1: Write the failing tests** (e2e):
  - `forgot password → inbox screen with masked address and countdown`
  - `reset link drops the token from the URL, makes no resume call until "Weiter" is clicked, then sets a new password`
  - `mismatched passwords show the error`
  - `invite enrol: prompt → TOTP setup (QR rendered, 6 boxes) → recovery codes → home`
  - mobile: `QR fits and codes wrap`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run e2e (desktop + mobile) and svelte-check, and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): in-app recovery, reset link and invite enrolment`.

### Task 9: Status checks, admin toggle, docs (3a)

**Files:**
- Create: `backend/src/flowCheck.ts`
- Modify: `backend/src/routes/admin.ts` (`/api/admin/status` gains `login`) and `web/src/routes/admin/status/+page.svelte` (a "Sign-in" card with the checks and the cover toggle)
- Test: `backend/test/flow-check.test.ts`
- Docs:
  - `docs/authentik.md` + `docs/de/authentik.md`: a new section "In-app sign-in", covering:
    - the flows and slugs, and implicit consent
    - the provider's grant types: `authorization_code` must be ticked; providers created on 2026.8 start with none
    - `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` with the backend's address, and why the backend should reach Authentik directly (forwarded host and client IP)
    - the `/templates` mount (not present in the image) and the template's one edited line
    - passkeys in-app: how it works, the preconditions, `PASSKEYS_IN_APP=off`, and the RP-ID trade-off (passkeys made in FriendFlix work only there; passkeys made on Authentik's pages only there)
    - `LOGIN_UI` and `?classic=1`
  - `docs/security.md`:
    - flow jar encryption and TTL, and the rate limits
    - the public cover endpoint and its safe set (all libraries, the FSK ≤ 12 allow-list, unrated excluded)
    - the forwarded-host trust (only the backend sends it, only for login/re-auth/passkey setup, and the browser still binds every assertion to the app origin)
    - e-mail links need a click
  - `docs/setup.md`: the new env keys (including `PASSKEYS_IN_APP` and `AUTHENTIK_EMAIL_CHANGE_FLOW`)
  - `.env.example`
  - README feature line (EN/DE), with screenshots using generated art only
  - CHANGELOG under Unreleased → Login

**Interfaces:**
- `checkLoginFlows(ctx): Promise<LoginCheck>`, cached 10 min in kv `flowcheck`:
  ```ts
  { mode: 'app' | 'authentik';
    flows: Array<{ kind: FlowKind; slug: string; state: 'ok' | 'missing' | 'unsupported'; stages: string[] }>;
    implicitConsent: boolean | null;
    authCodeGrant: boolean | null;
    issuerMatches: boolean;
    passkeys: 'in-app' | 'sign-in page';
    passkeysReason: 'ok' | 'disabled' | 'not_https' | 'forwarded_host_ignored' | 'unreachable' }
  ```
  - Stages come from `GET flows/instances/<slug>/` and `flows/bindings/?target=<pk>`, read through **`stage_obj.meta_model_name`**. `stage_obj.component` is the admin form name (`ak-stage-email-form`; verified), not the challenge component.
  - Supported `meta_model_name`s:
    - `authentik_stages_identification.identificationstage`, `…password.passwordstage`
    - `…authenticator_validate.authenticatorvalidatestage`, `…authenticator_totp.authenticatortotpstage`, `…authenticator_static.authenticatorstaticstage`, `…authenticator_webauthn.authenticatorwebauthnstage`
    - `…email.emailstage`, `…prompt.promptstage`, `…user_login.userloginstage`, `…user_write.userwritestage`, `…invitation.invitationstage`, `…deny.denystage`, `…user_logout.userlogoutstage`
  - Flows checked: login, recovery, enroll, invalidation and the 3b setup flows. The e-mail change flow is checked in Task 10.
  - `implicitConsent`: `providers/oauth2/?client_id=<OIDC_CLIENT_ID>` → the `authorization_flow` bindings contain no consent stage (`authentik_stages_consent.consentstage`).
  - `authCodeGrant`: that provider's `grant_types` includes `authorization_code`. False → a warning naming the fix, because authorize then fails with `invalid_request` (verified on 2026.8.3).
  - `issuerMatches`: the OIDC_ISSUER origin equals the AUTHENTIK_URL origin (the jar's cookies must apply to authorize).
  - `passkeys` (Ruling 1):
    - `disabled` when `PASSKEYS_IN_APP=off`, and `not_https` when PUBLIC_URL is not `https:` (localhost excepted).
    - Otherwise the probe runs: `GET <OIDC_ISSUER>.well-known/openid-configuration` with `x-forwarded-host: <PUBLIC_URL host>` and `x-forwarded-proto: https`, and no auth.
    - `issuer` starting with `https://<PUBLIC_URL host>/` → `in-app`/`ok`. Another host → `sign-in page`/`forwarded_host_ignored`, with a hint to add the backend to `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` and to call Authentik directly. A network error → `unreachable`.
    - Verified: the issuer follows the forwarded host exactly when the caller is trusted. The result is stored in kv as `forwardedHostHonoured` (10 min) for `passkeysInApp` (Task 1).
- Status texts in backend i18n, 7 languages. A failing check never changes `mode`; it shows a warning.

- [ ] **Step 1: Write the failing tests:**
  - `missing flow → missing`
  - `flow with a captcha stage → unsupported with stages listed`
  - `explicit-consent authorization flow → implicitConsent false`
  - `issuer on another host → issuerMatches false`
  - `bindings are classified by meta_model_name, not by the -form component`
  - `provider with grant_types [] → authCodeGrant false and a warning`
  - `discovery probe: issuer on the app host → passkeys in-app; on Authentik's host → sign-in page, forwarded_host_ignored`
  - `PASSKEYS_IN_APP=off → sign-in page, disabled, no probe call`; `http PUBLIC_URL → not_https`
  - `no API → mode authentik and flows []`
  - e2e `admin status shows sign-in card and toggles covers` (extend `admin-health.spec.ts` mocks)
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement the check, the card and the docs.**
- [ ] **Step 4: Run the full checks and confirm they pass:**
  - `npm run lint`
  - `npm run typecheck -w web`
  - `npm run spdx:check`
  - `npm run coverage -w backend`
  - `npm run coverage -w web`
  - `npm run build -w web`
  - the e2e login* and admin-health specs (desktop + mobile)
  - `grep -ri seerr web/src/lib/i18n/locales/*/login.ts` is empty
- [ ] **Step 5: Commit** `docs: Block 23 phase 3a in-app login`.

---

## Part 3b – Account security (PR 2)

### Task 10: In-app re-authentication, security actions and e-mail change (backend)

**Files:**
- Modify: `backend/src/session.ts` (only if phase 2 has not landed: `reauthAt?: number` on `Session`, and `requireRecentAuth(ctx, maxAgeMs)`, which answers `403 reauth_required`), `backend/src/routes/authFlow.ts`, `backend/src/authentik.ts` and `backend/src/flowCheck.ts` (adds the e-mail change flow to the checks)
- Create: `deploy/authentik/blueprints/friendflix-email-change.yaml` (the blueprint below, verbatim) and `deploy/authentik/templates/friendflix-email-change.html` (first line: `https://friendflix.example.com/confirm-email?token={{ token }}`; extends `email/base.html`; short English copy with `{% trans %}`)
- Test: `backend/test/account-security.test.ts`, `backend/test/email-change.test.ts`

**Blueprint** (applied and run end to end on Authentik 2026.8.3, from `/blueprints/custom/`; only the template line is owner-specific):
```yaml
# yaml-language-server: $schema=https://goauthentik.io/blueprints/schema.json
version: 1
metadata:
  name: FriendFlix - change e-mail with confirmation
entries:
  - model: authentik_flows.flow
    id: flow
    identifiers:
      slug: friendflix-email-change
    attrs:
      name: FriendFlix e-mail change
      title: Change e-mail address
      designation: stage_configuration
      authentication: require_authenticated
  - model: authentik_stages_prompt.prompt
    id: field-email
    identifiers:
      name: friendflix-email-change-field
    attrs:
      field_key: email
      label: New e-mail address
      type: email
      required: true
      placeholder: ""
      order: 0
  - model: authentik_stages_prompt.promptstage
    id: prompt
    identifiers:
      name: friendflix-email-change-prompt
    attrs:
      fields:
        - !KeyOf field-email
  - model: authentik_stages_email.emailstage
    id: email
    identifiers:
      name: friendflix-email-change-confirm
    attrs:
      use_global_settings: true
      template: friendflix-email-change.html
      subject: Confirm your new e-mail address
      activate_user_on_success: false
      token_expiry: minutes=30
  - model: authentik_stages_user_write.userwritestage
    id: write
    identifiers:
      name: friendflix-email-change-write
    attrs:
      user_creation_mode: never_create
  - model: authentik_policies_expression.expressionpolicy
    id: to-new-address
    identifiers:
      name: friendflix-email-change-send-to-new-address
    attrs:
      expression: |
        plan = context["flow_plan"]
        plan.context["pending_user"] = request.user
        plan.context["email"] = context["prompt_data"]["email"]
        return True
  - model: authentik_flows.flowstagebinding
    identifiers:
      target: !KeyOf flow
      stage: !KeyOf prompt
      order: 10
  - model: authentik_flows.flowstagebinding
    id: email-binding
    identifiers:
      target: !KeyOf flow
      stage: !KeyOf email
      order: 20
    attrs:
      evaluate_on_plan: false
      re_evaluate_policies: true
  - model: authentik_policies.policybinding
    identifiers:
      policy: !KeyOf to-new-address
      target: !KeyOf email-binding
      order: 0
  - model: authentik_flows.flowstagebinding
    identifiers:
      target: !KeyOf flow
      stage: !KeyOf write
      order: 30
```

**Interfaces:**
- **`POST /auth/flow/start { kind: 'reauth', then?: 'setup-totp' | 'setup-static' | 'setup-webauthn' | 'change-password' | 'change-email' }`:**
  - Needs a session (`requireUser`, owner profile).
  - `jar.userId` = the session user. The backend answers identification itself with `akUserBySub(...).username`, so the first step shown is `password`. With passkeys in-app, the `mfa` step (or the password step's "Passkey verwenden") offers the in-app ceremony. The jar has `forwardHost` (kind `reauth`).
  - At the end: a silent authorize, then `finish`. `claims.sub` must equal the session user's `authentik_sub`, or the answer is `{stage:'denied'}` with audit `account.reauth_mismatch`. If it matches, the session gets `reauthAt = Date.now()`.
  - With `then`: the same jar (now logged in to Authentik) starts the setup flow (`flowSlug(cfg, then)`) and returns its first step. Otherwise → `{stage:'done', next:'/me?tab=account&section=security'}`.
  - Authentik's session is ended after the last flow (`endAkSession`).
- **Setup kinds** are only reachable through `reauth → then`; starting them directly → 400. CSRF is double-submit plus the session `x-csrf-token`. The jar is logged in to Authentik, so `akExec` adds `x-authentik-csrf` and the matching `origin`/`referer` (U1).
  - `setup-static`: U4 is verified. A second run adds a second static device, and the old codes stay valid. So the backend lists the user's static devices **before** the flow, and deletes exactly those **after** the new codes are confirmed (`recovery-codes` answered and `final_redirect`). A cancelled regeneration leaves the old codes working, and a finished one leaves only the new ones.
  - `setup-webauthn` (Ruling 1): when `passkeysInApp`, the jar keeps `forwardHost`, and the step is `passkey-setup`. The web runs `passkeyCreate` and answers `{ response }`. Otherwise `then: 'setup-webauthn'` is refused with `409 passkey_classic` and the web uses `/auth/flow/classic/webauthn-setup`.
  - The `prompt` step of `change-password` maps `password`/`password_repeat`.
- **E-mail change (Ruling 10):**
  - `then: 'change-email'` starts `AUTHENTIK_EMAIL_CHANGE_FLOW` with the reauth jar. Its first step is `prompt` with one field `email` (FriendFlix label "Neue E-Mail-Adresse").
  - On the answer, the backend first checks the address with zod (`email()`, ≤ 254). It must differ from the current address, and it must not be used by another FriendFlix user (`users.email`, case-insensitive) or another Authentik user (`core/users/?email=`). Otherwise the answer is `{ errors: ['email_in_use'] }` or `['invalid']`, without calling Authentik.
  - The next step is `email-sent` with `to = maskEmail(new address)`. The backend then ends the Authentik session (`endAkSession`) and drops the jar; the link works without a session (verified).
  - Audit `account.email_requested` with `{ fields: ['email'] }`. The new address is kept in kv `emailchange:<userId>` for 30 min, **encrypted**, only to show "Bestätigung ausstehend an a•••@…" on the account page.
  - **`POST /auth/flow/resume { token, kind: 'email-confirm' }`** (no session needed, 10/min/IP): a new jar with `kind: 'email-confirm'` and `query = 'flow_token=<token>'`.
    - The first challenge must be the link interstitial (`{internal:'link-confirm'}`). Its `pending_user` (the Authentik username) is read **before** the backend answers `{ token }`.
    - `final_redirect` → `akUserByUsername(pending_user)` → the FriendFlix user via `authentik_sub`. Then `users.email` is set from Authentik's current value (not from anything the client sent), audit `account.email` with `{ fields: ['email'] }` and actor = that user, the `emailchange:` kv is dropped, and the answer is `{ stage: 'done', next: '/confirm-email?ok=1' }`.
    - Any other challenge → `{ stage: 'expired' }`. No FriendFlix or Authentik session is created.
  - `GET /api/me/security` also returns `emailChangePending: string | null` (masked).
  - The status check (Task 9's `checkLoginFlows`) adds the e-mail change flow. Expected `meta_model_name`s: prompt, email, user_write. A missing flow → the account page hides "E-Mail ändern" and shows "E-Mail ändern ist nicht eingerichtet" to admins only.
- **Account routes** (`requireOwner` + `requireRecentAuth(ctx, 600_000)`):
  - `GET /api/me/security` → `{ mfa: MfaState | null; devices: Array<{ id: string; type: 'totp' | 'static' | 'webauthn'; name: string; lastUsed: string | null }>; passkeySetup: 'sign-in page' }`, via `authenticators/admin/all/?user=<pk>`. Only the GET skips `requireRecentAuth`.
  - `DELETE /api/me/security/devices/:type/:id` → `akDeleteDevice(ctx, sub, type, id)`. It refuses removing the last second factor when the login flow's validate stage makes MFA mandatory (`409 last_factor`). Audited `account.mfa_removed`, and the `akmfa:` cache is dropped.
- `GET /api/me/security` reports `passkeySetup: 'in-app' | 'sign-in page'` (from `passkeysInApp`) instead of the fixed `'sign-in page'`.
- `GET /auth/flow/classic/webauthn-setup` (session): 302 to `<AUTHENTIK_URL>/if/flow/<AUTHENTIK_WEBAUTHN_SETUP_FLOW>/`. This is a redirect, not JSON. It is the fallback of Ruling 1.
- `akDeleteDevice(ctx, sub, type: 'totp' | 'static' | 'webauthn', id: number): Promise<void>`: checks that the device belongs to the user's pk (from `admin/all/?user=<pk>`; its `pk` is a string, so compare as strings), then `DELETE api/v3/authenticators/admin/<type>/<id>/` (U2, verified: 204). An unknown device → 404 `device_not_found`.
- The phase 2 "manage on the sign-in page" link is replaced by these routes (web, Task 11).

- [ ] **Step 1: Write the failing tests:**
  - `reauth skips identification and asks for the password`
  - `reauth of another Authentik user → denied and audited`
  - `reauth sets reauthAt; DELETE device works within 10 min, 403 reauth_required after 11 min`
  - `reauth then setup-totp returns totp-setup and finishing ends the Authentik session`
  - `setup-static deletes exactly the previously listed static devices after the new codes are confirmed; a cancelled run deletes nothing` (U4)
  - `reauth then setup-webauthn with passkeys in-app returns passkey-setup with rp.id = app host and rp.name FriendFlix; without → 409 passkey_classic`
  - `logged-in setup POSTs carry x-authentik-csrf and origin` (U1)
  - email-change (`email-change.test.ts`):
    - `reauth then change-email → prompt with one email field`
    - `an address used by another user → email_in_use, no Authentik call`
    - `answer → email-sent masked to the NEW address, Authentik session ended, audit account.email_requested without addresses`
    - `resume email-confirm: answers the interstitial, then final_redirect → users.email updated from Authentik, audit account.email { fields: ['email'] } only, no session cookie`
    - `resume email-confirm with a used token → expired, users.email unchanged` (Review Focus 7)
    - `the blueprint file parses and contains the policy binding with re_evaluate_policies true`
  - `delete a device of another user → 404`
  - `removing the last factor under mandatory MFA → 409 last_factor`
  - `setup kinds cannot be started directly`
  - `csrf: session token required`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole backend suite and confirm it passes.**
- [ ] **Step 5: Commit** `feat(account): in-app re-authentication, 2FA/passkey management and e-mail change through Authentik flows`.

### Task 11: Web – Security section under /me → Account

**Files:**
- Create:
  - `web/src/lib/account/SecurityPanel.svelte` and `web/src/lib/auth/ReauthDialog.svelte` (it reuses `Password.svelte`, `Mfa.svelte`, `TotpSetup.svelte`, `RecoveryCodes.svelte`, `PromptFields.svelte` and `EmailSent.svelte`)
  - `web/src/lib/auth/PasskeySetup.svelte` (explains the passkey, runs `passkeyCreate`, then shows "Passkey hinzugefügt")
  - `web/src/lib/account/EmailChange.svelte`
  - `web/src/routes/confirm-email/+page.svelte` (uses `AuthShell`)
- Modify: `web/src/routes/me/+page.svelte`, mounting it where phase 2 put the Security block (or as a "Sicherheit" section when phase 2 has not landed)
- Locales: `login.ts` × 7
- e2e: `e2e/tests/account-security.spec.ts` (+ mobile)

**Behaviour:**
- **Rows:**
  - Passwort ändern
  - Authenticator-App (add / remove)
  - Passkeys: list and remove in-app.
    - "Passkey hinzufügen" runs in-app (`reauth` → `setup-webauthn` → `PasskeySetup`) when `passkeySetup === 'in-app'`. Otherwise it is "Auf der Anmeldeseite hinzufügen" → `/auth/flow/classic/webauthn-setup`, in the same tab.
    - A short note under the row: "Passkeys, die du hier anlegst, gelten für FriendFlix." (Ruling 1, trade-off)
  - Wiederherstellungscodes (regenerate)
  - E-Mail-Adresse (Ruling 10):
    - It shows the current address, with "Ändern" → re-auth → `reauth` with `then: 'change-email'` → one field "Neue E-Mail-Adresse" → `EmailSent` ("Wir haben einen Bestätigungslink an a•••@… geschickt. Die Adresse ändert sich erst, wenn du den Link öffnest.").
    - While a change is pending: "Bestätigung ausstehend an a•••@…".
    - Errors: `email_in_use` → "Diese Adresse wird schon verwendet."
- **`/confirm-email?token=`** (Ruling 11):
  - On load: the token goes into state, `history.replaceState` drops it from the URL, and the page shows "Neue E-Mail-Adresse bestätigen" with the button "Adresse bestätigen". There is no API call before the click.
  - The click → `resume { token, kind: 'email-confirm' }`. `done` → "E-Mail-Adresse geändert" with a button to `/me?tab=account`; `expired` → "Link abgelaufen oder schon benutzt".
  - It works without a FriendFlix session.
- **Re-auth:** any action first calls the API. On `403 reauth_required` it opens `ReauthDialog` (a modal with the flow steps) and then retries once. For setup actions the dialog starts `reauth` with `then` and shows the setup steps inline. "Passkey verwenden" in the dialog → phase 2's redirect re-auth.
- **Removals** use `confirm` and show the device name.

- [ ] **Step 1: Write the failing tests** (e2e):
  - `add authenticator: password → QR → code → listed`
  - `remove asks for re-auth when stale, then removes`
  - `regenerate recovery codes shows new codes once`
  - `change password with mismatch error then success`
  - `passkey add in-app with a Chromium virtual authenticator (passkeySetup in-app); with passkeySetup 'sign-in page' it links to the sign-in page`
  - `change e-mail: re-auth → new address → "Bestätigungslink" screen with masked new address; email_in_use error shown`
  - `confirm-email: no resume call before the click; after it "E-Mail-Adresse geändert"; used link → expired text` (Review Focus 7)
  - a11y: `dialog has a name and traps focus`
  - mobile: `panel rows stack`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run e2e (desktop + mobile) and svelte-check, and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): account security and e-mail change with in-app re-authentication`.

### Task 12: Docs and full checks (3b)

**Files:**
- `docs/authentik.md` + DE:
  - the setup flows (slugs, stage bindings, MFA-mandatory note)
  - the API token permissions for the admin device viewsets (view and delete TOTP, static and WebAuthn devices) and for `core/users` (view)
  - **E-mail change:**
    - mount `deploy/authentik/blueprints/friendflix-email-change.yaml` under `/blueprints/custom/` (Authentik discovers it; apply it under Customization → Blueprints) and `friendflix-email-change.html` under `/templates`, after editing its one line
    - why the policy sets `pending_user` and `email`
    - that the mail goes only to the new address and nothing changes until the link is clicked
    - `AUTHENTIK_EMAIL_CHANGE_FLOW` for a custom slug
- `docs/security.md`: the 10-minute re-auth window and what it guards (now including e-mail change), the e-mail change confirmation (new address only, click required, audit without addresses), passkeys scoped to the app host
- `docs/superpowers/specs/…`: nothing (the spec was updated together with this plan)
- CHANGELOG (Unreleased → Account)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full check list from Task 9, Step 4, plus the `account-security` e2e.**
- [ ] **Step 3: Commit** `docs: Block 23 phase 3b account security`.
