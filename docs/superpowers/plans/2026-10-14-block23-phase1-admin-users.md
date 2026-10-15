# Block 23 Phase 1 – Admin User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins manage every account in one place: a rebuilt user list with bulk actions and approval/invite tabs, a user detail page, per-user limits, access-until with automatic lock, and an approval queue for first logins without an invite.

**Architecture:** Additive migrations on top of `users`/`invites`. A new `limits.ts` overlays per-user limits on `effectiveRole` and replaces it at every enforcement point. New admin endpoints sit in a new `routes/adminUsers.ts`, and the expiry check is a minute timer. The web side gets a rebuilt `/admin/users` with tabs and a new `/admin/users/[id]` page using the existing UI kit (`DataTable`, `StatusPill`, `MoreActions`, `confirm`, `runAction`).

**Tech Stack:** Fastify + zod + Postgres (backend), SvelteKit (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-block23-user-management-design.md` (Part A; Part B and Part C are later phases)

## Global Constraints

- Migrations: append to `MIGRATIONS` in `backend/src/db.ts` only, with a `// N: reason` comment. Never edit old entries.
- Every admin change calls `audit(ctx, actor, action, target, meta)` with from/to values.
- No admin can lock, demote or delete themselves. The last active admin (`role='admin' and not disabled`) cannot be demoted or locked. Error codes: `cannot_lock_yourself_out` (existing) and `last_admin` (new).
- All new UI strings go in all 7 locales (`web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/adminPeople.ts`). No user-facing text says "Seerr".
- Media-server calls only go through `ctx.jf` (keeps the Plex seam). Authentik calls only go through the new `backend/src/authentik.ts`.
- No new dependencies.
- Backend tests: `backend/test/*.test.ts` with `makeEnv`/`resetDb` from `backend/test/helpers.ts` (Postgres at `TEST_DATABASE_URL`, default `postgres://postgres@localhost:5433/ff_test`). e2e: `e2e/tests/admin-people*.spec.ts` with the mocks in `e2e/mocks/admin.ts`.
- Coverage thresholds must hold. Lint, typecheck and spdx:check must be clean.

## Rulings Against the Spec

- **Requests:** the existing limit is per **month** (`requestlimit.ts`, `role_settings.requests_per_month`), so the per-user override is `requests_per_month`, not per week.
- **Pending users** do not get a `users` row (`jellyfin_user_id` is NOT NULL). They live in `approval_requests` until they are approved; approving runs the existing `provisionUser`.
- **`last_active`** stays computed from `devices` (as today). There is no new column.
- **Approval notice to the user:** FriendFlix has no SMTP of its own and a pending person has no push subscription. `/pending` therefore polls its own status (signed cookie) and shows "approved – sign in" or the rejection message. There is no e-mail in phase 1.
- **Activity** comes from the media server via `ctx.jf.history`, per profile.

## Review Focus

1. Extending an account that was locked **manually** must not unlock it. Only `locked_reason='expired'` unlocks. (Test in Task 4.)
2. The same person logs in again while pending: there is exactly one `approval_request` and no duplicate notice. (Test in Task 5.)
3. Two people claim the last use of an invite with `max_uses=2` at the same time: exactly one succeeds. (Test in Task 6.)
4. A per-user stream limit below the running sessions refuses new starts but does not kill running ones. (Test in Task 2.)
5. A bulk "role → friend" that includes the last admin is refused as a whole, with `last_admin`, and nothing changes. (Test in Task 3.)

---

### Task 1: Migration

**Files:** Modify `backend/src/db.ts` (append one migration). Test: `backend/test/block23-migration.test.ts`.

**Produces:** these columns and tables, which later tasks rely on:
- `users`: `access_until timestamptz`, `expiry_notified_at timestamptz`, `locked_reason text` (`'manual' | 'expired' | 'deletion'`, null when active), `deletion_at timestamptz`, `avatar text`
- `user_limits(user_id uuid pk references users on delete cascade, max_streams int, remote_bitrate int, max_downloads int, download_max_height int, requests_per_month int, updated_at timestamptz default now())`
- `approval_requests(id uuid pk, authentik_sub text unique not null, email text, name text not null, requested_at timestamptz default now(), notified_at timestamptz, rejected_at timestamptz, reject_message text)`
- `invites`: `max_uses int not null default 1`, `uses int not null default 0`, `access_days int`
- `invite_uses(invite_id uuid references invites on delete cascade, user_id uuid references users on delete cascade, at timestamptz default now(), primary key(invite_id, user_id))`
- Backfill: `update invites set uses = 1 where used_at is not null`, and insert existing `used_by` into `invite_uses`.

- [ ] Test `block23 migration adds columns and backfills invite uses`: after `resetDb()`, insert an invite with `used_at`/`used_by` *before* the new migration index. Use the `migrate(pool, upTo)` param if it exists; otherwise assert on a fresh DB that the columns exist (query `information_schema.columns`) and that `uses` defaults to 0.
- [ ] Run it and see it fail. Implement. Run it and see it pass. Commit `feat(db): Block 23 user management schema`.

### Task 2: Per-user limits

**Files:** Create `backend/src/limits.ts`; modify the callers listed below. Test: `backend/test/limits.test.ts`.

**Interfaces (produces):**
- `type UserLimits = { maxStreams: number | null; remoteBitrate: number | null; maxDownloads: number | null; downloadMaxHeight: number | null; requestsPerMonth: number | null }`
- `getUserLimits(ctx, userId): Promise<UserLimits>` (all null when there is no row)
- `setUserLimits(ctx, userId, l: UserLimits): Promise<void>` (all null deletes the row)
- `effectiveLimits(ctx, user: { id: string; role: string }): Promise<RoleTemplate & { requestsPerMonth: number }>`
  - Role from `effectiveRole`, then each non-null user field overrides: `maxStreams`, `remoteMaxBitrate ← remoteBitrate`, `maxDownloads`, `downloadMaxHeight`, `requestsPerMonth`.
  - Cache 30 s per (ctx, userId), like `effectiveRole`. `invalidateLimits(userId?)` clears it.

**Callers to switch to `effectiveLimits(ctx, user)`:**
- streams: `routes/media.ts` (~277-318), `routes/cast.ts` (~31-40)
- the gateway cap: `routes/internal.ts` `lookup()` (~83, `remoteBitrateCap`)
- downloads: `downloads.ts` (`roleAllowsDownloads`, `downloadHeightCap`, the quota at ~259) and `routes/downloads.ts` (32, 73, 85)
- requests: `requestlimit.ts` `limitFor`
- `/api/me` `limits` (`routes/auth.ts` ~143)

`applyRole` (Jellyfin policy, `MaxActiveSessions`) gets the effective `maxStreams` too.

- [ ] Tests:
  - `effectiveLimits overlays only set fields`: role friend with maxStreams 2; user row maxStreams 1 gives 1, while other fields equal the role.
  - `limits cache is invalidated on set`.
  - `a user stream limit refuses a new start but keeps running ones`: two live sessions, limit set to 1. `POST /api/items/:id/playback` gives the existing `too_many_streams` error, and the live sessions are still listed. (Review Focus 4.)
  - `gateway authz uses the user remote cap`: `/internal/authz` from a non-home IP returns `maxBitrate = user remoteBitrate`.
  - `request limit uses the user override`.
  - `download quota uses the user override`.
- [ ] Run them and see them fail. Implement and switch the callers. Run the whole backend suite. Commit `feat(limits): per-user overrides on top of the role`.

### Task 3: Account actions, guards, bulk

**Files:** Create `backend/src/routes/adminUsers.ts` (registered next to `routes/admin.ts`); move the user PATCH/revoke routes there. Modify `backend/src/users.ts`. Test: `backend/test/admin-users.test.ts` (keep `admin-people.test.ts` passing).

**Interfaces (produces):**
- In `users.ts`:
  - `lockUser(ctx, actor, userId, reason: 'manual' | 'expired' | 'deletion'): Promise<void>`: today's disable path (Jellyfin `setDisabled` for `accountJellyfinIds`, `users.disabled=true`, `locked_reason`, `revokeSessions`), audited `user.disable` with `{ reason }`.
  - `unlockUser(ctx, actor, userId): Promise<void>`
  - `setRole(ctx, actor, userId, role)`: today's role path.
  - `assertNotLastAdmin(ctx, userIds: string[], change: 'demote' | 'lock'): Promise<void>`: throws `HttpError(400, 'last_admin')` when the change leaves no active admin.
- Routes:
  - `PATCH /api/admin/users/:id` with `{ role?, disabled?, accessUntil?: string | null }`
  - `POST /api/admin/users/bulk` with `{ ids: uuid[] (1..200), action: 'role' | 'lock' | 'unlock' | 'revoke' | 'access', role?, accessUntil?: string | null }`. It is all-or-nothing on validation and guard errors, then applies per user. Answer: `{ done: number }`.
  - `GET /api/admin/users` gains:
    - filters `status=active|locked|pending|expiring|deleting`; `pending` lists `approval_requests` mapped to rows with `pending: true`
    - `lastActive=7|30|90`
    - columns `access_until`, `profiles` (count), `devices` (count), `locked_reason`
- [ ] Tests:
  - `lockUser sets reason and revokes sessions`.
  - `last admin cannot be demoted or locked`, also in bulk, where nothing changes. (Review Focus 5.)
  - `cannot lock yourself out` (existing).
  - `bulk role change audits each user with from/to`.
  - `PATCH accessUntil stores and audits user.access`.
  - `status=expiring lists accounts whose access ends within 7 days`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(admin): user actions, bulk and last-admin guard`.

### Task 4: Access until – expiry tick

**Files:** Create `backend/src/expiry.ts`; modify `backend/src/server.ts` (a 60 s timer in the always-on block, wrapped by `jobFailed`) and `backend/src/notify.ts` (add `notifyAdmins(ctx, notice: Omit<Notice, 'userId'>)`, which loops over active admins like `healthcheck.ts:86`). Test: `backend/test/expiry.test.ts`.

**Interfaces (produces):** `expiryTick(ctx, now = new Date()): Promise<{ warned: number; locked: number }>`
- Accounts with `access_until` between now and now + 3 days and `expiry_notified_at is null`:
  - `notify` the user with key `notify.access.soon` and params `{ date }`; `notifyAdmins` with `notify.access.soonAdmin` and `{ name, date }`.
  - Set `expiry_notified_at`.
- Accounts with `access_until <= now`, not disabled:
  - `lockUser(ctx, null, id, 'expired')`
  - notify with `notify.access.ended` and `notify.access.endedAdmin`
  - audit `user.expired`
- Extending via PATCH/bulk `accessUntil` resets `expiry_notified_at`. If `locked_reason='expired'` and the new date is in the future (or null), it calls `unlockUser`.
- Notification texts go in the backend i18n for all 7 languages, where the `notify.*` keys live.

- [ ] Tests:
  - `warns once 3 days before`: run the tick twice, expect one notice.
  - `locks on the day and notifies`.
  - `extending an expired account unlocks it`.
  - `extending a manually locked account keeps it locked`. (Review Focus 1.)
  - `null access_until never expires`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(users): access-until with notices and automatic lock`.

### Task 5: Approval queue

**Files:** Modify `backend/src/routes/auth.ts` (callback, the `no_invite` branch) and `adminUsers.ts`. Create `web/src/routes/pending/+page.svelte`. Test: `backend/test/approval.test.ts`.

**Interfaces (produces):**
- Callback without an invite, for a new non-admin user:
  - Upsert `approval_requests` on `authentik_sub` (name, email from claims).
  - On first insert only: `notifyAdmins` with key `notify.approval.new` and `{ name }`, link `/admin/users?tab=pending`, then set `notified_at`.
  - Set an httpOnly signed cookie `ff_pending=<request id>` (30 days) and redirect to `/pending`, with no session.
  - A login of a rejected person clears `rejected_at`/`reject_message`. They ask again; this notifies admins again only if the rejection is older than 24 h.
- `GET /api/pending` (cookie): `{ state: 'pending' | 'approved' | 'rejected' | 'none', message? }`. "approved" means the cookie's sub now exists in `users`.
- `GET /api/admin/approvals` lists the requests.
- `POST /api/admin/approvals/:id/approve` with `{ role (INVITABLE_ROLES or admin), accessUntil?: string | null }`. It runs `provisionUser` with those claims, sets `access_until`, deletes the request, audits `user.approved`, and stores the e-mail in `pending_notice` kv, so the next login lands normally.
- `POST /api/admin/approvals/:id/reject` with `{ message?: string ≤ 300 }`. It sets `rejected_at`/`reject_message`, audits `user.rejected` and hides the request from the list. Rejected rows older than 30 days are deleted by the expiry tick.
- `/pending` page: "Your access request was sent. An admin will approve it soon." It polls `/api/pending` every 30 s. Approved shows a "Sign in" button; rejected shows the message. Plain, in 7 languages.
- [ ] Tests:
  - `login without invite creates one approval request and notifies admins once`: two logins give one row and one notice. (Review Focus 2.)
  - `approve provisions the account with role and access-until; /api/pending answers approved`.
  - `reject hides the request and /api/pending shows the message`.
  - `admin-group members are still auto-created` (existing behaviour).
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(auth): approval queue for logins without an invite`.

### Task 6: Invites with uses and access days

**Files:** Modify `backend/src/invites.ts`, the invite routes (`routes/admin.ts` 338-378 move to `adminUsers.ts`) and `users.ts` (`provisionUser` takes `accessUntil?`). Test: extend `backend/test/invites.test.ts`.

**Interfaces:**
- `POST /api/admin/invites` accepts `maxUses` (1..50, default 1), `accessDays` (1..3650 | null) and `note`. The answer adds `uses` and `maxUses`.
- `claimInvite` atomically does `update invites set uses = uses + 1 where id = $1 and uses < max_uses and (expires_at is null or expires_at > now()) returning ...`. `used_at`/`used_by` are kept for the first use, for compatibility. `invite_uses` gets a row after provisioning, and `releaseInvite` decrements and deletes it.
- A new account from an invite with `access_days` gets `access_until = now + access_days`.
- `GET /api/admin/invites/:id/uses` lists the accounts made from the invite.
- [ ] Tests:
  - `an invite with maxUses 2 is claimable twice, the third claim fails`.
  - `two parallel claims of the last use: exactly one succeeds` (`Promise.all` of two `claimInvite`). (Review Focus 3.)
  - `accessDays sets access_until on the new account`.
  - `release returns the use`.
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(invites): multi-use invites with access days`.

### Task 7: User detail API and Authentik client

**Files:** Create `backend/src/authentik.ts`; add routes to `adminUsers.ts`. Test: `backend/test/admin-user-detail.test.ts` and `backend/test/authentik.test.ts`.

**Interfaces (produces):**
- `authentik.ts`, all of which return `null` or throw `HttpError(503, 'authentik_unavailable')` when `AUTHENTIK_URL`/`AUTHENTIK_API_TOKEN` are missing. It reuses `akBase` from `invites.ts`, with a 5 s timeout. The token never goes into logs or errors.
  - `akUserBySub(ctx, sub): Promise<{ pk: number; username: string; email: string } | null>`, via `GET /api/v3/core/users/?uuid=` or `?search=`. Use the OIDC `sub`: Authentik's default sub mode is the hashed user id, so match it on the `uid` field of `/core/users/`.
  - `akMfaState(ctx, sub): Promise<{ totp: boolean; webauthn: boolean; static: boolean } | null>`, via `GET /api/v3/authenticators/admin/all/?user=<pk>`, cached 10 min in kv.
  - `akSendRecovery(ctx, sub): Promise<void>`, via `POST /api/v3/core/users/<pk>/recovery_email/?email_stage=<uuid>`. The stage is resolved from `AUTHENTIK_RECOVERY_FLOW` (default `default-recovery-flow`): its first `ak-stage-email` binding.
  - `akSendMfaSetup(ctx, sub)`: the same mechanism, with the flow slug from `AUTHENTIK_TOTP_SETUP_FLOW` (default `default-authenticator-totp-setup`), via `GET /api/v3/flows/instances/<slug>/execute/` link generation if available. Otherwise `HttpError(501, 'not_supported')`, and the UI hides the action.
- New optional config keys in `config.ts`: `AUTHENTIK_RECOVERY_FLOW`, `AUTHENTIK_TOTP_SETUP_FLOW`.
- Routes:
  - `GET /api/admin/users/:id`. Answer:
    ```
    { user: { id, name, email, role, disabled, lockedReason, accessUntil, createdAt, lastActive, avatar },
      mfa: {...} | null,
      totals: { d7: { hours, streams }, d30: {...}, all: {...}, downloads, requests },
      linked: { jellyfin: { ok: boolean, username }, requests: { ok: boolean, id } | null },
      profiles: [{ id, name, kids, maxRating, avatar, lastUsed }],
      devices: [{ id, name, lastSeen, approved, sessions }],
      licenses: [...viewLicenses shape] }
    ```
    - Totals come from `play_seconds`. Streams are counted from the existing playback stats table, if one exists; otherwise `streams` is omitted.
  - `GET /api/admin/users/:id/activity?limit=50`: per profile, `ctx.jf.history` of that profile's media identity (reuse how `req.jfUser` is built from `jellyfin_pw_enc` / profiles), merged and sorted. It audits `user.activity_viewed`.
  - `GET /api/admin/users/:id/audit?limit&offset`: `audit_log where target=$id or actor=$id`.
  - `GET|PUT /api/admin/users/:id/limits` (Task 2 functions; audits `user.limits` with from/to).
  - `POST /api/admin/users/:id/repair`: re-apply role (`applyRole` for `accountJellyfinIds`) and re-link the request-service user with the existing link function. Audits `user.repair`.
  - `POST /api/admin/users/:id/sessions/:deviceId/revoke`: `revokeSessions(ctx, id, deviceId)`.
  - `POST /api/admin/users/:id/recovery` and `/mfa-setup`: the Authentik functions, audited.
  - `PATCH /api/admin/users/:id/profiles/:pid` with `{ name?: string 1..30, resetPin?: true }`. It uses the existing profile update / PIN functions in `profiles.ts` and audits `profile.admin_update`. The owner profile name stays tied to the account name.
- [ ] Tests:
  - `detail returns totals, profiles, devices, licences`.
  - `activity view is audited`.
  - `audit tab lists both target and actor entries`.
  - `repair re-applies the role`.
  - `revoke one device only`.
  - `admin renames a profile and resets its PIN`.
  - Authentik, with the `fakeHttp` handlers:
    - mfa state mapping
    - recovery calls the right URL with the token header
    - missing config gives null or 503
    - the token never appears in a thrown message
- [ ] Run them and see them fail. Implement. Run them and see them pass. Commit `feat(admin): user detail API and Authentik actions`.

### Task 8: Web – user list with tabs and bulk actions

**Files:** Rewrite `web/src/routes/admin/users/+page.svelte`. Move the invites UI into `web/src/lib/admin/InvitesPanel.svelte` (from `admin/invites/+page.svelte`); `admin/invites/+page.ts` redirects to `/admin/users?tab=invites`. Create `web/src/lib/admin/ApprovalsPanel.svelte`. Extend `web/src/lib/admin/people.ts` (pure helpers) and its test. Update the 7 locale files. e2e: extend `e2e/tests/admin-people.spec.ts` and `e2e/mocks/admin.ts`.

**Behaviour:**
- Tabs "Users | Waiting for approval (n) | Invites", stored in the URL `?tab=`.
- Users table:
  - Columns: avatar, name, e-mail, role, profiles, devices, last active, 2FA (only when the detail API reports mfa; the list shows "–"), access until.
  - Row checkbox. The bulk bar appears with a selection: change role, lock, unlock, set access-until (date or +30/+90 days or unlimited), sign out everywhere. Each asks `confirm` with the names (max 10 shown, then "+n").
  - The name links to `/admin/users/<id>`.
  - Filters: role, status (incl. expiring/pending), last active.
- Approvals: approve with a role `Select` and an optional access-until; reject with an optional message.
- Invites: today's UI plus max uses, access days, uses shown as "1/3", QR code (render as SVG with the existing QR helper if there is one; otherwise as a link only and ledger it) and the expandable list of accounts made from the invite.
- [ ] Tests:
  - Unit (`people.test.ts`): `bulkSummary(names)` returns "A, B, C +2"; `accessPreset('+30', now)` returns the date.
  - e2e (desktop + mobile):
    - `bulk lock two users asks and calls the bulk API`
    - `approval tab approves with role`
    - `invites tab creates a 3-use invite and shows 0/3`
    - `old /admin/invites redirects`
- [ ] Run them and see them fail. Implement. Run the web unit tests, e2e admin-people and svelte-check. Commit `feat(web): user list with approvals, invites and bulk actions`.

### Task 9: Web – user detail page

**Files:** Create `web/src/routes/admin/users/[id]/+page.svelte` and small tab components in `web/src/lib/admin/user/`: `Overview.svelte`, `Profiles.svelte`, `Devices.svelte`, `Downloads.svelte`, `Activity.svelte`, `Limits.svelte`, `Audit.svelte`. Update the 7 locales. e2e: `e2e/tests/admin-user-detail.spec.ts` with mock endpoints.

**Behaviour:**
- Header: avatar, name, e-mail, role, status pill (active / locked: reason / expires `date`), 2FA chips.
- Quick actions in `MoreActions`: lock/unlock, sign out everywhere, change role, extend access (+30, +90, date, unlimited), send password reset, send 2FA setup. The Authentik actions are hidden when `mfa === null`.
- Tabs are in the URL `?tab=`. The Activity tab only loads when opened, which writes the audit entry. It shows a one-line note: "Viewing is recorded in the audit log".
- Limits: one number field per limit with the role value as placeholder ("as role: 2"); empty means role. Save is a PUT.
- Linked accounts: health dots and a "Repair" button.
- Profiles tab: rename inline and "Reset PIN" (with confirm).
- Phone layout: tabs scroll horizontally, and tables become cards (same pattern as the existing mobile admin tables).
- [ ] e2e tests:
  - `detail shows header and totals`
  - `activity tab loads only when opened`
  - `limits save sends only changed fields`
  - `extend access +30 days`
  - `password reset button hidden without Authentik`
  - mobile: `tabs scroll and cards render`
  - a11y: `tablist has names`
- [ ] Run them and see them fail. Implement. Run e2e and svelte-check. Commit `feat(web): user detail page`.

### Task 10: Docs, banner and changelog

**Files:**
- `docs/security.md`: admins can see watched titles; viewing is audited.
- `docs/authentik.md`: the API token permissions, the recovery flow and SMTP in the e-mail stage (the owner's steps from chat: blueprint `example/flows-recovery-email-verification.yaml`, brand recovery flow, "Use global connection settings" off).
- `docs/operations.md`: access-until, approval queue, invites with uses.
- README feature line (EN/DE) and CHANGELOG under Unreleased → Admin.
- Health banner: a new issue `approvals:pending` (level warn, reason `pending_approvals`, `{ n }`) when requests exist, in `health.ts` `buildSnapshot`, with texts in 7 languages and a unit test in `web/src/lib/admin/banner.test.ts` and a backend health test.
- [ ] Run the full checks:
  - `npm run lint`
  - `npm run typecheck -w web`
  - `npm run spdx:check`
  - `npm run coverage -w backend`
  - `npm run coverage -w web`
  - `npm run build -w web`
  - the desktop e2e for the admin specs
- [ ] Commit `docs: Block 23 phase 1 admin user management`.
