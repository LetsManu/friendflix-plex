// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { akMfaState, akSendMfaSetup, akSendRecovery, akSetActive, akUpdateUser, akUserBySub, akUserSettingsUrl } from '../src/authentik.js';
import type { Ctx } from '../src/ctx.js';
import { MemoryKV } from '../src/kv.js';
import { HttpError } from '../src/users.js';
import { cfg, fakeHttp, type Handler } from './helpers.js';

const TOKEN = 'ak-secret-token-0123456789';
/** Authentik's default OIDC sub: the hashed user id (User.uid) */
const SUB = 'f'.repeat(64);
const ANNA = { pk: 7, username: 'anna', email: 'anna@x.de', uid: SUB, uuid: '0b8e6a52-6a3f-4b8e-9b1a-2f0c3d4e5f60' };

interface AkCall { method: string; path: string; search: string; authorization?: string; body: unknown }

function mk(routes: Record<string, Handler>, opts: { configured?: boolean; flow?: string; throwWith?: string } = {}) {
  const calls: AkCall[] = [];
  const inner = fakeHttp(routes);
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', path: url.pathname, search: url.search, authorization: (init.headers as Record<string, string>).authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (opts.throwWith) throw new Error(opts.throwWith);
    return inner(input, init);
  }) as typeof fetch;
  const configured = opts.configured ?? true;
  const ctx = {
    cfg: { ...cfg, AUTHENTIK_URL: configured ? 'https://auth.example.com/' : undefined, AUTHENTIK_API_TOKEN: configured ? TOKEN : undefined, AUTHENTIK_RECOVERY_FLOW: opts.flow },
    kv: new MemoryKV(),
    // the portal account's e-mail narrows the Authentik user search
    db: { query: async () => ({ rows: [{ email: ANNA.email }], rowCount: 1 }) },
    fetchImpl,
  } as unknown as Ctx;
  return { ctx, calls };
}

const users: Handler = (u) => ({ json: { pagination: { next: 0 }, results: u.searchParams.get('search') === ANNA.email || u.searchParams.get('uuid') === ANNA.uuid ? [ANNA] : [] } });
const recoveryRoutes = (slug = 'default-recovery-flow'): Record<string, Handler> => ({
  'GET /api/v3/core/users/': users,
  [`GET /api/v3/flows/instances/${slug}/`]: () => ({ json: { pk: 'flow-pk-1', slug } }),
  'GET /api/v3/flows/bindings/': (u) => ({
    json: u.searchParams.get('target') === 'flow-pk-1'
      ? { pagination: { next: 0 }, results: [
        { order: 30, stage: 'later-email-stage', stage_obj: { component: 'ak-stage-email' } },
        { order: 10, stage: 'ident-stage', stage_obj: { component: 'ak-stage-identification' } },
        { order: 20, stage: 'email-stage-uuid', stage_obj: { component: 'ak-stage-email' } },
      ] }
      : { pagination: { next: 0 }, results: [] },
  }),
  'POST /api/v3/core/users/7/recovery_email/': () => ({ status: 204 }),
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as HttpError).statusCode, code: (e as Error).message, err: e as Error };
  }
  throw new Error('expected a rejection');
};

