// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { randomToken, sha256 } from './crypto.js';

export interface InviteRow {
  id: string;
  role: string;
  note: string | null;
  expires_at: Date;
  used_at: Date | null;
  authentik_invite: string | null;
}

export interface WarnLogger {
  warn(obj: object, msg: string): void;
}
const consoleLog: WarnLogger = { warn: (obj, msg) => console.warn(msg, obj) };

/** Names of the Authentik invitation settings that are missing, or null when invitations are off or fully configured. */
export function authentikConfigProblem(cfg: Ctx['cfg']): string[] | null {
  const keys = ['AUTHENTIK_URL', 'AUTHENTIK_API_TOKEN', 'AUTHENTIK_ENROLL_FLOW'] as const;
  const missing = keys.filter((k) => !cfg[k]);
  return missing.length && missing.length < keys.length ? [...missing] : null;
}

const akBase = (url: string) => url.replace(/\/$/, '');

/**
 * Where the invite page's "Konto anlegen" button leads: the Authentik enrollment flow with the
 * invitation token, and `next` pointing at the OIDC authorize request the portal already started,
 * so Authentik returns straight to /auth/callback after enrollment.
 * Authentik only follows a relative `next` (flows/views/executor.py `_flow_done`), hence path + query.
 */
export function enrollFlowUrl(cfg: Ctx['cfg'], akInvite: string, authorizeUrl?: string): string | undefined {
  if (!cfg.AUTHENTIK_URL || !cfg.AUTHENTIK_ENROLL_FLOW) return undefined;
  const u = new URL(`${akBase(cfg.AUTHENTIK_URL)}/if/flow/${encodeURIComponent(cfg.AUTHENTIK_ENROLL_FLOW)}/`);
  u.searchParams.set('itoken', akInvite);
  if (authorizeUrl) {
    const a = new URL(authorizeUrl);
    u.searchParams.set('next', a.pathname + a.search);
  }
  return u.toString();
}

export type AuthentikInviteStatus = 'off' | 'skipped' | 'ok' | 'failed';

/**
 * Creates an Authentik invitation bound to the enrollment flow. Never throws: failures are logged.
 * Not single_use: Authentik deletes a single-use invitation as soon as its stage passes, i.e. when the link is
 * merely *opened* - a friend who opens it on the phone and finishes on the laptop would be locked out. The portal
 * invite stays single-use (that is what grants access); the Authentik invitation expires with it and is deleted
 * by the portal once the invite is redeemed or revoked (deleteAuthentikInvitation).
 */
async function createAuthentikInvitation(ctx: Ctx, expiresAt: Date, log: WarnLogger): Promise<string | null> {
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: tok, AUTHENTIK_ENROLL_FLOW: flow } = ctx.cfg;
  if (!url || !tok || !flow) return null;
  const headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json' };
  const call = (path: string, init: RequestInit = {}) => ctx.fetchImpl(new URL(path, akBase(url) + '/'), { ...init, headers, signal: AbortSignal.timeout(10_000) });
  const detail = async (r: Response) => (await r.text().catch(() => '')).slice(0, 300);
  try {
    // Resolve the flow first: validates the slug and lets us bind the invitation to it.
    let flowPk: string | undefined;
    const f = await call(`api/v3/flows/instances/${encodeURIComponent(flow)}/`);
    if (f.ok) flowPk = ((await f.json()) as { pk?: string }).pk;
    else if (f.status === 404) {
      log.warn({ flow }, `Authentik enrollment flow "${flow}" not found (AUTHENTIK_ENROLL_FLOW must be the flow slug); invite created without Authentik enrollment`);
      return null;
    } else if (f.status === 401 || /token invalid|expired/i.test(await f.clone().text().catch(() => ''))) {
      log.warn({ status: 401, body: await detail(f) }, 'Authentik API rejected AUTHENTIK_API_TOKEN (expired, wrong intent or not an API token); invite created without Authentik enrollment');
      return null;
    } else {
      // e.g. 403: the token may create invitations without being allowed to view flows. Continue unbound.
      log.warn({ status: f.status, body: await detail(f) }, 'Authentik flow lookup failed; creating the invitation without flow binding');
    }
    // Authentik 2024.x - 2026.x: POST /api/v3/stages/invitation/invitations/ {name (slug), expires, single_use, fixed_data, flow (pk)}
    const r = await call('api/v3/stages/invitation/invitations/', {
      method: 'POST',
      body: JSON.stringify({
        name: `ff-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`,
        single_use: false,
        expires: expiresAt.toISOString(),
        fixed_data: {},
        ...(flowPk ? { flow: flowPk } : {}),
      }),
    });
    if (!r.ok) {
      const body = await detail(r);
      const hint = /token invalid|expired/i.test(body) ? ' (AUTHENTIK_API_TOKEN invalid or expired)' : r.status === 403 ? ' (the token user needs the "Can add Invitation" permission)' : '';
      log.warn({ status: r.status, body }, `Authentik invitation creation failed${hint}; invite created without Authentik enrollment`);
      return null;
    }
    const pk = ((await r.json()) as { pk?: string }).pk;
    if (!pk) log.warn({}, 'Authentik invitation response had no pk; invite created without Authentik enrollment');
    return pk ?? null;
  } catch (err) {
    log.warn({ err: String(err) }, 'Authentik unreachable; invite created without Authentik enrollment');
    return null;
  }
}

