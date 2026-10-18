// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fork (1.1): recommendation engine v2 and the post-play screen on Plex. The optional media hooks (libraryFeatures, libraryRoots,
 * seriesStatus) answered from the library mirror, the R1 index job over a Plex library, and GET /api/items/:id/postplay through the
 * real routes: Plex ids, the viewer's access rules (kids age cap), never "finished" for a series (Plex has no status), no Plex token,
 * address or library path in any answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoIndexState, recoIndexTick, resetRecoIndex } from '../../src/reco/indexJob.js';
import { resetIndexCache } from '../../src/reco/vectors.js';
import type { ItemFeatures } from '../../src/media/types.js';
import { featurePeople, toPlexFeatures } from '../../src/plex/features.js';
import { makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PlexFake } from '../plexfake.js';
import { identity, item, kids, plexEnv, tag, type PlexEnv } from './setup.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const leakFree = (s: string) => {
  expect(s).not.toContain(PLEX_TOKEN);
  expect(s).not.toContain('plex.test');
  expect(s).not.toContain('/library/');
  expect(s.toLowerCase()).not.toContain('x-plex-token');
};

/** a library with credits, labels, a collection, a kids film and a kids show */
function seed(f: PlexFake) {
  const ids = {
    mars: f.addMovie({
      title: 'Mars Trip', rating: 'PG-13', year: 2021, genres: ['Science Fiction', 'Drama'], labels: ['space'], studio: 'Studio Nord', audienceRating: 8.4,
      summary: 'A long trip to Mars.', directors: [{ id: 8101, tag: 'Dir One' }, { id: 8102, tag: 'Dir Two' }, { id: 8103, tag: 'Dir Three' }],
      writers: [{ id: 8201, tag: 'Writer One' }],
      actors: [9101, 9102, 9103, 9104, 9105, 9106].map((id) => ({ id, tag: `Actor ${id}` })),
    }),
    moon: f.addMovie({ title: 'Moon Base', rating: 'PG-13', genres: ['Science Fiction'], actors: [{ id: 9101, tag: 'Actor 9101' }] }),
    kidFilm: f.addMovie({ title: 'Little Fox', rating: 'de/0', genres: ['Family', 'Science Fiction'] }),
    kidFilm2: f.addMovie({ title: 'Little Owl', rating: 'de/0', genres: ['Family'] }),
  };
  const show = f.addShow({ title: 'Kids Show', rating: 'de/0', episodeRating: 'de/0', episodes: 3 });
  return { ...ids, show };
}

