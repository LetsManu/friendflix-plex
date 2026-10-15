// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomToken, sha256 } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import { readMeta, updateMeta } from '../settings/repo.js';
import { isSetupComplete, SETUP_SESSION_PREFIX } from './state.js';

/**
 * The one-time setup code (spec Part E2). The backend that owns the background jobs issues it at start while setup is incomplete and
 * prints it once, in the line of setupCodeLogLine; only its sha256 is stored, it is compared in constant time, and it never appears in
 * an answer, an error or any other log line. A valid code opens a setup session (cookie ff_setup + the readable ff_setup_csrf).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: 32 symbols, so `byte & 31` is unbiased
const CODE_LEN = 12;
export const CODE_TTL_MS = 24 * 3600_000;
/** global wrong attempts until the code is invalidated (the route limits each IP to 5 per 15 min on top) */
export const MAX_FAILURES = 10;
export const SETUP_COOKIE = 'ff_setup';
export const SETUP_CSRF_COOKIE = 'ff_setup_csrf';
export const SETUP_CSRF_HEADER = 'x-ff-setup-csrf';
const SESSION_TTL_S = 7200;

/** A new code: `display` (XXXX-XXXX-XXXX, 60 bits) for the log line, `hash` (sha256 of the normalised code) for the database. */
export function newSetupCode(): { display: string; hash: string } {
  const raw = [...randomBytes(CODE_LEN)].map((b) => ALPHABET[b & 31]).join('');
  return { display: raw.match(/.{4}/g)!.join('-'), hash: sha256(raw) };
}

/** What a person types, as stored: upper case without spaces and dashes; O reads as 0, I and L as 1. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Replaces the code (every start does): the new hash, valid for 24 h, failures back to 0. Returns the display form for the log. */
export async function issueSetupCode(ctx: Pick<Ctx, 'db'>, now = new Date()): Promise<string> {
  const { display, hash } = newSetupCode();
  await updateMeta(ctx.db, { setupCodeHash: hash, setupCodeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), setupCodeFailures: 0 });
  return display;
}

/** The one log line that carries the code. */
export function setupCodeLogLine(display: string, expiresAt: Date): string {
  const iso = expiresAt.toISOString();
  return `FriendFlix setup: open the portal in your browser and enter the setup code ${display} (valid until ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC). Restart the backend for a new code.`;
}

/** At start: issues and logs a new code when this instance runs the background jobs and setup is incomplete; returns it (null = none). */
export async function announceSetupCode(ctx: Pick<Ctx, 'db' | 'settings' | 'cfg'>, log: { warn(msg: string): void }, now = new Date()): Promise<string | null> {
  if (ctx.cfg.BACKGROUND_JOBS !== 'true' || (await isSetupComplete(ctx))) return null;
  const display = await issueSetupCode(ctx, now);
  log.warn(setupCodeLogLine(display, new Date(now.getTime() + CODE_TTL_MS)));
  return display;
}

/** constant-time string comparison (byte lengths compared first: timingSafeEqual needs equal lengths) */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Log = { warn(o: object, msg: string): void; info(o: object, msg: string): void };
const quiet: Log = { warn: () => {}, info: () => {} };

/**
 * Checks a typed code. A wrong one counts against the global limit in one statement (concurrent attempts all count; the one that reaches
 * MAX_FAILURES clears the hash). Only codes and the client IP are logged, never the input.
 */
export async function verifySetupCode(ctx: Pick<Ctx, 'db'>, input: string, ip: string, log: Log = quiet): Promise<'ok' | 'wrong' | 'expired' | 'locked' | 'no_code' | 'complete'> {
  const m = await readMeta(ctx.db);
  if (m.setupCompletedAt) return 'complete';
  // no hash and no failures: no code was ever issued (no instance runs with BACKGROUND_JOBS=true), not a lockout
  if (!m.setupCodeHash) return m.setupCodeFailures === 0 ? 'no_code' : 'locked';
  if (!m.setupCodeExpiresAt || m.setupCodeExpiresAt.getTime() <= Date.now()) return 'expired';
  if (safeEqual(sha256(normalizeCode(input)), m.setupCodeHash)) return 'ok';
  // counted against the code that was compared: a code issued meanwhile starts at 0
  const r = await ctx.db.query<{ failures: number; cleared: boolean }>(`
    update settings_meta set setup_code_failures = setup_code_failures + 1,
      setup_code_hash = case when setup_code_failures + 1 >= $2 then null else setup_code_hash end
    where id = 1 and setup_code_hash = $1 and setup_completed_at is null
    returning setup_code_failures as failures, setup_code_hash is null as cleared`, [m.setupCodeHash, MAX_FAILURES]);
  const row = r.rows[0];
  if (!row) return (await readMeta(ctx.db)).setupCodeHash ? 'wrong' : 'locked';
  if (row.cleared) {
    log.warn({ ip }, 'Too many wrong setup codes; restart the backend for a new code');
    return 'locked';
  }
  log.info({ ip, failures: row.failures }, 'wrong setup code');
  return 'wrong';
}