describe('akUserBySub', () => {
  it('matches the hashed sub on uid (search narrowed by the account e-mail)', async () => {
    const { ctx, calls } = mk({ 'GET /api/v3/core/users/': users });
    expect(await akUserBySub(ctx, SUB)).toEqual({ pk: 7, username: 'anna', email: 'anna@x.de' });
    expect(calls[0]).toMatchObject({ path: '/api/v3/core/users/', authorization: `Bearer ${TOKEN}` });
    expect(new URLSearchParams(calls[0]!.search).get('search')).toBe(ANNA.email);
  });

  it('looks a uuid sub up with ?uuid=', async () => {
    const { ctx, calls } = mk({ 'GET /api/v3/core/users/': users });
    expect(await akUserBySub(ctx, ANNA.uuid)).toMatchObject({ pk: 7 });
    expect(new URLSearchParams(calls[0]!.search).get('uuid')).toBe(ANNA.uuid);
  });

  it('falls back to paging the user list when the search finds nobody', async () => {
    const other = { ...ANNA, pk: 9, uid: 'e'.repeat(64) };
    const { ctx } = mk({
      'GET /api/v3/core/users/': (u) => u.searchParams.has('search') ? { json: { pagination: { next: 0 }, results: [] } }
        : u.searchParams.get('page') === '1' ? { json: { pagination: { next: 2 }, results: [other] } }
          : { json: { pagination: { next: 0 }, results: [ANNA] } },
    });
    expect(await akUserBySub(ctx, SUB)).toMatchObject({ pk: 7 });
  });

  it('unknown sub -> null, remembered for 5 min (no paging on every lookup)', async () => {
    const { ctx, calls } = mk({ 'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [] } }) });
    expect(await akUserBySub(ctx, 'd'.repeat(64))).toBeNull();
    const n = calls.length;
    expect(n).toBeGreaterThan(0);
    expect(await akUserBySub(ctx, 'd'.repeat(64))).toBeNull();
    expect(await akMfaState(ctx, 'd'.repeat(64))).toBeNull();
    expect(calls.length).toBe(n);
    expect(await ctx.kv.get(`akuser:${'d'.repeat(64)}`)).toBe('null');
  });
});

describe('akMfaState', () => {
  it('maps the device types (unconfirmed devices do not count) and caches the answer', async () => {
    const { ctx, calls } = mk({
      'GET /api/v3/core/users/': users,
      'GET /api/v3/authenticators/admin/all/': (u) => ({
        json: u.searchParams.get('user') === '7' ? [
          { type: 'authentik_stages_authenticator_totp.totpdevice', confirmed: true },
          { type: 'authentik_stages_authenticator_static.staticdevice', confirmed: true },
          { type: 'authentik_stages_authenticator_webauthn.webauthndevice', confirmed: false },
        ] : [],
      }),
    });
    expect(await akMfaState(ctx, SUB)).toEqual({ totp: true, webauthn: false, static: true });
    const n = calls.length;
    expect(await akMfaState(ctx, SUB)).toEqual({ totp: true, webauthn: false, static: true });
    expect(calls.length).toBe(n); // from kv
    expect(await ctx.kv.get(`akmfa:${SUB}`)).not.toBeNull();
  });

  it('a paginated answer works too; a user without devices has all false', async () => {
    const { ctx } = mk({
      'GET /api/v3/core/users/': users,
      'GET /api/v3/authenticators/admin/all/': () => ({ json: { pagination: { next: 0 }, results: [{ type: 'authentik_stages_authenticator_webauthn.webauthndevice' }] } }),
    });
    expect(await akMfaState(ctx, SUB)).toEqual({ totp: false, webauthn: true, static: false });
  });

  it('null when Authentik has no such user', async () => {
    const { ctx } = mk({ 'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [] } }) });
    expect(await akMfaState(ctx, 'd'.repeat(64))).toBeNull();
  });
});

describe('akSendRecovery', () => {
  it('calls the recovery_email URL with the first e-mail stage of the recovery flow and the token header', async () => {
    const { ctx, calls } = mk(recoveryRoutes());
    await akSendRecovery(ctx, SUB);
    const send = calls.find((c) => c.method === 'POST')!;
    expect(send.path).toBe('/api/v3/core/users/7/recovery_email/');
    expect(new URLSearchParams(send.search).get('email_stage')).toBe('email-stage-uuid');
    expect(send.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(new URLSearchParams(calls.find((c) => c.path === '/api/v3/flows/bindings/')!.search).get('target')).toBe('flow-pk-1');
  });

  it('uses AUTHENTIK_RECOVERY_FLOW', async () => {
    const { ctx, calls } = mk(recoveryRoutes('my-recovery'), { flow: 'my-recovery' });
    await akSendRecovery(ctx, SUB);
    expect(calls.some((c) => c.path === '/api/v3/flows/instances/my-recovery/')).toBe(true);
  });

  it('a flow without an e-mail stage or a missing flow -> 409 recovery_not_configured', async () => {
    const noEmail = { ...recoveryRoutes(), 'GET /api/v3/flows/bindings/': () => ({ json: { pagination: { next: 0 }, results: [{ order: 10, stage: 'x', stage_obj: { component: 'ak-stage-identification' } }] } }) } as Record<string, Handler>;
    expect(await codeOf(akSendRecovery(mk(noEmail).ctx, SUB))).toMatchObject({ status: 409, code: 'recovery_not_configured' });
    expect(await codeOf(akSendRecovery(mk(recoveryRoutes(), { flow: 'nope' }).ctx, SUB))).toMatchObject({ status: 409, code: 'recovery_not_configured' });
  });

  it('maps the recovery_email answers: 400 -> 409, 404 -> 404 (cached lookup dropped), 405 -> 501', async () => {
    const answer = (status: number) => ({ ...recoveryRoutes(), 'POST /api/v3/core/users/7/recovery_email/': () => ({ status, json: { non_field_errors: ['No recovery flow set.'] } }) }) as Record<string, Handler>;
    expect(await codeOf(akSendRecovery(mk(answer(400)).ctx, SUB))).toMatchObject({ status: 409, code: 'recovery_not_configured' });
    const gone = mk(answer(404));
    const r = await codeOf(akSendRecovery(gone.ctx, SUB));
    expect(r).toMatchObject({ status: 404, code: 'authentik_user_not_found' });
    expect(await gone.ctx.kv.get(`akuser:${SUB}`)).toBeNull();
    expect(await codeOf(akSendRecovery(mk(answer(405)).ctx, SUB))).toMatchObject({ status: 501, code: 'not_supported' });
  });

  it('sends the stage in the JSON body', async () => {
    const { ctx, calls } = mk(recoveryRoutes());
    await akSendRecovery(ctx, SUB);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ email_stage: 'email-stage-uuid' });
  });

  it('unknown Authentik user -> 404', async () => {
    const r = { ...recoveryRoutes(), 'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [] } }) } as Record<string, Handler>;
    expect(await codeOf(akSendRecovery(mk(r).ctx, SUB))).toMatchObject({ status: 404, code: 'authentik_user_not_found' });
  });
});

describe('akSendMfaSetup', () => {
  it('Authentik offers no link for another user: 501 not_supported', async () => {
    const { ctx, calls } = mk(recoveryRoutes());
    expect(await codeOf(akSendMfaSetup(ctx, SUB))).toMatchObject({ status: 501, code: 'not_supported' });
    expect(calls).toHaveLength(0);
  });
});

describe('missing config', () => {
  it('lookups give null, actions 503 authentik_unavailable, nothing is fetched', async () => {
    const { ctx, calls } = mk(recoveryRoutes(), { configured: false });
    expect(await akUserBySub(ctx, SUB)).toBeNull();
    expect(await akMfaState(ctx, SUB)).toBeNull();
    expect(await codeOf(akSendRecovery(ctx, SUB))).toMatchObject({ status: 503, code: 'authentik_unavailable' });
    expect(await codeOf(akSendMfaSetup(ctx, SUB))).toMatchObject({ status: 503, code: 'authentik_unavailable' });
    expect(calls).toHaveLength(0);
  });
});

describe('the token never leaks', () => {
  const leaks = (e: Error) => [e.message, String(e), e.stack ?? '', JSON.stringify(e)].some((s) => s.includes(TOKEN));

  it('not in errors from a rejected token (Authentik echoing it back)', async () => {
    const echo: Handler = () => ({ status: 403, json: { detail: `Token invalid: ${TOKEN}` } });
    const { ctx } = mk({ 'GET /api/v3/core/users/': echo, 'GET /api/v3/authenticators/admin/all/': echo });
    for (const p of [akSendRecovery(ctx, SUB), akMfaState(ctx, SUB), akUserBySub(ctx, SUB)]) {
      const r = await codeOf(p);
      expect(r).toMatchObject({ status: 502, code: 'authentik_token_rejected' });
      expect(leaks(r.err)).toBe(false);
    }
  });

  it('not in errors from a failed request', async () => {
    const { ctx } = mk({}, { throwWith: `connect ECONNREFUSED (Authorization: Bearer ${TOKEN})` });
    const r = await codeOf(akSendRecovery(ctx, SUB));
    expect(r).toMatchObject({ status: 503, code: 'authentik_unavailable' });
    expect(leaks(r.err)).toBe(false);
    expect(r.err).toBeInstanceOf(HttpError);
  });

  it('not in errors from other API failures', async () => {
    const { ctx } = mk({ ...recoveryRoutes(), 'POST /api/v3/core/users/7/recovery_email/': () => ({ status: 500, raw: `boom ${TOKEN}` }) });
    const r = await codeOf(akSendRecovery(ctx, SUB));
    expect(r).toMatchObject({ status: 502, code: 'authentik_error' });
    expect(leaks(r.err)).toBe(false);
  });
});

describe('akUpdateUser', () => {
  it('akUpdateUser PATCHes the user pk with the bearer header', async () => {
    const { ctx, calls } = mk({ 'GET /api/v3/core/users/': users, 'PATCH /api/v3/core/users/7/': () => ({ json: { ...ANNA, name: 'Anna B.' } }) });
    await akUpdateUser(ctx, SUB, { name: 'Anna B.' });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch).toMatchObject({ path: '/api/v3/core/users/7/', authorization: `Bearer ${TOKEN}`, body: { name: 'Anna B.' } });
  });

  it('maps 400 -> invalid_input, 404 -> authentik_user_not_found (cached lookup dropped), no config -> 503', async () => {
    const answer = (status: number) => ({ 'GET /api/v3/core/users/': users, 'PATCH /api/v3/core/users/7/': () => ({ status, json: { name: ['bad'] } }) }) as Record<string, Handler>;
    expect(await codeOf(akUpdateUser(mk(answer(400)).ctx, SUB, { name: 'x' }))).toMatchObject({ status: 400, code: 'invalid_input' });
    const gone = mk(answer(404));
    await gone.ctx.kv.set(`akmfa:${SUB}`, '{}', 60);
    expect(await codeOf(akUpdateUser(gone.ctx, SUB, { name: 'x' }))).toMatchObject({ status: 404, code: 'authentik_user_not_found' });
    expect(await gone.ctx.kv.get(`akuser:${SUB}`)).toBeNull();
    expect(await gone.ctx.kv.get(`akmfa:${SUB}`)).toBeNull();
    const none = mk({ 'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [] } }) });
    expect(await codeOf(akUpdateUser(none.ctx, SUB, { name: 'x' }))).toMatchObject({ status: 404, code: 'authentik_user_not_found' });
    const off = mk(answer(200), { configured: false });
    expect(await codeOf(akUpdateUser(off.ctx, SUB, { name: 'x' }))).toMatchObject({ status: 503, code: 'authentik_unavailable' });
    expect(off.calls).toHaveLength(0);
  });
});

describe('akSetActive', () => {
  it('PATCHes is_active', async () => {
    const { ctx, calls } = mk({ 'GET /api/v3/core/users/': users, 'PATCH /api/v3/core/users/7/': () => ({ json: ANNA }) });
    expect(await akSetActive(ctx, SUB, false)).toBe('done');
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/v3/core/users/7/', body: { is_active: false }, authorization: `Bearer ${TOKEN}` });
  });

  it('a user already in the wanted state is done without a PATCH (works without change_user)', async () => {
    const inactive: Handler = (u) => ({ json: { pagination: { next: 0 }, results: u.searchParams.get('search') === ANNA.email ? [{ ...ANNA, is_active: false }] : [] } });
    // the token may only view users: a PATCH would answer 403
    const { ctx, calls } = mk({ 'GET /api/v3/core/users/': inactive, 'PATCH /api/v3/core/users/7/': () => ({ status: 403 }) });
    expect(await akSetActive(ctx, SUB, false)).toBe('done');
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    // the other direction still PATCHes (and fails with the rejected token)
    expect(await codeOf(akSetActive(ctx, SUB, true))).toMatchObject({ status: 502, code: 'authentik_token_rejected' });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('akSetActive maps 404 to not_found', async () => {
    const gone = mk({ 'GET /api/v3/core/users/': users, 'PATCH /api/v3/core/users/7/': () => ({ status: 404 }) });
    expect(await akSetActive(gone.ctx, SUB, false)).toBe('not_found');
    expect(await gone.ctx.kv.get(`akuser:${SUB}`)).toBeNull();
    const none = mk({ 'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [] } }) });
    expect(await akSetActive(none.ctx, SUB, true)).toBe('not_found');
    const off = mk({}, { configured: false });
    expect(await akSetActive(off.ctx, SUB, true)).toBe('not_configured');
    expect(off.calls).toHaveLength(0);
    // other failures still throw (the caller retries)
    expect(await codeOf(akSetActive(mk({ 'GET /api/v3/core/users/': users, 'PATCH /api/v3/core/users/7/': () => ({ status: 500 }) }).ctx, SUB, false)))
      .toMatchObject({ status: 502, code: 'authentik_error' });
  });
});

describe('akUserSettingsUrl', () => {
  const ak = { ...cfg, AUTHENTIK_URL: 'http://authentik-server:9000', AUTHENTIK_API_TOKEN: TOKEN };
  it('the issuer origin plus the user settings path; null only for a non-Authentik issuer (no API needed)', () => {
    expect(akUserSettingsUrl({ ...ak, OIDC_ISSUER: 'https://login.example.com/application/o/friendflix/' })).toBe('https://login.example.com/if/user/#/settings');
    expect(akUserSettingsUrl({ ...ak, OIDC_ISSUER: 'https://idp.example.com/realms/x' })).toBeNull();
    expect(akUserSettingsUrl({ ...cfg, OIDC_ISSUER: 'https://login.example.com/application/o/friendflix/' })).toBe('https://login.example.com/if/user/#/settings');
    expect(akUserSettingsUrl({ ...ak, OIDC_ISSUER: 'not a url' })).toBeNull();
  });
});

describe('token never in thrown messages', () => {
  const leaks = (e: Error) => [e.message, String(e), e.stack ?? '', JSON.stringify(e)].some((s) => s.includes(TOKEN));
  it('token never in thrown messages', async () => {
    const echo: Handler = () => ({ status: 403, json: { detail: `Token invalid: ${TOKEN}` } });
    const { ctx } = mk({ 'GET /api/v3/core/users/': users, 'PATCH /api/v3/core/users/7/': echo });
    for (const p of [akUpdateUser(ctx, SUB, { name: 'x' }), akSetActive(ctx, SUB, false)]) {
      const r = await codeOf(p);
      expect(r).toMatchObject({ status: 502, code: 'authentik_token_rejected' });
      expect(leaks(r.err)).toBe(false);
    }
    const down = mk({}, { throwWith: `connect ECONNREFUSED (Authorization: Bearer ${TOKEN})` });
    for (const p of [akUpdateUser(down.ctx, SUB, { name: 'x' }), akSetActive(down.ctx, SUB, true)]) {
      const r = await codeOf(p);
      expect(r).toMatchObject({ status: 503, code: 'authentik_unavailable' });
      expect(leaks(r.err)).toBe(false);
    }
  });
});
