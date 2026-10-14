// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 17 / 18 features behind the real routes with MEDIA_SERVER=plex (makeEnv({ server: 'plex' })): chapters, cast & info,
 * facts (quality chips, leaving soon), the 4K / HDR browse filter (quality index from libraryMediaTraits), story so far, fresh
 * badges, themed lists and the admin pages that touch the media server (summary, live streams + stop, previews).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qualityIndexTick } from '../../src/fresh.js';
import { setLive } from '../../src/live.js';
import type { MediaUser } from '../../src/media/types.js';
import { makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PlexFake } from '../plexfake.js';
import { item } from './setup.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Block 17 / 18 on Plex behind the FriendFlix routes', () => {
  let env: TestEnv;
  let s: Sess;
  let owner: MediaUser;
  const fake = new PlexFake();
  const lib: Record<string, string> = {};
  const bodies: string[] = [];
  lib.chap = fake.addChapterMovie();
  lib.uhd = fake.addMovie({ title: 'Ultra Film', rating: 'PG', studio: 'Big Studio', actors: [{ id: 601, tag: 'Ann Actor', role: 'Thief' }], directors: [{ id: 603, tag: 'Dee Director' }] });
  fake.setStreams(lib.uhd, { width: 3840, height: 2160, DOVIPresent: true, colorTrc: 'smpte2084' }, [{ channels: 8, displayTitle: 'English (TrueHD 7.1 Atmos)' }]);
  // story so far needs overviews: the fixture show has none (local files)
  fake.items.get('4')!.summary = 'Sam and Tom meet.';
  fake.items.get('7')!.summary = 'The season ends on a cliffhanger.';

  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake });
    s = await env.login();
    owner = (await env.pool.query('select * from users limit 1')).rows[0];
  });
  afterAll(async () => {
    for (const b of bodies) expect(b).not.toContain(PLEX_TOKEN);
    await env.close();
  });

  const call = async (method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
    bodies.push(r.body, JSON.stringify(r.headers));
    return r;
  };

  it('capabilities: chapters on (the library has chapter marks)', async () => {
    expect((await call('GET', '/api/me')).json().server.capabilities.chapters).toBe(true);
  });

  it('chapters: the "Szenen" panel gets the real chapter marks with signed stills', async () => {
    const r = (await call('GET', `/api/items/${item(lib.chap!)}/chapters`)).json();
    expect(r.supported).toBe(true);
    expect(r.chapters.map((c: { start: number; name: string }) => [c.start, c.name])).toEqual([[0, 'Opening'], [20, 'The Heist'], [40, '']]);
    expect(r.chapters[1].image).toMatch(new RegExp(`^/media/Items/${item(lib.chap!)}/Images/Chapter/2\\?media=11&sig=[0-9a-f]{32}&maxWidth=320$`));
    expect((await call('GET', `/api/items/${item(1)}/chapters`)).json()).toEqual({ supported: true, chapters: [] });
    expect((await call('GET', `/api/items/${item(424242)}/chapters`)).statusCode).toBe(404);
  });

  it('cast & info: actors with character names, crew, studio; episodes take the regulars from the series', async () => {
    const r = (await call('GET', `/api/items/${item(lib.uhd!)}/castinfo`)).json();
    expect(r.cast).toEqual([expect.objectContaining({ name: 'Ann Actor', role: 'Thief' })]);
    expect(r.directors).toEqual([expect.objectContaining({ name: 'Dee Director' })]);
    expect(r.studios).toEqual(['Big Studio']);
    const ep = (await call('GET', `/api/items/${item(5)}/castinfo`)).json();
    expect(ep.cast[0]).toMatchObject({ name: 'Teo Brandvik', role: 'Sam' });
    expect(ep.guests).toEqual([]);
  });

  it('facts: quality chips from the mirrored streams + leaving soon set by the admin', async () => {
    expect((await call('PUT', `/api/admin/leaving/${item(lib.uhd!)}`, { leavesAt: inDays(5), note: 'licence ends' })).statusCode).toBe(200);
    const f = (await call('GET', `/api/items/${item(lib.uhd!)}/facts`)).json();
    expect(f.traits).toEqual({ resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' });
    expect(f.leaving).toMatchObject({ leavesAt: inDays(5), days: 5 });
    expect((await call('GET', '/api/library/leaving')).json().items.map((i: { id: string }) => i.id)).toEqual([item(lib.uhd!)]);
    const b = (await call('POST', '/api/discover/badges', { ids: [item(lib.uhd!), item(1), item(3)] })).json().badges;
    expect(b[item(lib.uhd!)]).toEqual({ daysLeft: 5, fresh: 'new' }); // fresh label from the mirror's addedAt
    expect((await call('GET', '/api/admin/leaving')).json().items[0]).toMatchObject({ itemId: item(lib.uhd!), name: 'Ultra Film', type: 'Movie' });
  });

  it('browse filter 4K / HDR: the quality index is built from libraryMediaTraits', async () => {
    await qualityIndexTick(env.ctx, { force: true });
    const k4 = (await call('GET', '/api/library/quality?quality=4k')).json();
    expect(k4.items.map((i: { name: string }) => i.name)).toEqual(['Ultra Film']);
    expect((await call('GET', '/api/library/quality?quality=hdr&types=Series')).json().items).toEqual([]);
  });

  it('story so far: after finishing season 1 the series shows the recap', async () => {
    for (const k of ['5', '6', '7']) await env.ctx.jf.setPlayed(owner, item(k), true);
    const r = (await call('GET', `/api/items/${item(3)}/story`)).json();
    expect(r.story).toMatchObject({ reason: 'newSeason', season: { number: 1, overview: 'Sam and Tom meet.' }, episode: { id: item(7), overview: 'The season ends on a cliffhanger.' }, next: { id: item(9) } });
  });

  it('themed lists answer on Plex (no media-server specifics)', async () => {
    expect((await call('GET', '/api/lists/themed')).statusCode).toBe(200);
  });

  it('admin: summary pings Plex, live streams list + stop ends the Plex transcode via stopEncoding, previews list the library', async () => {
    const sum = (await call('GET', '/api/admin/summary')).json();
    expect(sum.services.jellyfin).toBe(true); // "Medienserver" in the UI
    const uid = (await env.pool.query('select id from users limit 1')).rows[0].id as string;
    await setLive(env.ctx, { userId: uid, userName: 'Admin', itemId: item(1), title: 'Test Movie One', positionTicks: 0, isPaused: false, playSessionId: 'ps-plex-1', updatedAt: Date.now(), source: 'portal' });
    expect((await call('GET', '/api/admin/live')).json().sessions.map((x: { playSessionId: string }) => x.playSessionId)).toEqual(['ps-plex-1']);
    const stopped: string[] = [];
    const orig = env.ctx.jf.stopEncoding.bind(env.ctx.jf);
    env.ctx.jf.stopEncoding = async (_u, ps) => { stopped.push(ps); };
    try {
      expect((await call('POST', '/api/admin/live/stop', { userId: uid, playSessionId: 'ps-plex-1' })).statusCode).toBe(200);
    } finally {
      env.ctx.jf.stopEncoding = orig;
    }
    expect(stopped).toEqual(['ps-plex-1']);
    expect((await call('GET', '/api/admin/live')).json().sessions).toEqual([]);
    expect(await env.ctx.jf.admin.externalSessions()).toEqual([]); // Plex clients outside FriendFlix are not listed
    const pv = await call('GET', '/api/admin/previews?limit=50');
    expect(pv.statusCode).toBe(200);
    expect(pv.json().summary.total).toBeGreaterThan(0);
  });
});
