// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, hashPin, keyFromBase64 } from '../src/crypto.js';
import { effectiveLimits, getUserLimits } from '../src/limits.js';
import { ENC_KEY, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let adminId = '';
let anna = '';
const KID = '11111111-2222-4333-8444-555555555555';
const BROKEN = '11111111-2222-4333-8444-666666666666';
const jfId = (s: string) => s.padEnd(32, '0').slice(0, 32);
const ANNA_JF = jfId('anna');
const KID_JF = jfId('kidjf');
const BROKEN_JF = jfId('brokenjf');
const key = keyFromBase64(ENC_KEY);

const as = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const audits = async (action: string, target: string) => (await env.pool.query('select actor, meta from audit_log where action=$1 and target=$2 order by id', [action, target])).rows;
const session = (sid: string, deviceId: string, profileId?: string, touchedAt = Date.now()) =>
  env.kv.set(`sess:${sid}`, JSON.stringify({ userId: anna, csrf: 'c', deviceId, deviceApproved: true, createdAt: touchedAt, touchedAt, ...(profileId ? { profileId } : {}) }), 600);

const played = (id: string, name: string, at: string) => ({ Id: id, Name: name, Type: 'Movie', UserData: { Played: true, LastPlayedDate: at } });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const uid = u.searchParams.get('userId');
      if (uid === ANNA_JF) return { json: { Items: [played('m1', 'Owner Film', '2026-10-10T20:00:00Z'), played('m3', 'Old Film', '2026-09-01T20:00:00Z')] } };
      if (uid === KID_JF) return { json: { Items: [played('m2', 'Kid Film', '2026-10-12T17:00:00Z')] } };
      return { status: 500 };
    },
    'GET /UserItems/Resume': () => ({ json: { Items: [] } }),
    'GET /UserViews': () => ({ json: { Items: [] } }),
  }, { seerr: { 'GET /api/v1/user/42': () => ({ json: { id: 42 } }) } });
  admin = await env.login();
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  anna = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, seerr_user_id, avatar)
     values (gen_random_uuid(), 'anna-sub', 'anna@x.de', 'Anna', 'friend', $1, 'anna', $2, 42, 'blue') returning id`,
    [ANNA_JF, encrypt(key, 'pw')],
  )).rows[0].id;
  await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1, $1, 'Anna', true)", [anna]);
  await env.pool.query(
    `insert into profiles(id, user_id, name, avatar, pin_hash, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
     values ($1, $2, 'Kiddo', 'green', $3, $4, 'anna-kiddo', $5, true, 6), ($6, $2, 'Broken', 'red', null, $7, 'anna-broken', 'not-a-ciphertext', false, 12)`,
    [KID, anna, hashPin('1234'), KID_JF, encrypt(key, 'kpw'), BROKEN, BROKEN_JF],
  );
  await env.pool.query("insert into devices(user_id, device_id, label, approved, last_seen) values ($1, 'dev-a', 'Firefox on Linux', true, now() - interval '1 hour'), ($1, 'dev-b', 'Safari on iPhone', false, now() - interval '2 days')", [anna]);
  await env.pool.query(
    `insert into play_seconds(user_id, item_id, day, seconds, item_name) values
       ($1, 'a', current_date, 3600, 'A'), ($1, 'b', current_date - 10, 7200, 'B'), ($1, 'c', current_date - 100, 1800, 'C')`, [anna]);
  await env.pool.query("insert into play_daily(user_id, day, device_id, streams) values ($1, current_date, 'dev-a', 2), ($1, current_date - 20, 'dev-a', 3)", [anna]);
  await env.pool.query(
    `insert into downloads(id, user_id, device_id, profile_id, item_id, quality, status, expires_at, meta) values
       (gen_random_uuid(), $1, 'dev-a', $1, 'm1', 'original', 'fetched', now() + interval '10 days', '{"title":"Owner Film"}'),
       (gen_random_uuid(), $1, 'dev-a', $1, 'm9', 'original', 'revoked', now() + interval '10 days', '{"title":"Gone"}')`, [anna]);
  await env.pool.query("insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title) values (501, $1, 'movie', 1, 'Wish')", [anna]);
});
afterAll(() => env.close());
beforeEach(async () => {
  for (const k of await env.kv.keys('sess:')) {
    const s = JSON.parse((await env.kv.get(k))!) as { userId: string };
    if (s.userId === anna) await env.kv.del(k);
  }
  await env.pool.query('delete from user_limits');
});

describe('GET /api/admin/users/:id', () => {
  it('detail returns totals, profiles, devices, licences', async () => {
    await session('s-a1', 'dev-a', KID, Date.now() - 60_000);
    await session('s-a2', 'dev-a');
    await session('s-b1', 'dev-b');
    const r = await as('GET', `/api/admin/users/${anna}`);
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.user).toMatchObject({ id: anna, name: 'Anna', email: 'anna@x.de', role: 'friend', disabled: false, lockedReason: null, accessUntil: null, avatar: 'blue' });
    expect(d.user.createdAt).toBeTruthy();
    expect(Date.parse(d.user.lastActive)).toBeGreaterThan(Date.now() - 2 * 3600_000);
    expect(d.mfa).toBeNull(); // no Authentik API configured
    expect(d.totals).toEqual({
      d7: { hours: 1, streams: 2 }, d30: { hours: 3, streams: 5 }, all: { hours: 3.5, streams: 5 }, downloads: 2, requests: 1,
    });
    expect(d.linked).toEqual({ jellyfin: { ok: true, username: 'anna' }, requests: { ok: true, id: 42 } });
    expect(d.profiles.map((p: { name: string }) => p.name)).toEqual(['Anna', 'Broken', 'Kiddo']); // owner first, then created_at, name
    expect(d.profiles[2]).toMatchObject({ id: KID, name: 'Kiddo', kids: true, maxRating: 6, avatar: 'green', hasPin: true, isOwner: false });
    expect(d.profiles[0]).toMatchObject({ isOwner: true, kids: false, maxRating: null, hasPin: false });
    expect(Date.parse(d.profiles[0].lastUsed)).toBeGreaterThan(Date.parse(d.profiles[2].lastUsed));
    expect(d.profiles[1].lastUsed).toBeNull();
    expect(d.devices).toEqual([
      expect.objectContaining({ id: 'dev-a', name: 'Firefox on Linux', approved: true, sessions: 2 }),
      expect.objectContaining({ id: 'dev-b', name: 'Safari on iPhone', approved: false, sessions: 1 }),
    ]);
    expect(d.licenses).toHaveLength(1);
    expect(d.licenses[0]).toMatchObject({ itemId: 'm1', title: 'Owner Film', status: 'fetched', profileId: anna });
  });

  it('a locked account\'s Jellyfin link is healthy while its identity exists (the sign-in is disabled on purpose)', async () => {
    await env.pool.query('update users set disabled=true where id=$1', [anna]);
    try {
      env.jfCalls.length = 0;
      const d = (await as('GET', `/api/admin/users/${anna}`)).json();
      expect(d.linked.jellyfin).toEqual({ ok: true, username: 'anna' });
      expect(env.jfCalls.some((c) => c.method === 'GET' && c.path === `/Users/${ANNA_JF}`)).toBe(true);
      expect(env.jfCalls.some((c) => c.path === '/Users/AuthenticateByName')).toBe(false);
      // identity gone on the server -> broken
      const gone = env.ctx.jf.admin.identityExists!;
      env.ctx.jf.admin.identityExists = async () => false;
      try {
        expect((await as('GET', `/api/admin/users/${anna}`)).json().linked.jellyfin.ok).toBe(false);
      } finally {
        env.ctx.jf.admin.identityExists = gone;
      }
    } finally {
      await env.pool.query('update users set disabled=false where id=$1', [anna]);
    }
  });

  it('never returns credentials, tokens or the Authentik sub', async () => {
    const body = (await as('GET', `/api/admin/users/${anna}`)).body;
    for (const s of ['jellyfin_pw_enc', 'pw_enc', 'pin_hash', 'authentik_sub', 'anna-sub', 'token']) expect(body).not.toContain(s);
  });

  it('unknown user -> 404', async () => {
    expect((await as('GET', '/api/admin/users/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('activity', () => {
  it('activity view is audited', async () => {
    const r = await as('GET', `/api/admin/users/${anna}/activity?limit=50`);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<{ id: string; name: string; profile: { id: string; name: string }; lastPlayedDate: string }>;
    // both profiles merged, newest first; the profile whose identity fails is skipped
    expect(items.map((i) => [i.id, i.profile.name])).toEqual([['m2', 'Kiddo'], ['m1', 'Anna'], ['m3', 'Anna']]);
    expect(r.json().skipped).toEqual([BROKEN]);
    expect((await audits('user.activity_viewed', anna)).at(-1)).toMatchObject({ actor: adminId });

    const one = await as('GET', `/api/admin/users/${anna}/activity?limit=1`);
    expect(one.json().items.map((i: { id: string }) => i.id)).toEqual(['m2']);
  });
});

describe('audit tab', () => {
  it('audit tab lists both target and actor entries', async () => {
    await env.pool.query("insert into audit_log(actor, action, target, meta) values ($1::uuid, 'user.role', $2::text, '{}'), ($2::uuid, 'profile.create', 'p-x', '{}'), ($1::uuid, 'user.role', $1::text, '{}')", [adminId, anna]);
    const r = await as('GET', `/api/admin/users/${anna}/audit?limit=100`);
    expect(r.statusCode).toBe(200);
    const actions = r.json().entries.map((e: { action: string; target: string }) => `${e.action}:${e.target === anna ? 'anna' : e.target}`);
    expect(actions).toContain('user.role:anna');
    expect(actions).toContain('profile.create:p-x');
    expect(r.json().entries.every((e: { target: string; actor_id: string }) => e.target === anna || e.actor_id === anna)).toBe(true);
    expect(r.json().total).toBe(r.json().entries.length);
    const page = await as('GET', `/api/admin/users/${anna}/audit?limit=1&offset=1`);
    expect(page.json().entries).toHaveLength(1);
    expect(page.json().entries[0].id).toBe(r.json().entries[1].id);
  });
});

describe('limits', () => {
  it('GET shows overrides and the role values', async () => {
    const r = await as('GET', `/api/admin/users/${anna}/limits`);
    expect(r.json()).toEqual({
      limits: { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null },
      role: { maxStreams: 2, remoteBitrate: 8_000_000, maxDownloads: 15, downloadMaxHeight: 720, requestsPerMonth: expect.any(Number) },
    });
  });

  it('PUT stores, invalidates, re-applies the role to all identities, forgets the gateway memo and audits from/to', async () => {
    expect((await effectiveLimits(env.ctx, { id: anna, role: 'friend' }))!.maxStreams).toBe(2); // warms the cache
    await session('s-lim', 'dev-a');
    env.jfCalls.length = 0;
    const r = await as('PUT', `/api/admin/users/${anna}/limits`, { maxStreams: 4, maxDownloads: 3 });
    expect(r.statusCode).toBe(200);
    expect(await getUserLimits(env.ctx, anna)).toEqual({ maxStreams: 4, remoteBitrate: null, maxDownloads: 3, downloadMaxHeight: null, requestsPerMonth: null });
    expect((await effectiveLimits(env.ctx, { id: anna, role: 'friend' }))!.maxStreams).toBe(4); // cache invalidated
    const policies = env.jfCalls.filter((c) => c.method === 'POST' && c.path.endsWith('/Policy'));
    expect(policies.map((c) => c.path).sort()).toEqual([ANNA_JF, KID_JF, BROKEN_JF].map((j) => `/Users/${j}/Policy`).sort());
    expect(policies.every((c) => c.body.MaxActiveSessions === 4)).toBe(true);
    expect(await env.kv.get('sess:s-lim')).not.toBeNull(); // sessions stay
    expect((await audits('user.limits', anna)).at(-1)).toMatchObject({
      actor: adminId,
      meta: { from: { maxStreams: null, maxDownloads: null }, to: { maxStreams: 4, maxDownloads: 3, remoteBitrate: null } },
    });

    // a partial PUT keeps the other fields; null goes back to the role value
    await as('PUT', `/api/admin/users/${anna}/limits`, { maxStreams: null });
    expect(await getUserLimits(env.ctx, anna)).toMatchObject({ maxStreams: null, maxDownloads: 3 });
  });

  it('PUT forgets the memoised gateway identity of the user\'s sessions', async () => {
    const sid = 'anna-gateway-session-' + 'x'.repeat(20);
    await session(sid, 'dev-a');
    const authz = async () => (await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': 'internal-secret-123456' }, payload: { sid } })).json();
    expect((await authz()).maxBitrate).toBe(8_000_000); // remote cap of the role, now memoised for 5 s
    expect((await as('PUT', `/api/admin/users/${anna}/limits`, { remoteBitrate: 2_000_000 })).statusCode).toBe(200);
    expect((await authz()).maxBitrate).toBe(2_000_000); // not the memoised answer
    expect(await env.kv.get(`sess:${sid}`)).not.toBeNull();
  });

  it('PUT validates the bounds of the role schema', async () => {
    for (const bad of [{ maxStreams: 0 }, { maxStreams: 1.5 }, { maxDownloads: -1 }, { maxDownloads: 201 }, { downloadMaxHeight: 4320 }, { remoteBitrate: 1000 }, { remoteBitrate: 300_000_000 }, { requestsPerMonth: -1 }, { foo: 1 }]) {
      const r = await as('PUT', `/api/admin/users/${anna}/limits`, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await as('PUT', `/api/admin/users/${anna}/limits`, { remoteBitrate: 300_000, maxDownloads: 0, downloadMaxHeight: 0, requestsPerMonth: 0, maxStreams: 1 })).statusCode).toBe(200);
  });
});

describe('repair, sessions, Authentik, profiles', () => {
  it('repair re-applies the role', async () => {
    env.jfCalls.length = 0;
    const r = await as('POST', `/api/admin/users/${anna}/repair`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, jellyfin: { identities: 3, failed: 0 }, requests: { ok: true, id: 42 } });
    const paths = env.jfCalls.filter((c) => c.method === 'POST' && c.path.endsWith('/Policy')).map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining([`/Users/${ANNA_JF}/Policy`, `/Users/${KID_JF}/Policy`]));
    expect((await audits('user.repair', anna)).at(-1)).toMatchObject({ actor: adminId });
  });

  it('revoke one device only', async () => {
    await session('s-a1', 'dev-a');
    await session('s-a2', 'dev-a');
    await session('s-b1', 'dev-b');
    const r = await as('POST', `/api/admin/users/${anna}/sessions/dev-a/revoke`);
    expect(r.json()).toEqual({ revoked: 2 });
    expect(await env.kv.get('sess:s-a1')).toBeNull();
    expect(await env.kv.get('sess:s-a2')).toBeNull();
    expect(await env.kv.get('sess:s-b1')).not.toBeNull();
    expect((await audits('user.revoke_device', anna)).at(-1)).toEqual({ actor: adminId, meta: { deviceId: 'dev-a', sessions: 2 } });
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await as('POST', `/api/admin/users/${unknown}/sessions/dev-a/revoke`)).statusCode).toBe(404);
    expect(await audits('user.revoke_device', unknown)).toHaveLength(0);
  });

  it('Authentik actions without the Authentik API -> 503', async () => {
    expect((await as('POST', `/api/admin/users/${anna}/recovery`)).json()).toEqual({ error: 'authentik_unavailable' });
    // the failed attempt is on record, with the code only
    expect((await audits('user.recovery_email', anna)).at(-1)).toEqual({ actor: adminId, meta: { ok: false, error: 'authentik_unavailable' } });
    expect((await as('POST', `/api/admin/users/${anna}/mfa-setup`)).statusCode).toBe(503);
  });

  it('with the Authentik API: 2FA state in the detail, recovery mail sent and audited, 2FA setup 501', async () => {
    const saved = { cfg: env.ctx.cfg, fetchImpl: env.ctx.fetchImpl };
    const ak = { pk: 3, username: 'anna', email: 'anna@x.de', uid: 'anna-sub' };
    const posted: string[] = [];
    env.ctx.cfg = { ...saved.cfg, AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 'tok' };
    env.ctx.fetchImpl = fakeHttp({
      'GET /api/v3/core/users/': () => ({ json: { pagination: { next: 0 }, results: [ak] } }),
      'GET /api/v3/authenticators/admin/all/': () => ({ json: [{ type: 'authentik_stages_authenticator_webauthn.webauthndevice', confirmed: true }] }),
      'GET /api/v3/flows/instances/default-recovery-flow/': () => ({ json: { pk: 'f1' } }),
      'GET /api/v3/flows/bindings/': () => ({ json: { pagination: { next: 0 }, results: [{ order: 10, stage: 'mail', stage_obj: { component: 'ak-stage-email-form', meta_model_name: 'authentik_stages_email.emailstage' } }] } }),
      'POST /api/v3/core/users/3/recovery_email/': (u) => { posted.push(u.search); return { status: 204 }; },
    });
    try {
      const d = (await as('GET', `/api/admin/users/${anna}`)).json();
      expect(d.mfa).toEqual({ totp: false, webauthn: true, static: false });
      expect(d.authentik).toEqual({ recovery: true, mfaSetup: false });
      expect((await as('POST', `/api/admin/users/${anna}/recovery`)).json()).toEqual({ ok: true });
      expect(posted).toEqual(['?email_stage=mail']);
      expect((await audits('user.recovery_email', anna)).at(-1)).toMatchObject({ actor: adminId, meta: { ok: true } });
      const setup = await as('POST', `/api/admin/users/${anna}/mfa-setup`);
      expect(setup.statusCode).toBe(501);
      expect(setup.json()).toEqual({ error: 'not_supported' });
    } finally {
      Object.assign(env.ctx, saved);
      await env.kv.del('akuser:anna-sub');
      await env.kv.del('akmfa:anna-sub');
    }
  });

  it('admin renames a profile and resets its PIN', async () => {
    await env.kv.set(`pinfail:${KID}`, '4', 600);
    const r = await as('PATCH', `/api/admin/users/${anna}/profiles/${KID}`, { name: 'Kleine', resetPin: true });
    expect(r.statusCode).toBe(200);
    const row = (await env.pool.query('select name, pin_hash from profiles where id=$1', [KID])).rows[0];
    expect(row).toEqual({ name: 'Kleine', pin_hash: null });
    expect(await env.kv.get(`pinfail:${KID}`)).toBeNull();
    expect((await audits('profile.admin_update', anna)).at(-1)).toMatchObject({
      actor: adminId, meta: { profile: KID, from: { name: 'Kiddo', hasPin: true }, to: { name: 'Kleine', hasPin: false } },
    });

    // the owner profile can be renamed too (its user can do the same); the account name stays
    const owner = await as('PATCH', `/api/admin/users/${anna}/profiles/${anna}`, { name: 'Annie' });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().profile).toMatchObject({ id: anna, name: 'Annie', isOwner: true });
    expect((await env.pool.query('select name from users where id=$1', [anna])).rows[0].name).toBe('Anna');
    expect((await audits('profile.admin_update', anna)).at(-1)).toMatchObject({ meta: { profile: anna, from: { name: 'Anna' }, to: { name: 'Annie' } } });
    await env.pool.query("update profiles set name='Anna' where id=$1", [anna]);
    // name taken (case-insensitive), unknown profile, empty body
    expect((await as('PATCH', `/api/admin/users/${anna}/profiles/${KID}`, { name: 'broken' })).statusCode).toBe(409);
    expect((await as('PATCH', `/api/admin/users/${anna}/profiles/${adminId}`, { resetPin: true })).statusCode).toBe(404);
    expect((await as('PATCH', `/api/admin/users/${anna}/profiles/${KID}`, {})).statusCode).toBe(400);
  });
});
