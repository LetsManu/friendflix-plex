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
import { secretTag } from './crypto.js';
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
export async function akForget(ctx: AkCtx, sub: string) {
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

/** An Authentik user with the OIDC subjects it can appear under (`uid` = hashed id, `uuid`), read fresh from the API. */
export type AkUserSubs = AkUser & { subs: string[] };

const subsOf = (u: RawUser) => [u.uid, u.uuid].filter((x): x is string => typeof x === 'string' && x.length > 0);

/**
 * The Authentik user with exactly this username (`GET /core/users/?username=`), uncached: the e-mail confirmation reads the address
 * Authentik holds right now. Null when the API is not configured or no such user exists.
 */
export async function akUserByUsername(ctx: AkCtx, username: string): Promise<AkUserSubs | null> {
  if (!configured(ctx)) return null;
  const r = await json<Page<RawUser>>(ctx, `api/v3/core/users/?${new URLSearchParams({ include_groups: 'false', username })}`);
  const found = r.results.find((u) => u.username === username);
  return found ? { ...toUser(found), subs: subsOf(found) } : null;
}

/** The Authentik users whose e-mail equals `email` (case-insensitive; the API's filter is narrowed again here). */
export async function akUsersByEmail(ctx: AkCtx, email: string): Promise<AkUser[]> {
  if (!configured(ctx)) throw new HttpError(503, 'authentik_unavailable');
  const r = await json<Page<RawUser>>(ctx, `api/v3/core/users/?${new URLSearchParams({ include_groups: 'false', email })}`);
  return r.results.filter((u) => (u.email ?? '').toLowerCase() === email.toLowerCase()).map(toUser);
}

export type DeviceType = 'totp' | 'static' | 'webauthn';
export interface AkDevice { id: string; type: DeviceType; name: string; lastUsed: string | null; confirmed: boolean }
interface RawDevice { pk?: string | number; name?: string; type?: unknown; confirmed?: boolean; last_used?: string | null }

/** 'totp' | 'static' | 'webauthn' from the device `type` ("authentik_stages_authenticator_totp.totpdevice", or an object naming app and model) */
function deviceKind(type: unknown): DeviceType | null {
  let t = '';
  if (typeof type === 'string') t = type;
  else if (type && typeof type === 'object') {
    const o = type as { app?: unknown; model_name?: unknown; meta_model_name?: unknown };
    t = typeof o.meta_model_name === 'string' ? o.meta_model_name : `${String(o.app ?? '')}.${String(o.model_name ?? '')}`;
  }
  t = t.toLowerCase();
  for (const k of ['totp', 'static', 'webauthn'] as const) if (t.includes(`authenticator_${k}.`)) return k;
  return null;
}

/** The user's TOTP, recovery-code and WebAuthn devices (`GET /authenticators/admin/all/?user=<pk>`, uncached); other device kinds are left out. */
export async function akDevices(ctx: AkCtx, sub: string): Promise<AkDevice[] | null> {
  if (!configured(ctx)) return null;
  const user = await akUserBySub(ctx, sub);
  if (!user) return null;
  const r = await json<RawDevice[] | Page<RawDevice>>(ctx, `api/v3/authenticators/admin/all/?user=${user.pk}`);
  const out: AkDevice[] = [];
  for (const d of Array.isArray(r) ? r : r.results) {
    const type = deviceKind(d.type);
    if (!type || d.pk === undefined || d.pk === null) continue;
    out.push({ id: String(d.pk), type, name: typeof d.name === 'string' ? d.name.slice(0, 100) : '', lastUsed: typeof d.last_used === 'string' ? d.last_used : null, confirmed: d.confirmed !== false });
  }
  return out;
}

/**
 * Removes one of the user's own devices. The device must be in the user's own list (`admin/all/?user=<pk>`, pks compared as strings),
 * else 404 `device_not_found`; then `DELETE authenticators/admin/<type>/<id>/` (204). The cached MFA state is dropped.
 */
export async function akDeleteDevice(ctx: AkCtx, sub: string, type: DeviceType, id: number): Promise<void> {
  const devices = await akDevices(ctx, sub);
  if (!devices) throw new HttpError(503, 'authentik_unavailable');
  if (!devices.some((d) => d.type === type && d.id === String(id))) throw new HttpError(404, 'device_not_found');
  try {
    await call(ctx, `api/v3/authenticators/admin/${type}/${id}/`, { method: 'DELETE' }, { 404: new HttpError(404, 'device_not_found') });
  } finally {
    await ctx.kv.del(`akmfa:${sub}`);
  }
}

/**
 * a flow lookup is kept this long; a failed one (Authentik unreachable, token rejected), a missing flow (the admin may import it any
 * minute) and a refused stage read (a permission the admin may grant) only briefly
 */
const FLOW_TTL = 600;
const FLOW_FAILED_TTL = 60;
const VALIDATE_MODEL = 'authentik_stages_authenticator_validate.authenticatorvalidatestage';

/**
 * one stage bound to a flow: the stage's pk, its model (`stage_obj.meta_model_name`, e.g. `authentik_stages_email.emailstage`) and, for
 * an authenticator-validate stage, what it does with people without a device. The bindings' `stage_obj` (the base StageSerializer)
 * never carries `not_configured_action`: it is read from the stage itself (`GET stages/authenticator/validate/<pk>/`).
 */
export interface FlowStage { pk: string; model: string; notConfiguredAction?: string }
/**
 * A flow as the checks need it. `stages` are in binding order and classified by `stage_obj.meta_model_name`: `stage_obj.component` is
 * the admin form's name (`ak-stage-email-form` on 2026.8.3), not the challenge component. `failed`: Authentik did not answer (or
 * rejected the token), so `exists` and `stages` are unknown.
 */
export interface FlowStages {
  exists: boolean; failed: boolean; stages: FlowStage[];
  /** a validate stage could not be read because the token lacks `view_authenticatorvalidatestage` (403): its settings are unknown */
  stageDenied?: boolean;
}
const NO_FLOW: FlowStages = { exists: false, failed: false, stages: [] };

/**
 * The one reader of a flow (`GET /flows/instances/<slug>/`, then `GET /flows/bindings/?target=<pk>`): whether it exists (the login page
 * offers "forgot password" only then, preflight P27), which stages it holds (the sign-in status check, the admin reset e-mail).
 * Cached under a hash of its inputs (AUTHENTIK_URL, the token, the slug): 10 min, an unreachable Authentik 1 min. Never throws: any
 * failure answers `failed: true`. Not configured -> not found.
 */
export async function akFlowStages(ctx: AkCtx, slug: string): Promise<FlowStages> {
  if (!configured(ctx)) return NO_FLOW;
  const key = akFlowCacheKey(ctx.cfg, slug);
  const hit = await ctx.kv.get(key);
  if (hit) {
    try {
      const v = JSON.parse(hit) as FlowStages;
      if (typeof v.exists === 'boolean' && Array.isArray(v.stages)) return v;
    } catch { /* a damaged entry: read again */ }
  }
  let out: FlowStages;
  let ttl = FLOW_TTL;
  try {
    const flow = await json<{ pk?: string }>(ctx, `api/v3/flows/instances/${encodeURIComponent(slug)}/`, undefined, { 404: new HttpError(404, 'not_found') });
    out = { exists: true, failed: false, stages: [] };
    if (typeof flow.pk === 'string' && flow.pk) {
      try {
        const r = await json<Page<{ order: number; stage: string; stage_obj?: { meta_model_name?: string } }>>(
          ctx, `api/v3/flows/bindings/?${new URLSearchParams({ target: flow.pk, ordering: 'order', page_size: '100' })}`);
        out.stages = [...r.results].sort((a, b) => a.order - b.order).map((b) => ({ pk: String(b.stage), model: b.stage_obj?.meta_model_name ?? '' }));
        for (const st of out.stages) {
          if (st.model !== VALIDATE_MODEL) continue;
          try {
            const v = await json<{ not_configured_action?: unknown }>(ctx, `api/v3/stages/authenticator/validate/${encodeURIComponent(st.pk)}/`, undefined,
              { 403: new HttpError(403, 'forbidden') });
            if (typeof v.not_configured_action === 'string') st.notConfiguredAction = v.not_configured_action;
          } catch (e) {
            if (!(e instanceof HttpError && e.statusCode === 403)) throw e;
            out.stageDenied = true; // the stage list is right; only this stage's settings are unknown
            ttl = FLOW_FAILED_TTL;
          }
        }
      } catch {
        out.failed = true; // the flow exists, its stages are unknown
        ttl = FLOW_FAILED_TTL;
      }
    }
  } catch (e) {
    out = e instanceof HttpError && e.statusCode === 404 ? NO_FLOW : { exists: false, failed: true, stages: [] };
    ttl = FLOW_FAILED_TTL; // missing or failed: looked at again within a minute
  }
  await ctx.kv.set(key, JSON.stringify(out), ttl);
  return out;
}

/** the kv key of a cached flow read (own prefix: the flow jars use `akflow:`) */
export const akFlowCacheKey = (cfg: Pick<Config, 'AUTHENTIK_URL' | 'AUTHENTIK_API_TOKEN'>, slug: string): string =>
  `akflowstages:${secretTag(cfg.AUTHENTIK_API_TOKEN)}:${encodeURIComponent(cfg.AUTHENTIK_URL ?? '')}:${encodeURIComponent(slug)}`;

/** Whether Authentik has a flow with this slug (an unreachable Authentik answers false); see akFlowStages. */
export async function akFlowExists(ctx: AkCtx, slug: string): Promise<boolean> {
  return (await akFlowStages(ctx, slug)).exists;
}

/**
 * The OAuth2 provider of an OIDC client id (`GET /providers/oauth2/?client_id=`) with its authorization flow's stages and grant types,
 * for the sign-in status check. null: not found, not configured or Authentik did not answer. `'forbidden'`: the token lacks
 * `view_oauth2provider` (Authentik answers 403), so the card can say so instead of showing nothing. Not cached (the check caches itself).
 */
export async function akOauthProvider(ctx: AkCtx, clientId: string): Promise<{ authorizationFlow: string | null; grantTypes: string[] | null } | 'forbidden' | null> {
  if (!configured(ctx)) return null;
  try {
    const r = await json<Page<{ authorization_flow?: string; authorization_flow_obj?: { slug?: string }; grant_types?: unknown }>>(
      ctx, `api/v3/providers/oauth2/?${new URLSearchParams({ client_id: clientId })}`, undefined, { 403: new HttpError(403, 'forbidden') });
    const p = r.results[0];
    if (!p) return null;
    const slug = p.authorization_flow_obj?.slug;
    return {
      authorizationFlow: typeof slug === 'string' ? slug : null,
      grantTypes: Array.isArray(p.grant_types) ? p.grant_types.map((g) => (typeof g === 'string' ? g : (g as { name?: string } | null)?.name ?? '')) : null,
    };
  } catch (e) {
    return e instanceof HttpError && e.statusCode === 403 ? 'forbidden' : null;
  }
}

/**
 * Whether the login flow forces a second factor: its authenticator-validate stage denies people without a device
 * (`not_configured_action === 'deny'`). Null when that cannot be told (no API, flow missing, Authentik down): callers then allow.
 */
export async function akMfaMandatory(ctx: AkCtx): Promise<boolean | null> {
  if (!configured(ctx)) return null;
  const flow = await akFlowStages(ctx, ctx.cfg.AUTHENTIK_LOGIN_FLOW || 'default-authentication-flow'); // the one reader and its cache (P27)
  if (flow.failed || !flow.exists || flow.stageDenied) return null;
  return flow.stages.some((s) => s.model.includes('authenticator_validate') && s.notConfiguredAction === 'deny');
}

/**
 * The browser-facing address of an Authentik flow (`<issuer origin>/if/flow/<slug>/`; AUTHENTIK_URL may be an internal address).
 * Null when the issuer is no Authentik provider URL.
 */
export function akFlowUrl(cfg: Pick<Config, 'OIDC_ISSUER'>, slug: string): string | null {
  let u: URL;
  try {
    u = new URL(cfg.OIDC_ISSUER);
  } catch {
    return null;
  }
  return u.pathname.includes('/application/o/') ? `${u.origin}/if/flow/${encodeURIComponent(slug)}/` : null;
}

const notConfigured = () => new HttpError(409, 'recovery_not_configured');

/** The first e-mail stage bound to the flow (by binding order). 409 `recovery_not_configured` without flow or stage. */
async function emailStageOf(ctx: AkCtx, slug: string): Promise<string> {
  const flow = await akFlowStages(ctx, slug);
  if (flow.failed) throw new HttpError(503, 'authentik_unavailable');
  const stage = flow.stages.find((b) => b.model === 'authentik_stages_email.emailstage')?.pk;
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
    if (e instanceof HttpError && e.statusCode === 404) await akForget(ctx, sub); // a stale pk (user deleted / re-created in Authentik)
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
    if (e instanceof HttpError && e.statusCode === 404) await akForget(ctx, sub);
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
