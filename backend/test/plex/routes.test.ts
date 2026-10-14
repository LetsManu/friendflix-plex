// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Plex implementation behind the real routes (makeEnv({ server: 'plex' })): provisioning creates synthetic identities with
 * policies, kids profiles get their caps, and every item-bearing route / the gateway's /internal/authz/item answer from the
 * server-side access rules. The Plex token never appears in a response.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLEX_TOKEN, PlexFake } from '../plexfake.js';
import { makeEnv, type TestEnv } from '../helpers.js';
import { item } from './setup.js';

type Sess = { cookies: Record<string, string>; csrf: string };

describe('Plex behind the FriendFlix routes', () => {
  let env: TestEnv;
  const fake = new PlexFake();
  const lib: Record<string, string> = {};
  const bodies: string[] = [];
  lib.kid = fake.addMovie({ title: 'Kinderfilm', rating: 'de/0', genres: ['Family'] });
  lib.unrated = fake.addMovie({ title: 'Home Video' });

  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake });
  });
  afterAll(async () => {
    for (const b of bodies) expect(b).not.toContain(PLEX_TOKEN);
    await env.close();
  });

  const call = async (s: Sess, method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
    bodies.push(r.body, JSON.stringify(r.headers));
    return r;
  };
  const authz = (sid: string, itemId: string) =>
    env.app.inject({ method: 'POST', url: '/internal/authz/item', headers: { 'x-internal-secret': env.ctx.cfg.INTERNAL_SECRET }, payload: { sid, itemId } });

  it('/api/me reports the Plex server kind and its honest capabilities', async () => {
    const s = await env.login();
    const me = (await call(s, 'GET', '/api/me')).json();
    expect(me.server).toEqual({ kind: 'plex', capabilities: { segments: [], trickplay: true, upcoming: false, subtitleSearch: false, webhooks: false, changeFeed: true, planB: false, subtitleExtract: true, chapters: false, playbackPrefetch: false } });
    // provisioning created a synthetic identity with the role policy (admin: all libraries, no cap)
    const jf = (await env.pool.query('select jellyfin_user_id j from users')).rows[0].j as string;
    expect(jf).toMatch(/^[0-9a-f]{32}$/);
    expect((await env.pool.query('select libraries, max_age, disabled from plex_media_policies where identity_id=$1', [jf])).rows[0]).toEqual({ libraries: null, max_age: null, disabled: false });
  });

  it('library routes list from the mirror; item detail, seasons, episodes work', async () => {
    const s = await env.login();
    const views = (await call(s, 'GET', '/api/library/views')).json().items.map((v: { name: string }) => v.name);
    expect(views).toEqual(['Movies', 'TV']);
    const items = (await call(s, 'GET', '/api/library/items?types=Movie,Series&sort=SortName')).json();
    expect(items.items.map((i: { name: string }) => i.name)).toEqual(['Home Video', 'Kinderfilm', 'MAD TEST', 'Test Movie One', 'Test Movie Two']);
    const show = await call(s, 'GET', `/api/items/${item(3)}`);
    expect(show.statusCode).toBe(200);
    expect(show.json().item).toMatchObject({ name: 'MAD TEST', type: 'Series' });
    expect((await call(s, 'GET', `/api/items/${item(3)}/seasons`)).statusCode).toBe(200);
    expect((await call(s, 'GET', `/api/items/${item(424242)}`)).statusCode).toBe(404);
  });

  it('a guest role is capped at 12 by the role template (no kids profile needed)', async () => {
    const s = await env.login(); // (a new admin login would sync the role back from the IdP group)
    const uid = (await env.pool.query('select id from users limit 1')).rows[0].id as string;
    await env.pool.query("update users set role='guest' where id=$1", [uid]);
    const { reapplyRole } = await import('../../src/users.js');
    expect(await reapplyRole(env.ctx, 'guest')).toBe(0);
    const names = (await call(s, 'GET', '/api/library/items?types=Movie,Series')).json().items.map((i: { name: string }) => i.name);
    expect(names).toEqual(['Kinderfilm', 'MAD TEST']);
    expect((await authz(s.cookies.ff_sid!, item(1))).json()).toEqual({ allow: false }); // PG-13 > 12
    await env.pool.query("update users set role='admin' where id=$1", [uid]);
    expect(await reapplyRole(env.ctx, 'admin')).toBe(0);
  });

  it('Block 20: GET /api/home answers every part from the Plex implementation, without the token or Plex paths', async () => {
    const s = await env.login();
    const r = await call(s, 'GET', '/api/home');
    expect(r.statusCode, r.body).toBe(200);
    const home = r.json();
    expect(home.failed).toEqual([]);
    expect(Object.keys(home.parts).sort()).toEqual(['because', 'hero', 'hubs', 'leaving', 'nextup', 'recs', 'resume', 'themed']);
    expect(['Home Video', 'Kinderfilm', 'MAD TEST', 'Test Movie One', 'Test Movie Two']).toContain(home.parts.hero?.name);
    expect(r.body).not.toMatch(/\/library\/|\/video\/:|plex\.test|32400|X-Plex/i);
  });

  it('played / favourite / resume go to FriendFlix tables, never to Plex', async () => {
    const s = await env.login();
    fake.calls.length = 0;
    expect((await call(s, 'POST', '/api/playback/progress', { itemId: item(lib.kid!), playSessionId: 'abcdefgh-1', mediaSourceId: 'm1', positionTicks: 150_000_000, isPaused: false })).statusCode).toBeLessThan(300);
    const rows = (await env.pool.query('select position_ticks from plex_userdata where rating_key=$1', [lib.kid])).rows;
    expect(rows.map((r) => Number(r.position_ticks))).toContain(150_000_000);
    expect(fake.calls.filter((c) => /scrobble|timeline|rate/.test(c.path))).toEqual([]);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('kids profile: capped + unrated blocked on every route and in /internal/authz/item; owner unaffected', async () => {
    const owner = await env.login();
    const r = await call(owner, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 6 });
    expect(r.statusCode, r.body).toBe(201);
    const pid = r.json().profile.id as string;
    const pj = (await env.pool.query('select jellyfin_user_id j from profiles where id=$1', [pid])).rows[0].j as string;
    expect((await env.pool.query('select max_age, block_unrated from plex_media_policies where identity_id=$1', [pj])).rows[0]).toEqual({ max_age: 6, block_unrated: ['Movie', 'Series', 'Trailer'] });
    const sel = await call(owner, 'POST', `/api/profiles/${pid}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: owner.csrf };

    const names = (await call(kid, 'GET', '/api/library/items?types=Movie,Series')).json().items.map((i: { name: string }) => i.name);
    expect(names).toEqual(['Kinderfilm']);
    for (const k of ['1', '2', '3', '5', lib.unrated!]) {
      expect((await call(kid, 'GET', `/api/items/${item(k)}`)).statusCode, k).toBe(404);
      expect((await authz(kid.cookies.ff_sid!, item(k))).json(), k).toEqual({ allow: false });
    }
    expect((await call(kid, 'GET', `/api/items/${item(lib.kid!)}`)).statusCode).toBe(200);
    expect((await authz(kid.cookies.ff_sid!, item(lib.kid!))).json()).toEqual({ allow: true });
    expect((await call(kid, 'GET', `/api/items/${item(3)}/episodes`)).statusCode).toBe(404);
    expect((await call(kid, 'GET', '/api/library/genres')).json().genres).toEqual(['Family']);
    // the account's own identity is unaffected (this device is now locked to the kids profile, so ask the server directly)
    const ownerUser = (await env.pool.query('select * from users limit 1')).rows[0];
    expect((await env.ctx.jf.item(ownerUser, item(lib.unrated!))).name).toBe('Home Video');
  });
});
