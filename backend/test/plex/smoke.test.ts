// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plex-mode smoke test: the whole app (real routes, MEDIA_SERVER=plex) with the PRODUCTION playback wiring of plex/index.ts
 * (playback module + role limits) against the Plex fakes, walked like a viewer: login -> profile -> home rows -> item detail ->
 * playback info -> HLS through the gateway's Plex adapter (path authorization + rewrite) -> progress -> continue watching -> stop
 * (ends the Plex transcode) -> kids profile denied above its cap. Plus the role limits Plex cannot enforce (transcoding, maxStreams).
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlexMediaServer } from '../../src/plex/service.js';
import { cfg, makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';
import { item } from './setup.js';
import { TranscoderFake } from './streamfake.js';

type Sess = { cookies: Record<string, string>; csrf: string };
// the gateway's real Plex adapter (separate package: loaded by path, so the backend's tsconfig rootDir stays untouched)
const GATEWAY_PLEX = join(import.meta.dirname, '../../../gateway/src/upstream/plex.ts');

describe('Plex mode end to end (backend level)', () => {
  let env: TestEnv;
  let tf: TranscoderFake;
  let ms: PlexMediaServer;
  let gw: any;
  const bodies: string[] = [];
  const fake = new PlexFake();
  const kid = fake.addMovie({ title: 'Kinderfilm', rating: 'de/0', genres: ['Family'] });
  const cast = fake.addMovie({ title: 'Ensemble', rating: 'PG', actors: [{ id: 9001, tag: 'Jane Doe', role: 'Hero' }, { id: 9002, tag: 'John Roe' }] });

  beforeAll(async () => {
    env = await makeEnv({}, {
      server: 'plex', plexFake: fake,
      plexFetch: (f) => (tf = new TranscoderFake(f.fetch)).fetch,
    });
    ms = env.plex!.ms;
    const { createPlexUpstream } = await import(GATEWAY_PLEX);
    gw = createPlexUpstream({ token: () => PLEX_TOKEN, secret: () => cfg.INTERNAL_SECRET });
  });
  afterAll(async () => {
    for (const b of bodies) expect(b).not.toContain(PLEX_TOKEN);
    await ms.stop();
    await env.close();
  });

  const call = async (s: Sess, method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
    bodies.push(r.body, JSON.stringify(r.headers));
    return r;
  };
  /** What the gateway does for GET /media<path>: allowlist, authorize (HMAC + backend /internal/authz/item), rewrite, fetch Plex. */
  const viaGateway = async (s: Sess, url: string): Promise<{ status: number; body?: string }> => {
    const u = new URL(url, 'https://portal.test');
    const path = u.pathname.replace(/^\/media/, '');
    if (!gw.paths.some((re: RegExp) => re.test(path))) return { status: 404 };
    const checkItem = async (itemId: string, kind: string) => {
      const r = await env.app.inject({ method: 'POST', url: '/internal/authz/item', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid: s.cookies.ff_sid, itemId, kind } });
      return r.json().allow === true;
    };
    if (!(await gw.authorize({ path, query: u.searchParams, checkItem }))) return { status: 403 };
    const rw = gw.rewrite(path, u.searchParams);
    const q = rw.query.toString();
    const res = await tf.fetch(`${PLEX_URL}${rw.path}${q ? `?${q}` : ''}`, { headers: gw.authHeaders({ token: 'x', deviceId: 'y' }) });
    return { status: res.status, body: await res.text() };
  };
  /** Plex reaps every transcode, the player state is gone (between the limit tests) */
  const endAll = async () => {
    for (const x of tf.sessions.values()) x.stopped = true;
    for (const k of [...(await env.kv.keys('plexstarted:')), ...(await env.kv.keys('plexplay:'))]) await env.kv.del(k);
  };
  const report = (s: Sess, kind: 'start' | 'progress' | 'stop', info: { itemId: string; playSessionId: string; mediaSourceId: string }, positionTicks = 0) =>
    call(s, 'POST', `/api/playback/${kind}`, { itemId: info.itemId, playSessionId: info.playSessionId, mediaSourceId: info.mediaSourceId, positionTicks, isPaused: false });

  it('viewer walk: login, profile, home rows, detail, playback, HLS via the gateway adapter, progress, continue watching, stop', async () => {
    const s = await env.login();
    // profile picker: the owner profile exists and can be selected
    const profiles = (await call(s, 'GET', '/api/profiles')).json().profiles as Array<{ active: boolean }>;
    expect(profiles.filter((p) => p.active)).toHaveLength(1);
    const me = (await call(s, 'GET', '/api/me')).json();
    expect(me.server.kind).toBe('plex');

    // home rows
    expect((await call(s, 'GET', '/api/library/views')).json().items.map((v: { name: string }) => v.name)).toEqual(['Movies', 'TV']);
    const latest = (await call(s, 'GET', '/api/library/items?types=Movie,Series&sort=DateCreated&desc=true&limit=20')).json();
    expect(latest.items.length).toBeGreaterThanOrEqual(4);
    expect((await call(s, 'GET', '/api/library/genres')).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/library/nextup')).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/library/resume')).json().items).toEqual([]);

    // item detail (+ people without images: the gateway serves item images only)
    const detail = (await call(s, 'GET', `/api/items/${item(1)}`)).json().item;
    expect(detail).toMatchObject({ name: 'Test Movie One', type: 'Movie' });
    expect(detail.imageTags?.primary).toMatch(/^\d+$/);
    const people = await call(s, 'GET', `/api/items/${item(cast)}/people`);
    expect(people.statusCode).toBe(200);
    const persons = people.json().people as Array<{ name: string; image: boolean }>;
    expect(persons.map((p) => p.name)).toEqual(['Jane Doe', 'John Roe']);
    for (const p of persons) expect(p.image).toBe(false);
    expect((await call(s, 'GET', `/api/items/${item(1)}/similar`)).statusCode).toBe(200);

    // poster through the gateway adapter: Plex photo transcoder, token as header only
    const img = new URL(`https://x/media/Items/${item(1)}/Images/Primary?maxWidth=300&tag=${detail.imageTags.primary}`);
    expect(gw.rewrite(img.pathname.slice(6), img.searchParams).query.get('url')).toBe(`/library/metadata/1/thumb/${detail.imageTags.primary}`);

    // playback info -> session-bound HLS URL; the transcode was started under the lock
    const pi = await call(s, 'POST', '/api/playback/info', { itemId: item(1) });
    expect(pi.statusCode, pi.body).toBe(200);
    const info = pi.json();
    expect(info.hlsUrl).toMatch(new RegExp(`^/media/Videos/${item(1)}/hls/[0-9a-f]{16}-[0-9a-f]{24}/index\\.m3u8$`));
    expect(tf.sessions.get(info.playSessionId)?.rk).toBe('1');

    // HLS through the gateway adapter: playlist + first segment; a foreign item id with this session never passes
    const pl = await viaGateway(s, info.hlsUrl);
    expect(pl.status).toBe(200);
    expect(pl.body).toContain('00000.ts');
    const seg = await viaGateway(s, info.hlsUrl.replace('index.m3u8', '00000.ts'));
    expect(seg).toMatchObject({ status: 200 });
    expect((await viaGateway(s, info.hlsUrl.replace(item(1), item(2)))).status).toBe(403);

    // progress -> continue watching (FriendFlix tables only, nothing written to Plex)
    const runtime = info.runtimeTicks as number;
    expect((await report(s, 'start', info)).statusCode).toBeLessThan(300);
    expect((await report(s, 'progress', info, Math.round(runtime * 0.3))).statusCode).toBeLessThan(300);
    const resume = (await call(s, 'GET', '/api/library/resume')).json().items as Array<{ id: string; positionTicks: number }>;
    expect(resume.map((i) => i.id)).toEqual([item(1)]);
    expect(resume[0]!.positionTicks).toBe(Math.round(runtime * 0.3));
    expect(fake.calls.filter((c) => /scrobble|timeline|:\/rate/.test(c.path))).toEqual([]);
    expect(tf.calls.filter((c) => /scrobble|timeline|:\/rate/.test(c.path))).toEqual([]);

    // stop -> the Plex transcode ends, the session stops counting as a stream
    expect((await report(s, 'stop', info, Math.round(runtime * 0.31))).statusCode).toBeLessThan(300);
    expect(tf.sessions.get(info.playSessionId)!.stopped).toBe(true);
    expect(await env.kv.keys('plexplay:')).toEqual([]);
  });

  it('role without transcoding: Direct Play only, HLS refused with 403 transcoding_not_allowed (no Plex transcode started)', async () => {
    const s = await env.login();
    const jf = (await env.pool.query('select jellyfin_user_id j from users limit 1')).rows[0].j as string;
    await env.pool.query('update plex_media_policies set transcoding = false where identity_id = $1', [jf]);
    try {
      const starts = tf.calls.filter((c) => c.path.endsWith('/start.m3u8')).length;
      const r = await call(s, 'POST', '/api/playback/info', { itemId: item(2) }); // HEVC: no Direct Play
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'transcoding_not_allowed' });
      expect(tf.calls.filter((c) => c.path.endsWith('/start.m3u8')).length).toBe(starts);
    } finally {
      await env.pool.query('update plex_media_policies set transcoding = true where identity_id = $1', [jf]);
    }
  });

  it('maxStreams per identity: a second title beyond the policy limit is refused until the first one stops', async () => {
    const s = await env.login();
    const jf = (await env.pool.query('select jellyfin_user_id j from users limit 1')).rows[0].j as string;
    await env.pool.query('update plex_media_policies set max_streams = 1 where identity_id = $1', [jf]);
    try {
      const a = (await call(s, 'POST', '/api/playback/info', { itemId: item(1) })).json();
      expect((await report(s, 'start', a)).statusCode).toBeLessThan(300);
      // the same title again (quality / audio switch) is fine, another one is not
      const again = await call(s, 'POST', '/api/playback/info', { itemId: item(1) });
      expect(again.statusCode).toBe(200);
      const b = await call(s, 'POST', '/api/playback/info', { itemId: item(2) });
      expect(b.statusCode).toBe(429);
      expect(b.json()).toEqual({ error: 'max_streams' });
      await report(s, 'stop', a);
      await report(s, 'stop', again.json()); // the player stops the old session before it reloads
      expect((await call(s, 'POST', '/api/playback/info', { itemId: item(2) })).statusCode).toBe(200);
    } finally {
      await env.pool.query('update plex_media_policies set max_streams = null where identity_id = $1', [jf]);
      await endAll();
    }
  });

  it('maxStreams is enforced server-side: without any player report a second title is refused while the first transcode runs', async () => {
    const s = await env.login();
    const jf = (await env.pool.query('select jellyfin_user_id j from users limit 1')).rows[0].j as string;
    await env.pool.query('update plex_media_policies set max_streams = 1 where identity_id = $1', [jf]);
    try {
      const starts2 = () => tf.calls.filter((c) => c.path.endsWith('/start.m3u8') && c.search.includes('%2Flibrary%2Fmetadata%2F2')).length;
      const a = await call(s, 'POST', '/api/playback/info', { itemId: item(1) }); // starts the Plex transcode; no /api/playback/start
      expect(a.statusCode, a.body).toBe(200);
      expect(tf.sessions.get(a.json().playSessionId)?.stopped).toBe(false);
      const n2 = starts2();
      const b = await call(s, 'POST', '/api/playback/info', { itemId: item(2) });
      expect(b.statusCode).toBe(429);
      expect(b.json()).toEqual({ error: 'max_streams' });
      expect(starts2()).toBe(n2);
      // Plex reaps the abandoned transcode (nobody fetches it): the slot is free again
      tf.sessions.get(a.json().playSessionId)!.stopped = true;
      expect((await call(s, 'POST', '/api/playback/info', { itemId: item(2) })).statusCode).toBe(200);
    } finally {
      await env.pool.query('update plex_media_policies set max_streams = null where identity_id = $1', [jf]);
      await endAll();
    }
  });

  it('collections with a composite poster: no composite, the tag names a member the viewer may see (gateway checks it)', async () => {
    const owner = (await env.pool.query('select * from users limit 1')).rows[0];
    const coll = (await ms.collections(owner)).find((c) => c.name === 'Both Movies')!;
    expect(coll.image).toBe(false); // Plex has no untagged poster for a composite collection
    const tag = coll.imageTags!.primary!;
    expect(tag).toMatch(/^m9f1e0[0-9a-f]{27}$/);
    const q = new URLSearchParams({ tag });
    expect(gw.rewrite(`/Items/${coll.id}/Images/Primary`, q).query.get('url')).toBe(`/library/metadata/${BigInt('0x' + tag.slice(6))}/thumb`);
  });

  it('Chromecast: the cast session carries signed /api/cast/subtitle URLs for the extracted Plex subtitles', async () => {
    const s = await env.login();
    const r = await call(s, 'POST', '/api/cast/session', { itemId: item(1) });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    const sub = (j.subtitles as Array<{ index: number; url: string }>).find((x) => x.index === 4)!;
    expect(sub.url).toMatch(new RegExp(`^https://portal\\.example\\.com/api/cast/subtitle/[0-9a-f-]{36}/${j.castId}/\\d+/[\\w-]{43}/${item(1)}/`));
    const v = await env.app.inject({ url: sub.url.replace('https://portal.example.com', '') }); // the receiver: no cookie
    bodies.push(v.body);
    expect(v.statusCode).toBe(200);
    expect(v.body).toContain('00:00:01.000 --> 00:00:03.500');
    await call(s, 'DELETE', `/api/cast/session/${j.castId}`);
    await endAll();
  });

  it('Plan B is refused clearly with Plex (capabilities.planB = false -> /internal/authz-nginx 501)', async () => {
    const r = await env.app.inject({ url: '/internal/authz-nginx', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET, 'x-original-uri': `/media/Items/${item(1)}/Images/Primary` } });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'plan_b_unsupported', kind: 'plex' });
  });

  it('kids profile: titles above the cap are denied for detail, playback and the gateway; an allowed one plays', async () => {
    const owner = await env.login();
    const r = await call(owner, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 6 });
    expect(r.statusCode, r.body).toBe(201);
    const sel = await call(owner, 'POST', `/api/profiles/${r.json().profile.id}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const k: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: owner.csrf };
    const started = tf.sessions.size;
    expect((await call(k, 'GET', `/api/items/${item(1)}`)).statusCode).toBe(404); // PG-13
    expect((await call(k, 'POST', '/api/playback/info', { itemId: item(1) })).statusCode).toBe(404);
    expect((await viaGateway(k, `/media/Items/${item(1)}/Images/Primary?maxWidth=300`)).status).toBe(403);
    expect(tf.sessions.size).toBe(started);
    const ok = await call(k, 'POST', '/api/playback/info', { itemId: item(kid) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await viaGateway(k, ok.json().hlsUrl)).status).toBe(200);
  });
});