describe('Plex libraryFeatures / libraryRoots / seriesStatus (mirror only)', () => {
  let e: PlexEnv;
  let lib: ReturnType<typeof seed>;
  beforeAll(async () => {
    e = await plexEnv((f) => { lib = seed(f); });
  });
  afterAll(() => e.close());

  const all = async () => {
    const out: ItemFeatures[] = [];
    for (let start = 0; ; start += 3) {
      const page = await e.ms.libraryFeatures(start, 3);
      out.push(...page);
      if (page.length < 3) return out;
    }
  };

  it('capabilities.libraryFeatures is on; films and shows only, in rating key order, paged without gaps or repeats', async () => {
    expect(e.ms.capabilities.libraryFeatures).toBe(true);
    const f = await all();
    const want = (await e.pool.query<{ rating_key: string }>(`select rating_key from plex_items where type in ('movie', 'show') order by rating_key`)).rows.map((r) => item(r.rating_key));
    expect(f.map((x) => x.id)).toEqual(want);
    expect(new Set(f.map((x) => x.type))).toEqual(new Set(['Movie', 'Series']));
    leakFree(JSON.stringify(f));
  });

  it('a film: genres, labels as tags, studios, 2 directors + the writer + actors in billing order (8), year, runtime, ratings, overview', async () => {
    const [m] = await e.ms.libraryFeatures(0, 10, { ids: [item(lib.mars)] });
    expect(m).toMatchObject({
      id: item(lib.mars), type: 'Movie', genres: ['Science Fiction', 'Drama'], tags: ['space'], year: 2021, communityRating: 8.4, overview: 'A long trip to Mars.',
    });
    expect(m!.studios).toContain('Studio Nord');
    expect(m!.people).toEqual([tag(8101), tag(8102), tag(8201), tag(9101), tag(9102), tag(9103), tag(9104), tag(9105)]);
    expect(m!.runtimeMin).toBeGreaterThan(0);
    // Plex knows no original language and no series status
    expect(m!.originalLanguage).toBeUndefined();
    expect(m!.seriesStatus).toBeUndefined();
  });

  it('a show: Series with its own tags, never a status; collections come from plex_collection_items', async () => {
    const [s] = await e.ms.libraryFeatures(0, 10, { ids: [item(lib.show.show)] });
    expect(s).toMatchObject({ id: item(lib.show.show), type: 'Series' });
    expect(s!.seriesStatus).toBeUndefined();
    const coll = (await e.pool.query<{ collection_key: string; item_key: string }>('select collection_key, item_key from plex_collection_items order by item_key limit 1')).rows[0]!;
    const [member] = await e.ms.libraryFeatures(0, 10, { ids: [item(coll.item_key)] });
    expect(member!.collectionId).toBe(item(coll.collection_key));
  });

  it('ids: episodes, seasons, foreign and unknown ids are left out; savedSince filters by the mirror change time', async () => {
    const got = await e.ms.libraryFeatures(0, 50, { ids: [item(lib.show.episodes[0]!), item(lib.show.season), 'a'.repeat(32), item(999999), item(lib.moon)] });
    expect(got.map((x) => x.id)).toEqual([item(lib.moon)]);
    expect(await e.ms.libraryFeatures(0, 50, { ids: ['a'.repeat(32)] })).toEqual([]);
    expect(await e.ms.libraryFeatures(0, 50, { savedSince: new Date(Date.now() + 3600_000).toISOString() })).toEqual([]);
    expect((await e.ms.libraryFeatures(0, 50, { savedSince: '2000-01-01T00:00:00Z' })).length).toBe((await all()).length);
  });

  it('libraryRoots: an episode -> its show, a film / show -> itself, a season or an unknown id is absent', async () => {
    const r = await e.ms.libraryRoots([item(lib.show.episodes[1]!), item(lib.mars), item(lib.show.show), item(lib.show.season), item(999999), 'a'.repeat(32)]);
    expect(Object.fromEntries(r)).toEqual({
      [item(lib.show.episodes[1]!)]: item(lib.show.show), [item(lib.mars)]: item(lib.mars), [item(lib.show.show)]: item(lib.show.show),
    });
    expect((await e.ms.libraryRoots([])).size).toBe(0);
  });

  it('seriesStatus: unknown (null) for a visible show, 404 for a film or a show above a kids cap', async () => {
    const owner = await identity(e.ms, 'admin');
    expect(await e.ms.seriesStatus(owner, item(lib.show.show))).toBeNull();
    await expect(e.ms.seriesStatus(owner, item(lib.mars))).rejects.toMatchObject({ status: 404 });
    const kid = await identity(e.ms, 'friend', kids(6));
    await expect(e.ms.seriesStatus(kid, item(3))).rejects.toMatchObject({ status: 404 }); // the fixture show is TV-PG
    expect(await e.ms.seriesStatus(kid, item(lib.show.show))).toBeNull();
  });

  it('pure mappers: people quota and dedup, ratings, empty values left out', () => {
    const people = featurePeople([
      { kind: 'actor', tag: 'A', tag_id: '5', pos: 1 }, { kind: 'actor', tag: 'B', tag_id: '4', pos: 0 }, { kind: 'director', tag: 'D', tag_id: '5', pos: 0 },
      { kind: 'writer', tag: 'W', tag_id: null, pos: 0 },
    ]);
    expect(people).toEqual([tag(5), tag(4)]); // director first, the same person as an actor once, a writer without id skipped
    const f = toPlexFeatures({
      rating_key: '7', type: 'movie', year: 0, duration_ms: null, summary: '  ', tagline: null, studio: null, audience_rating: null, critic_rating: 7.5,
      rating_image: 'rottentomatoes://image.rating.ripe', audience_rating_image: null, collection_key: null,
    }, []);
    expect(f).toEqual({ id: item(7), type: 'Movie', genres: [], tags: [], studios: [], people: [], countries: [], criticRating: 75 });
  });
});

