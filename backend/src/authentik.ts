// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentik admin API client for the user detail and account pages: find a portal account's Authentik user, its MFA devices,
 * send it a password-reset e-mail, change its name and (de)activate it. Every Authentik call except the invitation ones (invites.ts) goes through this module.
 *
 * Errors are HttpErrors with a code only (`authentik_unavailable`, `authentik_token_rejected`, `authentik_error`, ...):
 * neither the API token nor Authentik's response body ever ends up in a message, so they cannot leak into logs or answers.
 * Lookups answer null when the Authentik API is not configured; actions throw 503 `authentik_unavailable`.
 */
import type { Config } from './config.js';
import type { Ctx } from './ctx.js';
import { akBase } from './invites.js';
import { HttpError } from './users.js';

type AkCtx = Pick<Ctx, 'cfg' | 'kv' | 'db' | 'fetchImpl'>;
/** `isActive`: Authentik's is_active, when the list answered it */
export interface AkUser { pk: number; username: string; email: string; isActive?: boolean }
export interface MfaState { totp: boolean; webauthn: boolean; static: boolean }

const TIMEOUT_MS = 5_000;
const MFA_TTL = 600;
const USER_TTL = 3600;
/** "no Authentik user for this sub" is remembered briefly, so the detail page does not page the user list on every view */
const MISSING_TTL = 300;
/** user list pages scanned for a hashed sub before giving up (100 users per page) */
const MAX_PAGES = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const configured = (ctx: AkCtx) => Boolean(ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN);