const sessKey = (token: string) => `${SETUP_SESSION_PREFIX}${sha256(token)}`;

/** Opens a setup session: a random token in ff_setup (httpOnly) and a CSRF token in ff_setup_csrf (readable), kv by the token's hash. */
export async function createSetupSession(ctx: Pick<Ctx, 'kv'>, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = randomToken();
  const csrf = randomToken();
  await ctx.kv.set(sessKey(token), JSON.stringify({ csrf, createdAt: Date.now() }), SESSION_TTL_S);
  // PUBLIC_URL may not exist yet: Secure follows the request itself (x-forwarded-proto behind the proxy)
  const secure = req.protocol === 'https';
  // Lax, not Strict (spec E2): the IdP's redirect back to /auth/callback is cross-site when Authentik runs on another site, and the gate
  // needs this cookie there. Writes stay protected by x-ff-setup-csrf, which a cross-site page cannot set (ff_setup_csrf stays Strict).
  reply.setCookie(SETUP_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
  reply.setCookie(SETUP_CSRF_COOKIE, csrf, { httpOnly: false, sameSite: 'strict', secure, path: '/' });
}

/** The request's setup session (its CSRF token), refreshing the 2 h sliding TTL; null = none. */
async function loadSetupSession(ctx: Pick<Ctx, 'kv'>, req: FastifyRequest): Promise<{ csrf: string } | null> {
  const token = req.cookies[SETUP_COOKIE];
  if (!token || token.length > 128) return null;
  const key = sessKey(token);
  const raw = await ctx.kv.get(key);
  if (!raw) return null;
  await ctx.kv.replace(key, raw, SESSION_TTL_S);
  const { csrf } = JSON.parse(raw) as { csrf?: unknown };
  return typeof csrf === 'string' ? { csrf } : null;
}

export async function hasSetupSession(ctx: Pick<Ctx, 'kv'>, req: FastifyRequest): Promise<boolean> {
  return (await loadSetupSession(ctx, req)) !== null;
}

/**
 * The request's setup session as sha256 of its token (the name of its kv key, never the token), or null without a valid one. The first
 * admin's login saves it in the OIDC state, and the callback takes the setup branch only for the same setup session.
 */
export async function setupSessionHash(ctx: Pick<Ctx, 'kv'>, req: FastifyRequest): Promise<string | null> {
  return (await loadSetupSession(ctx, req)) ? sha256(req.cookies[SETUP_COOKIE]!) : null;
}

/** Whether the request carries the setup session whose hash is `hash` (constant time). */
export async function isSetupSession(ctx: Pick<Ctx, 'kv'>, req: FastifyRequest, hash: unknown): Promise<boolean> {
  const mine = await setupSessionHash(ctx, req);
  return typeof hash === 'string' && mine !== null && safeEqual(mine, hash);
}

/**
 * preHandler of the setup-session endpoints: 409 setup_complete once setup is done (whatever the cookies), 401 without a session, and for
 * every other method than GET the header x-ff-setup-csrf must equal both the session's token and the ff_setup_csrf cookie (403 csrf).
 */
export function requireSetupSession(ctx: Pick<Ctx, 'kv' | 'db' | 'settings'>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    // a cached "complete" is final; a cached "incomplete" may be outdated for up to the 30 s poll (a lost bus message), so a write (they
    // are rare) then reads the database itself: a setup session must not change settings once an admin exists
    const complete = (await isSetupComplete(ctx)) || (write && (await readMeta(ctx.db)).setupCompletedAt !== null);
    if (complete) return reply.code(409).send({ error: 'setup_complete' });
    const s = await loadSetupSession(ctx, req);
    if (!s) return reply.code(401).send({ error: 'setup_session_required' });
    if (!write) return;
    const sent = String(req.headers[SETUP_CSRF_HEADER] ?? '');
    const cookie = req.cookies[SETUP_CSRF_COOKIE] ?? '';
    if (!safeEqual(sent, s.csrf) || !safeEqual(cookie, s.csrf)) return reply.code(403).send({ error: 'csrf' });
  };
}
