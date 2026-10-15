// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Ctx } from '../ctx.js';
import { akBase } from '../invites.js';
import { mediaSettings } from '../media/index.js';
import { MEDIA_SETUP } from '../media/setup.js';
import { SeerrClient, SeerrError } from '../seerr/client.js';
import { testSourceKey } from '../sources/omdb.js';
import { byCode, byStatus, fail, httpUrl, join, OK, smallJson, type ProbeCode, type ProbeResult } from './probeKit.js';
import type { ProbeId } from './registry.js';

/**
 * Live checks of a candidate configuration (Admin -> Settings "Test" and every save, spec Part I). A probe calls the service with the
 * candidate values and answers a code only: an upstream body or error text (which may quote a URL with a token) never leaves this module.
 * Probes that send a credential never follow a redirect (`redirect: 'manual'`), so a key is only ever sent to the host the admin entered.
 */
export type { ProbeCode, ProbeResult };

export const PROBE_TIMEOUT_MS = 5_000;
const MEDIA_KEYS = mediaSettings().map((d) => d.key);

/** Hard failures block a save even with force; unreachable / timeout block unless the admin chose "Save anyway". */
const HARD: ReadonlySet<ProbeCode> = new Set(['unauthorized', 'invalid', 'not_admin', 'issuer_mismatch', 'wizard_pending']);
export function probeBlocks(r: ProbeResult, force: boolean): boolean {
  if (r.ok) return false;
  return HARD.has(r.code) || !force;
}

/** Whether the candidate holds anything for the probe to test; an unconfigured optional service is not probed on save. */
export function probeConfigured(id: ProbeId, cfg: Config): boolean {
  const c = cfg as Record<string, unknown>;
  const any = (...keys: string[]) => keys.some((k) => Boolean(c[k]));
  switch (id) {
    case 'publicUrl': return any('PUBLIC_URL');
    case 'media': return any(...MEDIA_KEYS);
    case 'oidc': return any('OIDC_ISSUER');
    case 'authentik': return any('AUTHENTIK_URL', 'AUTHENTIK_API_TOKEN');
    case 'requests': return any('REQUESTS_URL', 'REQUESTS_API_KEY');
    case 'tmdb': return any('TMDB_API_KEY');
    case 'omdb': return any('OMDB_API_KEY');
    case 'portainer': return any('PORTAINER_WEBHOOK_URL', 'PORTAINER_URL', 'PORTAINER_API_KEY');
    case 'github': return any('GITHUB_TOKEN');
  }
}

const isTimeout = (e: unknown) => {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};

interface Runner {
  /** a fetch that never follows redirects and is aborted at the probe's deadline */
  fetch: typeof fetch;
  /** runs fn within the deadline: a timeout or a thrown error becomes a code */
  within(fn: () => Promise<ProbeResult>): Promise<ProbeResult>;
}