/** One API call. Network failure / timeout -> 503; 401/403 -> 502 `authentik_token_rejected`; other non-2xx -> 502 (or `expect` maps it). */
async function call(ctx: AkCtx, path: string, init: RequestInit = {}, expect: Partial<Record<number, HttpError>> = {}): Promise<Response> {
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: tok } = ctx.cfg;
  if (!url || !tok) throw new HttpError(503, 'authentik_unavailable');
  let r: Response;
  try {
    r = await ctx.fetchImpl(new URL(path, akBase(url) + '/'), {
      ...init,
      headers: { authorization: `Bearer ${tok}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, 'authentik_unavailable'); // the cause may quote the request (headers): never attached
  }
  if (r.ok) return r;
  await r.body?.cancel().catch(() => undefined);
  const mapped = expect[r.status];
  if (mapped) throw mapped;
  throw new HttpError(502, r.status === 401 || r.status === 403 ? 'authentik_token_rejected' : 'authentik_error');
}

async function json<T>(ctx: AkCtx, path: string, init?: RequestInit, expect?: Partial<Record<number, HttpError>>): Promise<T> {
  const r = await call(ctx, path, init, expect);
  try {
    return (await r.json()) as T;
  } catch {
    throw new HttpError(502, 'authentik_error');
  }
}

/** Drops the cached lookup of a user Authentik no longer knows (deleted / re-created): looked up again next time. */
async function forget(ctx: AkCtx, sub: string) {
  await ctx.kv.del(`akuser:${sub}`);
  await ctx.kv.del(`akmfa:${sub}`);
}

interface Page<T> { pagination?: { next?: number }; results: T[] }
interface RawUser { pk: number; username: string; email?: string; uid?: string; uuid?: string; is_active?: boolean }
const toUser = (u: RawUser): AkUser =>
  ({ pk: u.pk, username: u.username, email: u.email ?? '', ...(typeof u.is_active === 'boolean' ? { isActive: u.is_active } : {}) });

/**
 * The Authentik user behind an OIDC `sub`. Authentik's default subject mode is the hashed user id, which the API shows as
 * `uid` (it is not a filter): a uuid sub (mode "user UUID") is looked up with `?uuid=`, otherwise the account's e-mail
 * narrows the search (`?search=`) and, failing that, the user list is paged. Matches only on `uid` / `uuid`. Cached 1 h
 * (a miss 5 min). `emailHint` stands in for the account's e-mail once the users row is gone (the deletion tick passes the
 * tombstone's e-mail).
 */
export async function akUserBySub(ctx: AkCtx, sub: string, emailHint?: string | null): Promise<AkUser | null> {
  if (!configured(ctx)) return null;
  const key = `akuser:${sub}`;
  const hit = await ctx.kv.get(key);
  if (hit) return JSON.parse(hit) as AkUser | null;
  const match = (rows: RawUser[]) => rows.find((u) => u.uid === sub || u.uuid === sub);
  const list = (q: Record<string, string>) => json<Page<RawUser>>(ctx, `api/v3/core/users/?${new URLSearchParams({ include_groups: 'false', ...q })}`);

  let found: RawUser | undefined;
  if (UUID_RE.test(sub)) found = match((await list({ uuid: sub })).results);
  if (!found) {
    const email = (await ctx.db.query<{ email: string | null }>('select email from users where authentik_sub=$1', [sub])).rows[0]?.email ?? emailHint;
    if (email) found = match((await list({ search: email })).results);
  }
  for (let page = 1; !found && page <= MAX_PAGES; page++) {
    const r = await list({ page: String(page), page_size: '100' });
    found = match(r.results);
    if (!r.pagination?.next) break;
  }
  if (!found) {
    await ctx.kv.set(key, 'null', MISSING_TTL);
    return null;
  }
  const user = toUser(found);
  await ctx.kv.set(key, JSON.stringify(user), USER_TTL);
  return user;
}

/**
 * Which kinds of MFA devices the user has (`GET /authenticators/admin/all/?user=<pk>`, cached 10 min).
 * The device `type` is "<app>.<model>", e.g. authentik_stages_authenticator_totp.totpdevice; unconfirmed devices do not count.
 */
export async function akMfaState(ctx: AkCtx, sub: string): Promise<MfaState | null> {
  if (!configured(ctx)) return null;
  const key = `akmfa:${sub}`;
  const hit = await ctx.kv.get(key);
  if (hit) return JSON.parse(hit) as MfaState;
  const user = await akUserBySub(ctx, sub);
  if (!user) return null;
  const r = await json<Array<{ type?: string; confirmed?: boolean }> | Page<{ type?: string; confirmed?: boolean }>>(ctx, `api/v3/authenticators/admin/all/?user=${user.pk}`);
  const types = (Array.isArray(r) ? r : r.results).filter((d) => d.confirmed !== false).map((d) => (d.type ?? '').toLowerCase());
  const has = (kind: string) => types.some((t) => t.includes(`authenticator_${kind}.`));
  const state: MfaState = { totp: has('totp'), webauthn: has('webauthn'), static: has('static') };
  await ctx.kv.set(key, JSON.stringify(state), MFA_TTL);
  return state;
}

const notConfigured = () => new HttpError(409, 'recovery_not_configured');

/** The first `ak-stage-email` stage bound to the flow (by binding order). 409 `recovery_not_configured` without flow or stage. */
async function emailStageOf(ctx: AkCtx, slug: string): Promise<string> {
  const flow = await json<{ pk: string }>(ctx, `api/v3/flows/instances/${encodeURIComponent(slug)}/`, undefined, { 404: notConfigured() });
  const r = await json<Page<{ order: number; stage: string; stage_obj?: { component?: string } }>>(
    ctx, `api/v3/flows/bindings/?${new URLSearchParams({ target: flow.pk, ordering: 'order', page_size: '100' })}`);
  const stage = [...r.results].sort((a, b) => a.order - b.order).find((b) => b.stage_obj?.component === 'ak-stage-email')?.stage;
  if (!stage) throw notConfigured();
  return stage;
}

/**
 * Sends the user Authentik's password-reset e-mail: `POST /core/users/<pk>/recovery_email/` with `{email_stage}` (the first
 * e-mail stage of AUTHENTIK_RECOVERY_FLOW). Authentik builds the link from the brand's recovery flow and sends it through that
 * stage's SMTP settings. Its answers:
 * - 400 (ValidationError: no brand recovery flow, user without e-mail, stage missing or not viewable) -> 409 `recovery_not_configured`
 * - 404 (user pk unknown or not viewable by the token) -> 404 `authentik_user_not_found`, the cached lookup is dropped
 * - 405 (releases where the action was GET only) -> 501 `not_supported`
 */
export async function akSendRecovery(ctx: AkCtx, sub: string): Promise<void> {
  if (!configured(ctx)) throw new HttpError(503, 'authentik_unavailable');
  const user = await akUserBySub(ctx, sub);
  if (!user) throw new HttpError(404, 'authentik_user_not_found');
  const stage = await emailStageOf(ctx, ctx.cfg.AUTHENTIK_RECOVERY_FLOW || 'default-recovery-flow');
  // the stage goes as query parameter (older releases) and as body (newer ones take a serializer); each ignores the other
  try {
    await call(ctx, `api/v3/core/users/${user.pk}/recovery_email/?${new URLSearchParams({ email_stage: stage })}`,
      { method: 'POST', body: JSON.stringify({ email_stage: stage }) },
      { 400: notConfigured(), 404: new HttpError(404, 'authentik_user_not_found'), 405: new HttpError(501, 'not_supported') });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) await forget(ctx, sub); // a stale pk (user deleted / re-created in Authentik)
    throw e;
  }
}

/** `PATCH /core/users/<pk>/`; 404 -> 404 `authentik_user_not_found` (cache dropped), other errors as `call()` maps them. */
async function patchUser(ctx: AkCtx, sub: string, body: Record<string, unknown>, expect: Partial<Record<number, HttpError>> = {}, emailHint?: string | null): Promise<void> {
  const user = await akUserBySub(ctx, sub, emailHint);
  if (!user) throw new HttpError(404, 'authentik_user_not_found');
  try {
    await call(ctx, `api/v3/core/users/${user.pk}/`, { method: 'PATCH', body: JSON.stringify(body) },
      { ...expect, 404: new HttpError(404, 'authentik_user_not_found') });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) await forget(ctx, sub);
    throw e;
  }
}

/**
 * Changes the user's display name in Authentik (the account page). 400 (Authentik rejects the value) -> 400 `invalid_input`;
 * 404 -> `authentik_user_not_found`; without the API 503 `authentik_unavailable`.
 */
export async function akUpdateUser(ctx: AkCtx, sub: string, patch: { name?: string }): Promise<void> {
  if (!configured(ctx)) throw new HttpError(503, 'authentik_unavailable');
  await patchUser(ctx, sub, patch, { 400: new HttpError(400, 'invalid_input') });
}

/**
 * Activates / deactivates the Authentik user (account deletion deactivates, never deletes). Other failures throw.
 * A user already in the wanted state (is_active from the lookup; the caller drops the cached lookup first) is done without a
 * PATCH, so a token without `change_user` works once the user was deactivated by hand.
 * `emailHint`: see akUserBySub (the account's users row may already be deleted).
 */
export async function akSetActive(ctx: AkCtx, sub: string, active: boolean, emailHint?: string | null): Promise<'done' | 'not_configured' | 'not_found'> {
  if (!configured(ctx)) return 'not_configured';
  try {
    const user = await akUserBySub(ctx, sub, emailHint);
    if (!user) return 'not_found';
    if (user.isActive === active) return 'done';
    await patchUser(ctx, sub, { is_active: active }, {}, emailHint);
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) return 'not_found';
    throw e;
  }
  return 'done';
}

/**
 * Authentik's own user settings page ("Manage on the sign-in page"): the browser-facing issuer origin plus `/if/user/#/settings`
 * (AUTHENTIK_URL may be an internal address). It needs no API token. Null when the issuer is no Authentik provider URL.
 */
export function akUserSettingsUrl(cfg: Pick<Config, 'OIDC_ISSUER'>): string | null {
  let u: URL;
  try {
    u = new URL(cfg.OIDC_ISSUER);
  } catch {
    return null;
  }
  return u.pathname.includes('/application/o/') ? `${u.origin}/if/user/#/settings` : null;
}

/**
 * "Send a 2FA setup link" is not possible through the Authentik API: `GET /flows/instances/<slug>/execute/` returns a link
 * for the token's own user (the service account), not for another user, and there is no "send setup e-mail" endpoint.
 * So this answers 501 `not_supported` (503 without the API) and the UI hides the action. AUTHENTIK_TOTP_SETUP_FLOW
 * (default default-authenticator-totp-setup) is kept for the in-app setup flow of a later phase.
 */
export async function akSendMfaSetup(ctx: AkCtx, _sub: string): Promise<void> {
  if (!configured(ctx)) throw new HttpError(503, 'authentik_unavailable');
  throw new HttpError(501, 'not_supported');
}

/** Whether the Authentik actions can be offered at all (the UI hides them otherwise). */
export const akActions = (ctx: AkCtx) => ({ recovery: configured(ctx), mfaSetup: false });
