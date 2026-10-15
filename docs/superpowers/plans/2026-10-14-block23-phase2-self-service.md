# Block 23 Phase 2 – Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users manage their own account on `/me/account`: name and avatar (e-mail shown read-only), their 2FA state, sessions and devices, a "Download my data" export, and deleting the account with a 7-day grace period that ends in a resumable, audited final deletion.

**Architecture:** A new `routes/account.ts` holds the self-service API. A new `reauth.ts` provides the `requireRecentAuth` guard: in this phase it is fed by an OIDC re-login (`prompt=login`, `max_age=0`) that stamps `reauthAt` on the existing session; phase 3 feeds the same guard from its in-app password screen. Deletion lives in a new `deletion.ts`. Scheduling it uses phase 1's `lockUser(…, 'deletion')`. The final cleanup is a per-step resumable state machine in a new `account_deletions` table, and it runs on the existing 60 s expiry timer. The export is a streamed JSON document built from explicit column allowlists.

**Tech Stack:** Fastify + zod + Postgres (backend), SvelteKit (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-block23-user-management-design.md` (Part B; it builds on Part A as merged in phase 1 at `d69eed3`. Part C is phase 3.)

## Global Constraints

- Tokens and passwords are never logged.
- Never return `jellyfin_pw_enc`, tokens or `authentik_sub` to clients.
- Every admin and destructive action is audited (`audit(ctx, actor, action, target, meta)`).
- 7 locales: all new UI strings go in `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/account.ts` (account pages) and `…/adminPeople.ts` (admin side). All new notification texts go in all 7 languages in `backend/src/messages.ts`.
- Never the word "Seerr" in user-facing text. The UI says "request service" / "Wünsche".
- No trademark look-alikes.
- The export contains no other users' data.
- README screenshots use fictional titles only.
- Migrations: append to `MIGRATIONS` in `backend/src/db.ts` only, as entry **38** with a `// 38: reason` comment. Never edit old entries.
- Media server only through `ctx.jf` (the media seam). This phase adds **no** required seam method: deletion uses the existing `MediaAdmin.deleteIdentity` (an unknown id counts as removed), so the Plex fork keeps compiling unchanged.
- Authentik calls only through `backend/src/authentik.ts`. Its errors carry a code only (the existing `call()` contract).
- No new dependencies.
- Backend tests: `backend/test/*.test.ts` with `makeEnv`/`resetDb` from `backend/test/helpers.ts`. e2e: `e2e/tests/account*.spec.ts` (desktop + `.mobile.spec.ts`) with mocks in `e2e/mocks/api.ts` / `e2e/mocks/admin.ts`.
- Coverage thresholds must hold. Lint, typecheck and spdx:check must be clean.

## Controller Rulings (binding for this plan)

1. **Scope.** Phase 2 covers:
   - Profile: name and avatar; e-mail read-only (its change moves to phase 3).
   - Sessions & devices UI, on the existing endpoints.
   - "Download my data": streamed JSON, own data only.
   - Delete account with the 7-day grace period:
     - lock at once (`deletion_at`, `locked_reason='deletion'`) and notify the admins
     - restore on sign-in within 7 days
     - admin restore and admin delete-now
     - final deletion steps 1–6 as the spec lists them, with the audit pseudonym `deleted-<short hash>`
     - the Authentik user is deactivated, not deleted
   - The 2FA **state** display.
2. **Moved to phase 3:** the Security actions that need Authentik's flow-executor screens: change password, add/remove TOTP, passkeys, recovery codes. Phase 2 shows the 2FA state and a "Manage on the sign-in page" link to Authentik's user settings as a stopgap.
3. **Re-authentication (≤ 10 min)** for delete account is implemented in phase 2 with the existing OIDC redirect (`prompt=login`, `max_age=0`) and a server-side `reauthAt` stamp on the session. Phase 3 swaps the producer for its in-app password screen, behind the same guard `requireRecentAuth` (interface in Task 1).
4. **Final deletion** runs in the existing background tick pattern (`server.ts` 60 s timer next to `expiryTick`). It is idempotent, resumable per step and audited.
5. **The `deletion` lock** interacts correctly with phase 1's `lockUser`/`unlockUser`, the `access_until` expiry and the last-admin guard. An admin who is the last active admin cannot self-delete.
6. **Media server** only via `ctx.jf`. The Plex fork must keep compiling, so any new seam method is optional (none is needed; see Global Constraints).

## Rulings Made in This Plan

- **Avatar** is a FriendFlix avatar key from the existing preset set (`web/src/lib/avatars.ts` `AVATARS`, validated like profiles: `/^[a-z0-9-]{1,20}$/`). It is stored in `users.avatar` and mirrored to the owner profile's `avatar`. There is no image upload and no Authentik avatar write: that would need file storage or a new dependency.
- **Name** is written to Authentik (`name`) when the Authentik API is configured, then to `users.name` and the owner profile name (`slice(0, 20)`, as `provisionUser` does). Without the API, the change is local only: the login callback never syncs names, so nothing overwrites it.
- **Self-service audits carry no personal values.** `account.profile` and `account.email` store `{ fields: [...] }` without from/to. Admin actions keep the from/to rule of phase 1.
- **"Manage on the sign-in page" URL** = `new URL(OIDC_ISSUER).origin + '/if/user/#/settings'`. `OIDC_ISSUER` is the browser-facing Authentik URL; `AUTHENTIK_URL` may be internal. It is null when the issuer is not an Authentik URL (`/application/o/` missing from its path).
- **An admin unlocking a deletion-locked account is a restore.** `unlockUser` clears `deletion_at` too, and when the previous `locked_reason` was `'deletion'` it also audits `user.deletion_restored`. Bulk unlock and `PATCH disabled:false` therefore restore. Phase 1's existing no-op checks stay: a manual lock on an already locked account changes nothing, and `setAccessUntil` only unlocks `'expired'`.
- **Admin "delete now"** is offered only for accounts already scheduled (`deletion_at` set). Deleting an arbitrary account straight from the admin side is not in the spec and is out of scope. It sets `deletion_at = now()`, and the next tick claims the account.
- **Self-deletion by an admin** is allowed unless they are the last active admin (`assertNotLastAdmin(ctx, [id], 'lock')` → 400 `last_admin`).
- **A tombstone table** `account_deletions` holds the snapshot the later steps need once the `users` row is gone: sub, media ids, request-service id, name/e-mail for scrubbing. The personal fields are nulled when the deletion finishes, and the pseudonym row stays so the audit views can resolve the name.
- **Pseudonym** = `deleted-` + the first 8 hex characters of `HMAC-SHA256(encKey, 'friendflix deleted v1|' + userId)`. It is stable and not reversible without the key.
- **Audit scrub (step 5):** in entries where `actor = id` or `target = id`, the meta keys `name`, `email`, `jellyfin`, `username` and `ip` are removed and `pseudonym` is added. The audit views show `coalesce(u.name, d.pseudonym)`.
- **Admin notices that link to the account** (`notifications.link = '/admin/users/<id>'`) are deleted in step 4. They carry the person's name.
- **During cleanup** (claimed, not finished) the login callback answers 403 `account_deleted` for that sub. Otherwise a sign-in between step 4 and step 6 would land in the approval queue.
- **Sessions & devices** reuse `GET /api/devices`, `DELETE /api/devices/:id` and `POST /api/sessions/revoke-others`. Device approval stays on `/devices`; the account page links there when devices are waiting.
- **Restore without a session:** a signed cookie `ff_restore` (HMAC like `ff_pending`, 15 min) and the `/restore` page. After restoring, the person signs in again through `/auth/login`; the IdP session is still alive, so this takes no extra prompt.
- **Export** needs an owner session but no re-authentication. It is rate-limited to 5 per hour.

## Review Focus

1. A deletion-pending account whose `access_until` passes during the grace period, and which is then restored, must end up locked as `expired` on the next tick, not active. (Test in Task 4.)
2. A restore racing the tick's claim at the 7-day boundary: exactly one wins. Either the account is active with no `account_deletions` row, or the claim exists and restore answers 409 `deletion_in_progress`. (Test in Task 5.)
3. A step that fails (media server down) leaves earlier steps done, is retried on the next tick from that step, and does not repeat the "started" audit or the admin notice. (Test in Task 5.)
4. A re-authentication callback whose `sub` differs from the session's user, for example a different Authentik account typed at the prompt, must not stamp `reauthAt`. (Test in Task 1.)
5. A list the user owns with items added by another member: the export contains the list and items but no other member's id or name. (Test in Task 3.)

---

### Task 1: Re-authentication guard

**Files:**
- Create `backend/src/reauth.ts`.
- Modify `backend/src/session.ts` (`Session.reauthAt?: number`) and `backend/src/routes/auth.ts` (`/auth/reauth` and a reauth branch in `/auth/callback`).
- Test: `backend/test/reauth.test.ts`.

**Interfaces (produces, also for phase 3):**
- `export const REAUTH_WINDOW_S = 600`
- `export function recentlyAuthenticated(s: Session, maxAgeS = REAUTH_WINDOW_S, now = Date.now()): boolean`
  - true iff `s.reauthAt` is set and `now - reauthAt <= maxAgeS * 1000` (and is not in the future by more than 30 s)
- `export function requireRecentAuth(ctx: Ctx, maxAgeS = REAUTH_WINDOW_S): preHandlerAsyncHookHandler`
  - Composes `requireOwner(ctx)`, then answers 401 `{ error: 'reauth_required' }` when the check fails.
  - This is the single gate phase 3 reuses.
- `export async function markReauthenticated(ctx: Ctx, sid: string, s: Session, now = Date.now()): Promise<boolean>`
  - Sets `s.reauthAt = now` and calls `saveSession(ctx, sid, s, true)` (never resurrects a revoked session).
  - This is the single producer phase 3 calls after its password screen.
- `GET /auth/reauth?next=<path>` (rate limit 10/min):
  - Needs a live `ff_sid` session, else 401.
  - Starts `startLogin(reply, undefined, 600)` with `forceLogin: true`. The saved kv state gets `reauth: { userId, next }`.
  - `next` must match `/^\/(?!\/)[A-Za-z0-9\/_?=&.-]{0,200}$/`, else `'/me/account'`.
- `/auth/callback` with `saved.reauth`:
  - `ctx.oidc.finish(…, { maxAge: REAUTH_MAX_AGE })` with `REAUTH_MAX_AGE = 120`, plus `freshAuth(claims.authTime, 120)`.
  - The session cookie must load to `saved.reauth.userId`, and that user's `authentik_sub` must equal `claims.sub`. Otherwise audit `session.reauth_mismatch` and redirect `/me/account?reauth=failed`.
  - On success: `markReauthenticated`, audit `session.reauth`, redirect `next`.
  - This branch never provisions, registers devices or creates sessions.
- [ ] Tests:
  - `recentlyAuthenticated is true at 600 s and false at 601 s`.
  - `requireRecentAuth answers 401 reauth_required without a stamp`, and passes with a fresh stamp (test route registered in the test).
  - `/auth/reauth without a session answers 401`.
  - `/auth/reauth starts a forced login`: fake `oidc.start` received `{ forceLogin: true }`.
  - `callback stamps reauthAt on the existing session and redirects to next`: same `ff_sid`, no new `sess:` key.
  - `callback with a different sub does not stamp` (Review Focus 4).
  - `stale auth_time does not stamp`.
  - `next=//evil.example falls back to /me/account`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(auth): recent re-authentication guard`.

### Task 2: Account API – profile, e-mail, 2FA state

**Files:**
- Create `backend/src/routes/account.ts` (registered where `authRoutes` is).
- Modify `backend/src/authentik.ts`.
- Test: `backend/test/account.test.ts` and extend `backend/test/authentik.test.ts`.

**Interfaces (produces):**
- In `authentik.ts`:
  - `akUpdateUser(ctx, sub, patch: { name?: string }): Promise<void>`
    - `PATCH api/v3/core/users/<pk>/`. Errors: 400 → `HttpError(400, 'invalid_input')`; 404 → `authentik_user_not_found` (drops the `akuser:`/`akmfa:` kv); not configured → 503 `authentik_unavailable`.
  - `akSetActive(ctx, sub, active: boolean): Promise<'done' | 'not_configured' | 'not_found'>`: `PATCH … { is_active }`.
  - `akUserSettingsUrl(cfg): string | null`: as in the rulings.
- Routes (all `requireOwner`):
  - `GET /api/account` →
    ```
    { name, email, avatar, mfa: MfaState | null, manageUrl: string | null, reauthUntil: number | null }
    ```
    - `reauthUntil` = `reauthAt + 600_000` when still valid.
    - Never `authentik_sub` or ids of the Authentik user.
  - `PATCH /api/account/profile { name?: string 1..60 trimmed, avatar?: avatarKey }`
    - Authentik first (when configured), then `users.name` / owner profile, in one transaction.
    - Audit `account.profile` with `{ fields }`.
    - An Authentik failure leaves FriendFlix unchanged and answers the Authentik code.
    - 501 `not_supported` without the API.
- `/api/me` stays unchanged.
- [ ] Tests:
  - `GET /api/account never contains authentik_sub, jellyfin_pw_enc or the API token`: JSON string check.
  - `mfa state and manageUrl from fake Authentik`, and `mfa null and manageUrl null without the API`.
  - `name change writes Authentik, users and the owner profile`.
  - `Authentik 400 on name change leaves the local name`.
  - `avatar is mirrored to the owner profile`.
  - `a non-owner profile gets 403 owner_required`.
  - `audit meta of account.profile has fields only`.
  - Authentik tests:
    - `akUpdateUser PATCHes the user pk with the bearer header`
    - `akSetActive maps 404 to not_found`
    - `token never in thrown messages`
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(account): profile and 2FA state`.

### Task 3: Download my data

**Files:**
- Create `backend/src/export.ts`.
- Add the route in `routes/account.ts`.
- Test: `backend/test/export.test.ts`.

**Interfaces (produces):**
- `exportUserData(ctx: Ctx, user: UserRow): AsyncGenerator<string>`: yields one JSON document in chunks, section by section, with explicit column allowlists (never `select *`).
- Top level: `{ format: 'friendflix-export', version: 1, exportedAt, account, profiles, lists, watchlist, ratings, history, requests, devices, notifications }`.
- `account`: `id, name, email, role, avatar, createdAt, accessUntil`.
- `profiles`: `id, name, avatar, kids, maxRating, isOwner, createdAt`. No `pin_hash`, `jellyfin_*`.
- `lists`:
  - Lists the user owns: name, theme fields, items (`itemId`, `addedAt`, and `addedByMe: boolean` instead of `added_by`).
  - Lists where the user is only a member: the name and only the items the user added. No member list.
- `watchlist`, `ratings`, thumbs and bookmarks per profile: item ids and dates. Reminders and series follows go here too, if the tables carry `user_id`/`profile_id`.
- `history`, per profile:
  - `ctx.jf.history(jfUserFor(user, p), { limit: 1000 })` mapped to `{ itemId, name, type, seriesName?, playedAt, positionSeconds, played }`
  - plus `play_seconds`/`play_daily` totals of the user's own rows
- `requests`: the user's own `seerr_requests` rows (`tmdbId`, `mediaType`, `status`, `createdAt`). The key is named `requests`, never "seerr".
- `devices`: `label, approved, createdAt, lastSeen`. No device ids.
- `notifications`: the user's prefs that concern notifications (from `user_prefs`/`profile_prefs`), `pushSubscriptions: <count>` (no endpoints or keys), and the user's own notification rows (`kind, title, createdAt, read`).
- The media server is down for history → `history: { error: 'unavailable' }`. The rest still exports.
- Route `GET /api/account/export` (`requireOwner`, rate limit 5/hour):
  - `content-type: application/json`, `content-disposition: attachment; filename="friendflix-data-<yyyy-mm-dd>.json"`, `cache-control: no-store`
  - `reply.send(Readable.from(exportUserData(ctx, user)))`
  - audit `account.export`
- [ ] Tests:
  - `export of A contains none of B's ids, names, e-mail, list names or notification titles`: two users with rows in every exported table; JSON.stringify over the parsed result.
  - `export never contains jellyfin_pw_enc, authentik_sub, pin_hash, push endpoints`: key and value scan.
  - `owned list with a member's item lists the item without the member` (Review Focus 5).
  - `history comes from the media server per profile`: fake `jf.history`.
  - `history failure still yields valid JSON with history.error`.
  - `response is streamed with attachment headers and parses as JSON`.
  - `export is audited`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(account): download my data`.

### Task 4: Schedule, restore and admin actions for deletion

**Files:**
- Modify `backend/src/db.ts` (migration 38).
- Create `backend/src/deletion.ts`.
- Modify `backend/src/users.ts` (`unlockUser`), `routes/account.ts` and `routes/adminUsers.ts`.
- Test: `backend/test/deletion.test.ts`.

**Migration 38 (produces):**
```
create table account_deletions (
  user_id uuid primary key,           -- no FK: the users row is deleted in step 4
  pseudonym text not null,
  step int not null default 0,        -- last completed step (0..6)
  authentik_sub text, jellyfin_ids text[], seerr_user_id int, name text, email text,  -- nulled when finished
  started_at timestamptz not null default now(), finished_at timestamptz,
  last_error text, failed_step int
);
create index account_deletions_sub on account_deletions(authentik_sub) where finished_at is null;
create index users_deletion_at on users(deletion_at) where deletion_at is not null;
```

**Interfaces (produces):**
- `export const GRACE_MS = 7 * 86400e3`
- `pseudonymFor(ctx: Pick<Ctx, 'encKey'>, userId: string): string`: as in the rulings, matching `/^deleted-[0-9a-f]{8}$/`.
- `scheduleDeletion(ctx, actor: string | null, userId: string, now = new Date()): Promise<Date>`
  - `assertNotLastAdmin(ctx, [userId], 'lock')`
  - `update users set deletion_at = now + GRACE_MS`
  - `lockUser(ctx, actor, userId, 'deletion')`
  - audit `user.deletion_requested` with `{ deletionAt, by: actor === userId ? 'self' : 'admin' }`
  - `notifyAdmins` with key `notify.deletion.requested` and `{ name, date }`, link `/admin/users/<id>`, dedupe `deletion-req-<id>-<iso>`. New `messages.ts` keys are added in all 7 languages by the task that first uses them (here `requested`, `restored`; Task 5 `done`, `failed`).
  - Returns the date.
- `restoreDeletion(ctx, actor: string | null, userId: string): Promise<void>`
  - Atomic `update users set deletion_at=null … where id=$1 and locked_reason='deletion' and not exists (select 1 from account_deletions where user_id=$1)`.
  - 0 rows → `HttpError(409, 'deletion_in_progress')` if a claim exists, else 404 `not_scheduled`.
  - Then `unlockUser`, audit `user.deletion_restored`, `notifyAdmins` `notify.deletion.restored` with `{ name }`.
- `unlockUser` (modified):
  - It also clears `deletion_at`, and refuses with 409 `deletion_in_progress` while an `account_deletions` row exists.
  - When the previous reason was `'deletion'`, it audits `user.deletion_restored`.
- Routes:
  - `POST /api/account/delete { confirm: z.literal(true) }`, preHandler `requireRecentAuth(ctx)`
    - Calls `scheduleDeletion(ctx, me, me)`, clears the `ff_sid` cookie, answers `{ deletionAt }`.
    - 400 `last_admin` for the last admin.
  - `POST /api/admin/users/:id/deletion/restore` → `restoreDeletion`.
  - `POST /api/admin/users/:id/deletion/now`
    - Self → 400 `cannot_lock_yourself_out`. Not scheduled → 409 `not_scheduled`.
    - Sets `deletion_at = now()`, audits `user.deletion_now`.
  - `GET /api/admin/users/:id` adds `deletionAt` to `user`.
- [ ] Tests:
  - `self-delete locks at once with reason deletion, revokes sessions and licences, notifies admins once`.
  - `delete needs recent auth`.
  - `last admin cannot self-delete; a second admin can`.
  - `admin unlock of a deletion-locked account restores it (deletion_at null, audited)`.
  - `manual lock on a deletion-locked account changes nothing`.
  - `setAccessUntil does not unlock a deletion lock`.
  - `expiry tick skips deletion-locked accounts`.
  - `restored account whose access_until passed is locked as expired by the next expiryTick` (Review Focus 1).
  - `admin delete-now sets deletion_at to now and refuses self`.
  - `pseudonymFor is stable and matches the pattern`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(account): delete with 7-day grace, restore and admin actions`.

### Task 5: Final deletion tick

**Files:**
- Modify `backend/src/deletion.ts` and `backend/src/server.ts`: call `deletionTick` in the same 60 s block as `expiryTick`, with its own busy flag and `jobFailed(ctx, app.log, 'account-deletion', …)`.
- Modify `backend/src/routes/auth.ts` (callback check), `backend/src/routes/admin.ts:343-356` and `backend/src/routes/adminUsers.ts:331` (audit name fallback), and `adminUsers.ts` user list (`status=deleting` cleanup rows).
- Test: `backend/test/deletion-tick.test.ts`.

**Interfaces (produces):** `deletionTick(ctx, now = new Date()): Promise<{ claimed: number; finished: number; failed: number }>`

- **Claim**, in one transaction:
  - `select … from users where locked_reason='deletion' and deletion_at <= $now for update skip locked`.
  - Insert `account_deletions` with the snapshot: `authentik_sub`, `accountJellyfinIds`, `seerr_user_id`, name, email, pseudonym. `on conflict do nothing`.
  - Audit `user.deletion_started` with `{ pseudonym }` (target = user id) once, on insert.
- **Steps.** Each unfinished row runs from `step + 1`. Each step must be safe to repeat. After success: `step = n`, `last_error = null`. On the first failure: store `last_error` (error code or class name only, never a message that could quote a URL or token) and `failed_step`, then stop that row until the next tick. A tick never throws because of one account.
  1. `ctx.jf.admin.deleteIdentity` for each `jellyfin_ids`. Owner and profile identities.
  2. When `ctx.cfg` has the request service configured and `seerr_user_id` is set: `ctx.seerr.deleteUser(id)`. A 404 counts as done. Without the request service: done.
  3. `revokeDownloads(ctx, userId)`. Idempotent; the lock already did it, repeated for safety.
  4. In one transaction:
     - `delete from notifications where link = '/admin/users/' || $id`
     - `delete from approval_requests where authentik_sub = $sub`
     - `delete from users where id = $id` (cascades profiles, lists, history rows, devices, push subscriptions, limits …)
     - then `kv.del` for `akuser:<sub>`, `akmfa:<sub>`, `pinfail:<id>`, `pinfail-acct:<id>`
  5. Scrub `audit_log` where `actor = $id or target = $id::text`: `meta = (meta - 'name' - 'email' - 'jellyfin' - 'username' - 'ip') || jsonb_build_object('pseudonym', $p)`.
  6. `akSetActive(ctx, sub, false)`. `'not_configured'` and `'not_found'` count as done, with `{ authentik }` recorded in the final audit.
- **Finish:**
  - `finished_at = now`; null out `authentik_sub, jellyfin_ids, seerr_user_id, name, email`.
  - Audit `user.deleted` with `{ pseudonym, authentik: 'deactivated' | 'not_configured' | 'not_found' }`.
  - `notifyAdmins` with key `notify.deletion.done` and `{ pseudonym }`.
- **First failure of a step:** `notifyAdmins` with key `notify.deletion.failed` and `{ pseudonym, step }`, dedupe `deletion-fail-<id>-<step>`. Audit `user.deletion_failed` with `{ step, error }` once per step (same dedupe via the notify result).
- **Login callback:** a sub with an unfinished `account_deletions` row → 403 `{ error: 'account_deleted' }`.
- **Audit views** (admin audit page, user detail audit tab): actor/target names are `coalesce(u.name, ad.pseudonym)` via `left join account_deletions ad on ad.user_id = a.actor` (and on `a.target`).
- **User list `status=deleting`:** also lists unfinished `account_deletions` whose users row is gone, as rows `{ id, name: pseudonym, cleanup: { step, error } }`. No e-mail.
- [ ] Tests (fake media server, request service and Authentik):
  - `full run deletes identities, request-service user, licences, rows, scrubs audit and deactivates Authentik`. Checks:
    - `deleteIdentity` was called for owner and profile ids
    - `users` row gone; cascaded tables empty for that id
    - audit entries have `pseudonym` and no `name`/`email`/`ip`
    - `PATCH is_active=false` was sent
  - `a failing step 1 is retried next tick; steps run once; started audit and failure notice once` (Review Focus 3).
  - `restore racing the claim: exactly one wins` (Review Focus 2): `Promise.all([restoreDeletion, deletionTick])` at `deletion_at = now`.
  - `request service 404 counts as done`.
  - `without the Authentik API the deletion finishes with authentik not_configured`.
  - `login during cleanup answers 403 account_deleted`.
  - `audit views show the pseudonym after deletion`.
  - `admin notices linking to the account are removed`.
  - `tick before deletion_at does nothing`.
  - `finished row keeps only pseudonym and dates`.
- [ ] Run them and see them fail. Implement. Run the whole backend suite. Commit `feat(account): resumable final deletion`.

### Task 6: Sign-in restore

**Files:**
- Modify `backend/src/routes/auth.ts`.
- Create `web/src/routes/restore/+page.svelte`.
- Test: `backend/test/deletion-restore.test.ts`.

**Interfaces (produces):**
- `export const RESTORE_COOKIE = 'ff_restore'` (httpOnly, signed `<userId>.<exp>.<mac>` with `createHmac('sha256', encKey)` over `'friendflix restore v1|' + userId + '|' + exp`, TTL 900 s, path `/`).
- **Callback:** for an existing user with `locked_reason='deletion'` and `deletion_at > now` and no claim, set the cookie and redirect to `/restore`. There is no session. All other disabled users keep the 403.
- `GET /api/restore` (cookie) → `{ state: 'scheduled', deletionAt } | { state: 'none' }`. No name or e-mail.
- `POST /api/restore` (cookie; requires `content-type: application/json`, so a cross-site form cannot post it; rate limit 10/min):
  - `restoreDeletion(ctx, userId, userId)`, clears the cookie, answers `{ ok: true }`.
  - 409 `deletion_in_progress` when the claim won.
- **`/restore` page:**
  - "Your account is scheduled for deletion on {date}. Restore it?" with a primary "Restore my account" and a secondary "Keep the deletion".
  - Restore: success, then "Sign in" (`/auth/login`).
  - Keep: back to `/`.
  - Plain, in 7 languages.
- [ ] Tests:
  - `signing in during the grace period redirects to /restore without a session`.
  - `POST /api/restore unlocks and the next login creates a session`.
  - `forged or expired restore cookie answers state none / 401`.
  - `form-encoded POST is refused`.
  - `after deletion_at the callback answers 403`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(auth): restore a scheduled deletion on sign-in`.

### Task 7: Web – account page (profile, security, sessions)

**Files:**
- Create `web/src/routes/me/account/+page.svelte` and components in `web/src/lib/account/`: `ProfileCard.svelte`, `SecurityCard.svelte`, `SessionsCard.svelte`, plus `reauth.ts` (helper `startReauth(next: string)` → `location.href = '/auth/reauth?next=' + encodeURIComponent(next)`, and `isReauthError(e)` for `ApiError` 401 `reauth_required`).
- Modify `web/src/routes/me/+page.svelte` (an "Account" row in the account group; owner profile only), `web/src/lib/api.ts` (types `Account`), the 7 `account.ts` locales and `e2e/mocks/api.ts`.
- e2e: `e2e/tests/account.spec.ts`, `e2e/tests/account.mobile.spec.ts`.

**Behaviour:**
- **Profile:**
  - Name field and avatar picker (the `AVATARS` swatches used by the profile editor), saved with PATCH.
  - E-mail: read-only, with the manage link (the change comes in phase 3).
- **Security:**
  - 2FA chips: authenticator app / passkey / recovery codes, each "on/off". `mfa === null` → "Not available".
  - The manage link "Manage on the sign-in page" (`manageUrl`, `target=_blank rel=noopener`), hidden when null.
  - A note: "Changing your password and 2FA in FriendFlix is coming." There are no password or 2FA actions.
- **Sessions & devices:**
  - List from `/api/devices` with the "This device" chip, last seen, and "Sign out" per other device (`DELETE /api/devices/:id`, confirm).
  - "Sign out all other devices" (`POST /api/sessions/revoke-others`, confirm, shows the count).
  - When devices are waiting: a link "Approve on Devices" to `/devices`.
- `?reauth=failed` shows "That sign-in did not match your account" (role=alert).
- [ ] e2e tests:
  - `account page shows profile, 2FA state and sessions`.
  - `saving the name sends PATCH and updates the header`.
  - `sign out all others shows the count`.
  - `manage link hidden when manageUrl is null`.
  - `mfa null shows not available`.
  - mobile: `cards stack and buttons are ≥ 44 px`.
  - a11y: `sections have headings, chips have names`.
- [ ] Run them and see them fail. Implement. Run e2e (account specs), web unit tests and `npm run typecheck -w web`. Commit `feat(web): account page with profile, security and sessions`.

### Task 8: Web – your data, delete account, restore, admin deletion actions

**Files:**
- Create `web/src/lib/account/DataCard.svelte` and `DeleteCard.svelte`, and add them to `/me/account`.
- `web/src/routes/restore/+page.svelte` (from Task 6) gets its e2e.
- Modify `web/src/routes/admin/users/[id]/+page.svelte` (status pill, actions) and `web/src/routes/admin/users/+page.svelte` (cleanup rows), the 7 `account.ts` and `adminPeople.ts` locales, and `e2e/mocks/api.ts` + `e2e/mocks/admin.ts`.
- e2e: extend `account.spec.ts`/`.mobile.spec.ts`, plus `admin-user-detail.spec.ts`.

**Behaviour:**
- **Your data:** "Download my data" is a plain `<a href="/api/account/export" download>`, so the browser streams it. Below it: one line on what it contains and that it holds only your own data.
- **Delete account:**
  1. The dialog first offers "Download my data" (the export link).
  2. It explains the 7 days, the restore by signing in, and that the sign-in account is deactivated.
  3. "Delete my account" needs recent auth: `startReauth('/me/account#delete')`. Back on the page with `#delete`, the dialog opens again.
  4. On confirm: POST, then show "Your account will be deleted on {date}", then `/` (the session is gone).
  - A `last_admin` error shows "You are the last admin – make someone else admin first."
- **Admin detail:**
  - The status pill shows "Deletion on {date}".
  - `MoreActions` adds "Restore account" and "Delete now". Delete now uses `confirm` with `danger` and lists the name. Both are shown only when `deletionAt` is set, and delete-now is hidden for yourself.
- **Admin list:** under the "Deletion pending" filter, cleanup rows show the pseudonym and "Cleanup step {n} of 6", plus the error when there is one. They are not selectable and have no link.
- [ ] e2e tests:
  - `download link points to the export`.
  - `delete asks for re-authentication, then confirms with the date`.
  - `delete as last admin shows the hint`.
  - `/restore restores and offers sign in`.
  - `admin restore and delete-now call the APIs`.
  - `cleanup row shows the pseudonym and step`.
  - mobile: `delete dialog fits the screen`.
- [ ] Run them and see them fail. Implement. Run e2e and svelte-check. Commit `feat(web): data export, account deletion and restore`.

### Task 9: Docs, i18n completeness and checks

**Files:**
- `docs/security.md`:
  - re-authentication (10 min, how phase 3 replaces it)
  - what the export contains
  - the deletion grace period and the 6 steps
  - the pseudonym
  - Authentik user deactivated, not deleted (deleting it is the owner's call, with the steps)
  - the account page's privacy note that admins can see watched titles (spec A2), which is also shown on `/me/account`
- `docs/authentik.md`:
  - the API token also needs "change user" (name, e-mail, `is_active`)
  - the user-settings link
  - e-mail changes are not re-verified in phase 2
- `docs/operations.md`: deletion pending, cleanup failures, admin restore/delete-now.
- README feature line (EN/DE), without new screenshots. Any screenshot use fictional titles only.
- CHANGELOG under Unreleased → Account.
- Verify that the backend `messages.ts` keys `notify.deletion.{requested,restored,done,failed}` (added in Tasks 4 and 5, all 7 languages) pass `backend/test/i18n-messages.test.ts`.
- [ ] Grep the new UI strings and locales for "Seerr" (expect none).
- [ ] Run the full checks:
  - `npm run lint`
  - `npm run typecheck -w web`
  - `npm run spdx:check`
  - `npm run coverage -w backend`
  - `npm run coverage -w web`
  - `npm run build -w web`
  - the desktop and mobile e2e for `account*` and `admin-user-detail*`
- [ ] Commit `docs: Block 23 phase 2 self-service`.