function runner(fetchImpl: typeof fetch, timeoutMs: number): Runner {
  const ac = new AbortController();
  const f = ((input: RequestInfo | URL, init: RequestInit = {}) =>
    fetchImpl(input, { ...init, redirect: 'manual', signal: ac.signal })) as typeof fetch;
  return {
    fetch: f,
    async within(fn) {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<ProbeResult>((res) => {
        timer = setTimeout(() => { ac.abort(); res(fail('timeout')); }, timeoutMs);
      });
      const run = fn().catch((e: unknown) => fail(isTimeout(e) ? 'timeout' : 'unreachable'));
      try {
        return await Promise.race([run, limit]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Reaches this backend through the public URL (spec Part F step 2): stores a nonce with a random answer in kv (shared by every instance)
 * and fetches <origin>/api/setup/echo/<nonce>; only the stored answer counts, so a host that reflects the request does not pass. A
 * mismatch is a warning (NAT loopback often fails inside the network), never a blocker; so is http (cookies not secure, cast and passkeys off).
 */
async function publicUrl(ctx: Ctx, f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const base = httpUrl(cfg.PUBLIC_URL);
  if (!base) return fail('invalid', 'invalid_url');
  const nonce = randomBytes(32).toString('base64url');
  const answer = randomBytes(16).toString('base64url');
  const key = `setup:echo:${nonce}`;
  await ctx.kv.set(key, answer, 60);
  try {
    const r = await f(new URL(`/api/setup/echo/${nonce}`, base.origin), { headers: { accept: 'application/json' } });
    const body = r.ok ? await smallJson(r) : (void r.body?.cancel().catch(() => undefined), null);
    if ((body as { answer?: unknown } | null)?.answer !== answer) return { ok: true, code: 'warning', detail: 'echo_mismatch' };
  } finally {
    await ctx.kv.del(key).catch(() => undefined);
  }
  return base.protocol === 'http:' ? { ok: true, code: 'warning', detail: 'insecure' } : OK;
}

/** The media server kind's setup provider knows the request (spec Part H); a kind without one cannot be tested: a warning, never a blocker. */
async function media(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const provider = MEDIA_SETUP[cfg.MEDIA_SERVER];
  if (!provider) return { ok: true, code: 'warning', detail: 'not_tested' };
  const c = cfg as Record<string, unknown>;
  const values = Object.fromEntries(provider.keys.map((k) => [k, c[k] === undefined || c[k] === null ? undefined : String(c[k])]));
  return provider.probe(values, { fetchImpl: f });
}

async function oidc(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const issuer = cfg.OIDC_ISSUER;
  if (!cfg.OIDC_CLIENT_ID || !cfg.OIDC_CLIENT_SECRET) return fail('invalid', 'incomplete');
  const u = httpUrl(issuer);
  if (!u) return fail('invalid', 'invalid_url');
  if (u.protocol === 'http:' && cfg.OIDC_ALLOW_INSECURE !== 'true') return fail('invalid', 'insecure_issuer');
  // discovery carries no credential (the client secret is only sent to the token endpoint at sign-in)
  const r = await f(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  if (!r.ok) return byStatus(r);
  let doc: { issuer?: unknown };
  try {
    doc = (await r.json()) as { issuer?: unknown };
  } catch {
    return fail('invalid', 'bad_response');
  }
  return doc?.issuer === issuer ? OK : fail('issuer_mismatch');
}

/** With the candidate token (never authentik.ts's call(), which uses the saved AUTHENTIK_API_TOKEN). */
async function authentik(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: token, AUTHENTIK_ENROLL_FLOW: flow } = cfg;
  if (!url || !token) return fail('invalid', 'incomplete');
  if (!httpUrl(url)) return fail('invalid', 'invalid_url');
  const base = akBase(url);
  const headers = { Authorization: `Bearer ${token}`, accept: 'application/json' };
  const me = byStatus(await f(`${base}/api/v3/core/users/me/`, { headers }));
  if (!me.ok || !flow) return me;
  const r = byStatus(await f(`${base}/api/v3/flows/instances/${encodeURIComponent(flow)}/`, { headers }));
  return r.detail === 'not_found' ? fail('invalid', 'enroll_flow_missing') : r;
}

/** The request service's request-count call (the admin overview's status call) with the candidate URL and key. */
async function requests(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  if (!cfg.REQUESTS_URL || !cfg.REQUESTS_API_KEY) return fail('invalid', 'incomplete');
  if (!httpUrl(cfg.REQUESTS_URL)) return fail('invalid', 'invalid_url');
  try {
    await new SeerrClient(cfg.REQUESTS_URL, cfg.REQUESTS_API_KEY, f).requestCount();
    return OK;
  } catch (e) {
    if (e instanceof SeerrError) return byCode(e.status);
    if (e instanceof SyntaxError) return fail('invalid', 'bad_response');
    throw e;
  }
}

async function source(ctx: Ctx, f: typeof fetch, name: 'tmdb' | 'omdb', key: string | undefined): Promise<ProbeResult> {
  if (!key) return fail('invalid', 'not_set');
  // the source test functions with the guarded fetch (they read ctx.fetchImpl; kv for the OMDb budget)
  const r = await testSourceKey(Object.assign(Object.create(ctx) as Ctx, { fetchImpl: f }), name, key);
  if (r.ok) return OK;
  if (r.error === 'invalid_key') return fail('unauthorized');
  if (r.error === 'budget') return { ok: true, code: 'warning', detail: 'budget' }; // cannot test today; not a reason to refuse the key
  return fail('unreachable');
}

async function portainer(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const { PORTAINER_WEBHOOK_URL: hook, PORTAINER_URL: url, PORTAINER_API_KEY: key, PORTAINER_STACK_ID: stack } = cfg;
  if (url || key) {
    if (!url || !key || !stack) return fail('invalid', 'incomplete');
    const base = httpUrl(url);
    if (!base) return fail('invalid', 'invalid_url');
    return byStatus(await f(join(base, `/api/stacks/${encodeURIComponent(stack)}`), { headers: { 'x-api-key': key } }));
  }
  // the webhook would start an update: only its form is checked
  return hook && httpUrl(hook) ? OK : fail('invalid', 'invalid_url');
}

async function github(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  if (!cfg.GITHUB_TOKEN) return fail('invalid', 'not_set');
  const r = await f(`https://api.github.com/repos/${cfg.UPDATE_REPO}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'friendflix', authorization: `Bearer ${cfg.GITHUB_TOKEN}` },
  });
  // 403/429 without a 401 is GitHub's rate limit, not a verdict on the token
  if (r.status === 403 || r.status === 429) {
    void r.body?.cancel().catch(() => undefined);
    return fail('unreachable', 'rate_limited');
  }
  return byStatus(r);
}

/** Runs one probe against `cfg` (the candidate: the current config merged with the submitted values). Never throws. */
export async function runProbe(ctx: Ctx, id: ProbeId, cfg: Config, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ProbeResult> {
  if (!probeConfigured(id, cfg)) return fail('invalid', 'not_set');
  const r = runner(opts.fetchImpl ?? ctx.fetchImpl, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (id === 'publicUrl') {
    // unreachable or slow through the public URL: a warning, never a blocker
    const res = await r.within(() => publicUrl(ctx, r.fetch, cfg));
    return res.code === 'unreachable' || res.code === 'timeout' ? { ok: true, code: 'warning', detail: res.code } : res;
  }
  return r.within(async () => {
    switch (id) {
      case 'media': return media(r.fetch, cfg);
      case 'oidc': return oidc(r.fetch, cfg);
      case 'authentik': return authentik(r.fetch, cfg);
      case 'requests': return requests(r.fetch, cfg);
      case 'tmdb': return source(ctx, r.fetch, 'tmdb', cfg.TMDB_API_KEY);
      case 'omdb': return source(ctx, r.fetch, 'omdb', cfg.OMDB_API_KEY);
      case 'portainer': return portainer(r.fetch, cfg);
      case 'github': return github(r.fetch, cfg);
    }
  });
}