/** Best effort: removes the Authentik invitation once the portal invite is redeemed or revoked (it is reusable until then). */
export async function deleteAuthentikInvitation(ctx: Ctx, pk: string | null | undefined, log: WarnLogger = consoleLog) {
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: tok } = ctx.cfg;
  if (!pk || !url || !tok || !/^[\w-]{1,64}$/.test(pk)) return;
  try {
    const r = await ctx.fetchImpl(new URL(`api/v3/stages/invitation/invitations/${pk}/`, akBase(url) + '/'), {
      method: 'DELETE', headers: { authorization: `Bearer ${tok}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok && r.status !== 404) log.warn({ status: r.status }, 'Authentik invitation could not be deleted (token user needs "Can delete Invitation"); it expires with the portal invite');
  } catch (err) {
    log.warn({ err: String(err) }, 'Authentik unreachable while deleting an invitation; it expires with the portal invite');
  }
}

/**
 * `enroll: false` is for people who already have an Authentik account: no Authentik invitation,
 * the invite link only offers "Anmelden & freischalten".
 */
export async function createInvite(ctx: Ctx, createdBy: string, opts: { role: string; ttlHours: number; note?: string; enroll?: boolean }, log: WarnLogger = consoleLog) {
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + opts.ttlHours * 3600_000);
  const missing = authentikConfigProblem(ctx.cfg);
  if (missing) log.warn({ missing }, `Authentik invitations disabled: ${missing.join(', ')} not set`);
  const configured = Boolean(ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN && ctx.cfg.AUTHENTIK_ENROLL_FLOW);
  let authentik: AuthentikInviteStatus = 'off';
  let akId: string | null = null;
  if (configured && opts.enroll === false) authentik = 'skipped';
  else if (configured) {
    akId = await createAuthentikInvitation(ctx, expiresAt, log);
    authentik = akId ? 'ok' : 'failed';
  }
  const id = randomUUID();
  await ctx.db.query('insert into invites(id, token_hash, role, note, expires_at, created_by, authentik_invite) values ($1,$2,$3,$4,$5,$6,$7)', [
    id, sha256(token), opts.role, opts.note ?? null, expiresAt, createdBy, akId,
  ]);
  const base = ctx.cfg.PUBLIC_URL.replace(/\/$/, '');
  return {
    id, token, link: `${base}/invite/${token}`,
    /** portal entry that starts login and sends the person through Authentik enrollment */
    enrollUrl: akId ? `${base}/auth/enroll?invite=${token}` : undefined,
    authentik, expiresAt,
  };
}

/** Returns the invite if it exists, is unused and not expired. */
export async function lookupInvite(ctx: Ctx, token: string): Promise<InviteRow | null> {
  if (!/^[\w-]{20,80}$/.test(token)) return null;
  const r = await ctx.db.query<InviteRow>('select id, role, note, expires_at, used_at, authentik_invite from invites where token_hash=$1 and used_at is null and expires_at > now()', [sha256(token)]);
  return r.rows[0] ?? null;
}

/** Atomically consumes an invite (single use even under concurrent logins). */
export async function claimInvite(ctx: Ctx, token: string): Promise<InviteRow | null> {
  const r = await ctx.db.query<InviteRow>(
    'update invites set used_at = now() where token_hash=$1 and used_at is null and expires_at > now() returning id, role, note, expires_at, used_at, authentik_invite',
    [sha256(token)],
  );
  return r.rows[0] ?? null;
}

export async function releaseInvite(ctx: Ctx, id: string) {
  await ctx.db.query('update invites set used_at = null, used_by = null where id=$1', [id]);
}
