// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MediaCapabilities } from '../src/media/types.js';
import { ensureSeerrUser, placeholderEmail, SEERR_PERMISSION_REQUEST } from '../src/seerr/service.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

/** Wishes on a media server without per-user accounts (capabilities.requestUsers = 'local'): local Seerr users per account. */

type SeerrUser = { id: number; email: string; username?: string; permissions: number; jellyfinUserId?: string };
let env: TestEnv;
let users: SeerrUser[] = [];
let nextId = 10;
let reqId = 100;
let failPut = false;
let seerrDown = false;
const DEFAULT_PERMS = 4096 | 128; // whatever the Seerr admin set as defaults (here incl. auto-approve): must be replaced

beforeAll(async () => {
  env = await makeEnv({}, {
    seerr: {
      'GET /api/v1/user': (u) => {
        const take = Number(u.searchParams.get('take') ?? 20), skip = Number(u.searchParams.get('skip') ?? 0);
        return { json: { pageInfo: { results: users.length }, results: users.slice(skip, skip + take) } };
      },
      'GET /api/v1/user/\\d+': (u) => {
        if (seerrDown) return { status: 503 };
        const su = users.find((x) => x.id === Number(u.pathname.split('/').pop()));
        return su ? { json: su } : { status: 404, json: { message: 'User not found.' } };
      },
      'POST /api/v1/user': (_u, _i, b) => {
        if (users.some((x) => x.email === b.email.toLowerCase())) return { status: 409, json: { message: 'User already exists with submitted email.' } };
        const su = { id: nextId++, email: b.email.toLowerCase(), username: b.username, permissions: DEFAULT_PERMS };
        users.push(su);
        return { status: 201, json: su };
      },
      'PUT /api/v1/user/\\d+': (u, _i, b) => {
        if (failPut) return { status: 500 };
        const su = users.find((x) => x.id === Number(u.pathname.split('/').pop()));
        if (!su) return { status: 404 };
        Object.assign(su, { username: b.username, permissions: b.permissions });
        return { json: su };
      },
      'DELETE /api/v1/user/\\d+': (u) => {
        users = users.filter((x) => x.id !== Number(u.pathname.split('/').pop()));
        return { json: {} };
      },
      'GET /api/v1/movie/\\d+': () => ({ json: { title: 'Dunmoor', posterPath: '/dune.jpg' } }),
      'POST /api/v1/request': (_u, _i, b) => ({ json: { id: reqId++, status: 1, media: { status: 2 }, echo: b } }),
    },
  });
  // a media server without a Seerr user import (the Plex fork, for example)
  const jf = env.ctx.jf as { capabilities: MediaCapabilities };
  jf.capabilities = { ...jf.capabilities, requestUsers: 'local' };
});
afterAll(() => env.close());

let tmdb = 5000;
type Sess = { cookies: Record<string, string>; csrf: string };
const wish = (s: Sess) => env.app.inject({ method: 'POST', url: '/api/requests', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { mediaType: 'movie', tmdbId: ++tmdb } });
const calls = (method: string, path: RegExp) => env.seerrCalls.filter((c) => c.method === method && path.test(c.path));
const requestUserIds = () => calls('POST', /^\/api\/v1\/request$/).map((c) => c.body.userId);
const mapping = async (sub: string) => (await env.pool.query('select id, seerr_user_id from users where authentik_sub=$1', [sub])).rows[0] as { id: string; seerr_user_id: number | null };

beforeEach(async () => {
  users = [{ id: 1, email: 'owner@seerr.local', permissions: 2 }];
  env.seerrCalls.length = 0;
  failPut = false;
  await env.pool.query('update users set seerr_user_id=null');
});

