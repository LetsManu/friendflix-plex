// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Why an Authentik call failed, in a form that may be logged and shown to admins: an error class, the upstream HTTP status and the
 * endpoint path without its query (numeric ids replaced by `:id`). Never a token, cookie, URL host, query string or response body.
 *
 * Both Authentik clients (authentik.ts for the admin API, akflow.ts for the flow executor) throw `AkUpstreamError`, an HttpError that
 * carries this failure; the routes log it (`{route, code, cls, status, endpoint}`) and `noteAkFailure` keeps the latest one per area for
 * 24 h, which the sign-in status card shows (Admin → Status → Sign-in).
 */
import type { Ctx } from './ctx.js';
import { HttpError } from './users.js';

/**
 * - `network`: no answer at all (DNS, refused, reset, TLS); `timeout`: no answer within the deadline
 * - `token_invalid`: 401/403 "Token invalid/expired" (the service token was deleted, expired or mistyped)
 * - `permission`: 403 for a valid token (the service account lacks a permission)
 * - `not_found`: 404; `http_error`: any other non-2xx
 * - `non_json`: a 2xx/3xx answer that is no JSON (an HTML page: a proxy, a login wall, a bot check); `too_large`: a body over the limit
 * - `redirect`: a redirect away from the executor (another host or path, e.g. http → https or an interface URL); `bad_answer`: JSON
 *   without the expected shape, or a redirect loop
 */
export type AkFailClass = 'network' | 'timeout' | 'token_invalid' | 'permission' | 'not_found' | 'http_error' | 'non_json' | 'too_large' | 'redirect' | 'bad_answer';
export type AkArea = 'api' | 'executor';
export interface AkFailure { area: AkArea; cls: AkFailClass; status?: number; endpoint: string }
export interface AkFailureSeen extends AkFailure { at: string }

export const AK_FAIL_CLASSES: readonly AkFailClass[] = ['network', 'timeout', 'token_invalid', 'permission', 'not_found', 'http_error', 'non_json', 'too_large', 'redirect', 'bad_answer'];

/** an HttpError (the code the routes answer) that also says why Authentik failed */
export class AkUpstreamError extends HttpError {
  constructor(statusCode: number, code: string, readonly failure: AkFailure) {
    super(statusCode, code);
  }
}

/** `/api/v3/core/users/12/?search=x` → `api/v3/core/users/:id/`: no query, no ids, no leading path of AUTHENTIK_URL */
export function endpointOf(path: string): string {
  const p = path.split(/[?#]/)[0] ?? '';
  const at = p.indexOf('api/v3/');
  const tail = at >= 0 ? p.slice(at) : p.replace(/^\/+/, '');
  return tail.split('/').map((s) => (/^\d+$/.test(s) ? ':id' : s)).join('/').slice(0, 120);
}

/** a fetch failure as a class: an AbortSignal timeout is `timeout`, anything else `network` (the cause text is never kept) */
export function fetchFailClass(err: unknown): 'timeout' | 'network' {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

/** 401/403: whether Authentik says the token itself is bad (its `detail` text, compared, never kept) */
export function deniedClass(status: number, detail: unknown): 'token_invalid' | 'permission' {
  if (status === 401) return 'token_invalid';
  return typeof detail === 'string' && /token invalid|expired|not provided|invalid token/i.test(detail) ? 'token_invalid' : 'permission';
}

const key = (area: AkArea) => `akdiag:last:${area}`;
const TTL_S = 86_400;

/** keeps the latest failure of its area for 24 h (never throws) */
export async function noteAkFailure(ctx: Pick<Ctx, 'kv'>, f: AkFailure): Promise<void> {
  try {
    await ctx.kv.set(key(f.area), JSON.stringify({ ...f, at: new Date().toISOString() }), TTL_S);
  } catch { /* diagnostics only */ }
}

/** the latest failure per area (24 h), for the status card */
export async function lastAkFailures(ctx: Pick<Ctx, 'kv'>): Promise<AkFailureSeen[]> {
  const out: AkFailureSeen[] = [];
  for (const area of ['executor', 'api'] as const) {
    try {
      const raw = await ctx.kv.get(key(area));
      const v = raw ? (JSON.parse(raw) as AkFailureSeen) : null;
      if (v && AK_FAIL_CLASSES.includes(v.cls) && typeof v.endpoint === 'string') out.push(v);
    } catch { /* a damaged entry: left out */ }
  }
  return out;
}

/** the log fields of an error (empty for anything that is not an AkUpstreamError) */
export const akLogFields = (err: unknown): Partial<AkFailure> =>
  err instanceof AkUpstreamError ? { area: err.failure.area, cls: err.failure.cls, status: err.failure.status, endpoint: err.failure.endpoint } : {};