describe('Plex: index job, engine v2 and the post-play screen through the routes', () => {
  let env: TestEnv;
  let owner: Sess;
  const fake = new PlexFake();
  const lib = seed(fake);
  const call = async (s: Sess, method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
    leakFree(r.body);
    leakFree(JSON.stringify(r.headers));
    return r;
  };
  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake });
    owner = await env.login();
    await call(owner, 'GET', '/api/me'); // provisions the identity
    resetRecoIndex();
    await recoIndexTick(env.ctx, { full: true, pauseMs: 0 });
    env.ctx.cfg = { ...env.ctx.cfg, RECO_ENGINE: 'v2' };
    resetIndexCache(env.ctx);
  });
  afterAll(async () => {
    resetIndexCache(env.ctx);
    await env.plex!.ms.stop();
    await env.close();
  });

  it('the index job indexes every film and show of the Plex library with Plex ids', async () => {
    const st = await recoIndexState(env.ctx);
    expect(st.supported).toBe(true);
    const rows = (await env.pool.query<{ item_id: string; type: string; people: string[] }>('select item_id, type, people from item_features order by item_id')).rows;
    const want = (await env.pool.query<{ rating_key: string }>(`select rating_key from plex_items where type in ('movie', 'show')`)).rows.map((r) => item(r.rating_key)).sort();
    expect(rows.map((r) => r.item_id)).toEqual(want);
    expect(rows.find((r) => r.item_id === item(lib.mars))!.people).toHaveLength(8);
  });

  it('the last episode of a show: "caught up" (never "finished": Plex keeps no series status), rows the viewer may see', async () => {
    const u = (await env.pool.query('select * from users limit 1')).rows[0];
    for (const ep of lib.show.episodes) await env.plex!.ms.setPlayed(u, item(ep), true);
    const r = await call(owner, 'GET', `/api/items/${item(lib.show.episodes[2]!)}/postplay`);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.state).toBe('caught_up');
    expect(p.nextAirDate).toBeNull();
    expect(p.remind).toBeNull();
    await env.plex!.ms.setPlayed(u, item(lib.show.episodes[1]!), false);
    const first = await call(owner, 'GET', `/api/items/${item(lib.show.episodes[0]!)}/postplay`);
    expect(first.json().state).toBe('next');
    expect(first.json().next.id).toBe(item(lib.show.episodes[1]!));
  });

  it('a film: movie_end, the rows come from engine v2 or its v1 fallback, every title visible to the viewer', async () => {
    const u = (await env.pool.query('select * from users limit 1')).rows[0];
    await env.plex!.ms.setPlayed(u, item(lib.mars), true);
    const r = await call(owner, 'GET', `/api/items/${item(lib.mars)}/postplay`);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.state).toBe('movie_end');
    expect(p.engine).toBe('v2'); // the index over the Plex mirror feeds engine v2
    expect(p.rows.length).toBeGreaterThan(0);
    const ids: string[] = p.rows.flatMap((x: { items: Array<{ id: string }> }) => x.items.map((i) => i.id));
    expect(ids).not.toContain(item(lib.mars));
    for (const id of ids) expect(id).toMatch(/^9f1e0[0-9a-f]{27}$/);
  });

  it('kids profile: post-play of a title above the cap is 404; its rows never hold a title above the cap', async () => {
    const r = await call(owner, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 6 });
    expect(r.statusCode, r.body).toBe(201);
    const sel = await call(owner, 'POST', `/api/profiles/${r.json().profile.id}/select`, {});
    const k: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: owner.csrf };
    expect((await call(k, 'GET', `/api/items/${item(lib.mars)}/postplay`)).statusCode).toBe(404);
    const p = await call(k, 'GET', `/api/items/${item(lib.kidFilm)}/postplay`);
    expect(p.statusCode, p.body).toBe(200);
    const body = p.json();
    const ids: string[] = body.rows.flatMap((x: { items: Array<{ id: string }> }) => x.items.map((i) => i.id));
    for (const bad of [item(lib.mars), item(lib.moon), item(1), item(2), item(3)]) expect(ids).not.toContain(bad);
    expect(body.rows.map((x: { kind: string }) => x.kind)).not.toContain('friends');
    for (const id of ids) expect((await call(k, 'GET', `/api/items/${id}`)).statusCode).toBe(200);
  });
});