describe("local Seerr users (capabilities.requestUsers = 'local')", () => {
  it('creates a local user with REQUEST only on the first wish, stores it and reuses it on the second', async () => {
    const s = await env.login(ADMIN);
    const r = await wish(s);
    expect(r.statusCode, r.body).toBe(200);
    const post = calls('POST', /^\/api\/v1\/user$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toMatchObject({ email: 'admin@example.com', username: 'Admin' });
    expect(typeof post[0]!.body.password).toBe('string'); // Seerr needs one unless its email agent is on
    expect(post[0]!.body.password.length).toBeGreaterThanOrEqual(24);
    const put = calls('PUT', /^\/api\/v1\/user\/\d+$/);
    expect(put.map((c) => c.body)).toEqual([{ username: 'Admin', permissions: SEERR_PERMISSION_REQUEST }]);
    const created = users.find((u) => u.email === 'admin@example.com')!;
    expect(created.permissions).toBe(32); // never ADMIN (2), no auto-approve
    expect((await mapping('sub-admin')).seerr_user_id).toBe(created.id);
    expect(calls('POST', /import-from-jellyfin/)).toHaveLength(0);

    expect((await wish(s)).statusCode).toBe(200);
    expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(1); // reused
    expect(calls('GET', /^\/api\/v1\/user\/\d+$/).at(-1)!.path).toBe(`/api/v1/user/${created.id}`); // still exists?
    expect(requestUserIds()).toEqual([created.id, created.id]); // made in the user's name (userId in the body), as with Jellyfin
  });

  it('adopts an existing Seerr user with the same email (case-insensitive, across pages) without touching its permissions', async () => {
    for (let i = 0; i < 150; i++) users.push({ id: 200 + i, email: `filler${i}@x.test`, permissions: 32 });
    users.push({ id: 777, email: 'Admin@Example.com'.toLowerCase(), permissions: 2 | 32 });
    const s = await env.login(ADMIN);
    expect((await wish(s)).statusCode).toBe(200);
    expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(0);
    expect(calls('PUT', /^\/api\/v1\/user/)).toHaveLength(0);
    expect(calls('GET', /^\/api\/v1\/user$/).length).toBeGreaterThanOrEqual(2); // paged
    expect(requestUserIds()).toEqual([777]);
    expect((await mapping('sub-admin')).seerr_user_id).toBe(777);
  });

  it('re-creates the user once when the stored one was deleted in Seerr', async () => {
    const s = await env.login(ADMIN);
    await env.pool.query("update users set seerr_user_id=55 where authentik_sub='sub-admin'"); // gone in Seerr
    expect((await wish(s)).statusCode).toBe(200);
    const created = users.find((u) => u.email === 'admin@example.com')!;
    expect(created.id).not.toBe(55);
    expect(requestUserIds()).toEqual([created.id]);
    expect((await mapping('sub-admin')).seerr_user_id).toBe(created.id);
    expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(1);
  });

  it('parallel wishes of one account create exactly one Seerr user', async () => {
    const s = await env.login(ADMIN);
    const rs = await Promise.all([wish(s), wish(s), wish(s)]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(1);
    const id = users.find((u) => u.email === 'admin@example.com')!.id;
    expect(requestUserIds()).toEqual([id, id, id]);
    // the mapping itself, raced directly (separate row copies, as separate requests would load them)
    await env.pool.query('update users set seerr_user_id=null');
    users = users.filter((u) => u.id !== id);
    env.seerrCalls.length = 0;
    const row = (await env.pool.query("select * from users where authentik_sub='sub-admin'")).rows[0];
    const seerr = env.ctx.seerr!;
    const orig = seerr.listUsersPage;
    // barrier: each lookup waits (max 200 ms) until all five callers are inside it, so without the lock all of them would create
    const waiting: Array<() => void> = [];
    seerr.listUsersPage = async (...a) => {
      await new Promise<void>((r) => { waiting.push(r); if (waiting.length >= 5) waiting.forEach((w) => w()); else setTimeout(r, 200); });
      return orig.apply(env.ctx.seerr, a);
    };
    let ids: number[];
    try {
      ids = await Promise.all(Array.from({ length: 5 }, () => ensureSeerrUser(env.ctx, { ...row })));
    } finally {
      seerr.listUsersPage = orig;
    }
    expect(new Set(ids).size).toBe(1);
    expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(1);
  });

  it('an account without email gets a deterministic placeholder address', async () => {
    const s = await env.login({ sub: 'sub-noemail', name: 'Nomail', groups: ['friendflix-admins'] });
    expect((await wish(s)).statusCode).toBe(200);
    const row = await mapping('sub-noemail');
    expect(calls('POST', /^\/api\/v1\/user$/)[0]!.body).toMatchObject({ email: placeholderEmail(row.id), username: 'Nomail' });
    expect(placeholderEmail(row.id)).toBe(`${row.id}@friendflix.invalid`);
    // a reset mapping finds it again by that address instead of creating a second user
    await env.pool.query('update users set seerr_user_id=null where id=$1', [row.id]);
    expect((await wish(s)).statusCode).toBe(200);
    expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(1);
    expect((await mapping('sub-noemail')).seerr_user_id).toBe(row.seerr_user_id);
  });

  it('a failing permission update removes the new user again and fails the wish (no half-configured user, no mapping)', async () => {
    const s = await env.login(ADMIN);
    failPut = true;
    const r = await wish(s);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'seerr' });
    expect(users.map((u) => u.email)).toEqual(['owner@seerr.local']);
    expect((await mapping('sub-admin')).seerr_user_id).toBeNull();
    expect(requestUserIds()).toEqual([]);
  });

  it('Seerr unreachable while checking the stored user: the usual error, the mapping is kept', async () => {
    const s = await env.login(ADMIN);
    await env.pool.query("update users set seerr_user_id=10 where authentik_sub='sub-admin'");
    users.push({ id: 10, email: 'admin@example.com', permissions: 32 });
    seerrDown = true;
    try {
      const r = await wish(s);
      expect([r.statusCode, r.json().error]).toEqual([502, 'seerr']);
    } finally {
      seerrDown = false;
    }
    expect(requestUserIds()).toEqual([]);
    expect((await mapping('sub-admin')).seerr_user_id).toBe(10);
  });

  it('servers that do not say anything (requestUsers absent) default to local users', async () => {
    const jf = env.ctx.jf as { capabilities: MediaCapabilities };
    const prev = jf.capabilities;
    const { requestUsers: _drop, ...rest } = prev;
    jf.capabilities = rest;
    try {
      const s = await env.login(ADMIN);
      expect((await wish(s)).statusCode).toBe(200);
      expect(calls('POST', /^\/api\/v1\/user$/)).toHaveLength(1);
      expect(calls('POST', /import-from-jellyfin/)).toHaveLength(0);
    } finally {
      jf.capabilities = prev;
    }
  });

  it('kids profiles still cannot wish (403 kids_profile) and no Seerr user is created for them', async () => {
    const s = await env.login(ADMIN);
    const p = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { name: 'Mia', kids: true } });
    expect(p.statusCode, p.body).toBe(201);
    const sel = await env.app.inject({ method: 'POST', url: `/api/profiles/${p.json().profile.id}/select`, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: {} });
    expect(sel.statusCode, sel.body).toBe(200);
    const k = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: s.csrf };
    const r = await wish(k);
    expect([r.statusCode, r.json().error]).toEqual([403, 'kids_profile']);
    expect(env.seerrCalls).toHaveLength(0);
  });
});
