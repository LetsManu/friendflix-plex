// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/db.js';
import { MemoryKV } from '../../src/kv.js';
import type { MediaEvent } from '../../src/media/types.js';
import { PlexClient } from '../../src/plex/client.js';
import { PlexMediaServer } from '../../src/plex/service.js';
import { migratePlex, PLEX_MIGRATIONS } from '../../src/plex/migrations.js';
import { MISSING_PASSES } from '../../src/plex/sync.js';
import { resetDb } from '../helpers.js';
import { fixture, PLEX_TEST_SECRET, PLEX_TOKEN, PLEX_URL, PlexFake, plexServer } from '../plexfake.js';
import { identity, item, kids, plexEnv, type PlexEnv } from './setup.js';

let env: PlexEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});
const rt = (events: MediaEvent[]) => ({ dispatch: async (e: MediaEvent) => void events.push(e), log: { warn: () => undefined, info: () => undefined } });

describe('fork migrations', () => {
  it('own version table + lock, idempotent, upstream schema_migrations untouched', async () => {
    const pool = await resetDb();
    try {
      await Promise.all([migratePlex(pool), migratePlex(pool)]);
      await migratePlex(pool);
      expect((await pool.query('select version from plex_schema_migrations order by version')).rows.map((r) => r.version)).toEqual(PLEX_MIGRATIONS.map((_, i) => i + 1));
      expect(Number((await pool.query('select count(*) n from schema_migrations')).rows[0].n)).toBe(MIGRATIONS.length);
      for (const t of ['plex_items', 'plex_tags', 'plex_sections', 'plex_userdata', 'plex_media_policies', 'plex_identities', 'plex_ratings']) {
        expect((await pool.query('select to_regclass($1) r', [t])).rows[0].r).toBe(t);
      }
    } finally {
      await pool.end();
    }
  });
});

describe('PlexClient', () => {
  it('pages with X-Plex-Container-Start/-Size until totalSize', async () => {
    const fake = new PlexFake();
    const c = new PlexClient(PLEX_URL, PLEX_TOKEN, fake.fetch);
    const pages: number[] = [];
    for await (const p of c.paged('/library/sections/2/all?type=4', 4)) pages.push(p.length);
    expect(pages).toEqual([4, 2]);
    expect(fake.calls.map((x) => x.search)).toEqual(['?type=4&X-Plex-Container-Start=0&X-Plex-Container-Size=4', '?type=4&X-Plex-Container-Start=4&X-Plex-Container-Size=4']);
  });
  it('refuses non server-relative paths; errors carry status, never the token or the query', async () => {
    const fake = new PlexFake();
    const c = new PlexClient(PLEX_URL, PLEX_TOKEN, fake.fetch);
    for (const p of ['http://evil/x', '//evil/x', '/\\evil', 'library', '/a\nb']) expect(() => c.url(p)).toThrow(/server-relative/);
    const bad = new PlexClient(PLEX_URL, 'wrong-token', fake.fetch);
    const err = await bad.json('/library/sections?secret=1').catch((e: Error & { status: number }) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(String((err as Error).message)).not.toMatch(/secret|wrong-token/);
    expect(c.websocketUrl()).toBe(`ws://plex.test:32400/:/websockets/notifications?X-Plex-Token=${PLEX_TOKEN}`);
  });
  it('ping uses /identity', async () => {
    const fake = new PlexFake();
    expect(await new PlexClient(PLEX_URL, PLEX_TOKEN, fake.fetch).ping()).toBe(true);
    fake.fail = { re: /identity/, status: 503 };
    expect(await new PlexClient(PLEX_URL, PLEX_TOKEN, fake.fetch).ping()).toBe(false);
  });
});

describe('PlexSync', () => {
  it('mirrors sections, items, seasons, episodes, collections, extras, tags with ids, guids and streams (no file paths)', async () => {
    env = await plexEnv();
    const { pool, fake } = env;
    const types = (await pool.query("select type, count(*)::int n from plex_items group by type order by type")).rows;
    expect(types).toEqual([{ type: 'clip', n: 1 }, { type: 'collection', n: 1 }, { type: 'episode', n: 6 }, { type: 'movie', n: 2 }, { type: 'season', n: 2 }, { type: 'show', n: 1 }]);
    expect((await pool.query('select section_id, type, title from plex_sections order by section_id')).rows).toEqual([{ section_id: 1, type: 'movie', title: 'Movies' }, { section_id: 2, type: 'show', title: 'TV' }]);
    const actors = (await pool.query("select tag, tag_id, role from plex_tags where rating_key = 3 and kind = 'actor' order by pos limit 2")).rows;
    expect(actors).toEqual([{ tag: 'Teo Brandvik', tag_id: '10', role: 'Sam' }, { tag: 'Joss Marlowe', tag_id: '11', role: 'Tom' }]);
    expect((await pool.query('select guids from plex_items where rating_key = 3')).rows[0].guids).toEqual(['tvdb://370160']);
    expect((await pool.query('select item_key from plex_collection_items where collection_key = 12 order by pos')).rows.map((r) => r.item_key)).toEqual(['1', '2']);
    const media = JSON.stringify((await pool.query('select media from plex_items where media is not null')).rows);
    expect(media).toContain('"languageCode":"jpn"');
    expect(media).not.toContain('"file"');
    expect(media).not.toContain('/media/');
    // details are fetched in multi-key batches, with guids / markers / extras
    const detail = fake.calls.filter((c) => c.path.startsWith('/library/metadata/'));
    expect(detail.length).toBe(1);
    expect(detail[0]!.search).toBe('?includeGuids=1&includeMarkers=1&includeExtras=1&includeChapters=1');
    // a second pass without changes fetches no details
    fake.calls.length = 0;
    const r = await env.ms.sync.run();
    expect(r).toMatchObject({ added: [], removed: [], details: 0 });
    expect(fake.calls.some((c) => c.path.startsWith('/library/metadata/'))).toBe(false);
  });

  it('emits itemAdded (with tmdb id / series + numbers) and itemRemoved after the first pass, never on it', async () => {
    const events: MediaEvent[] = [];
    const pool = await resetDb();
    const fake = new PlexFake();
    const { ms } = plexServer(pool, new MemoryKV(), fake);
    env = { pool, ms, fake, kv: new MemoryKV(), close: async () => { await ms.stop(); await pool.end(); } };
    await ms.start(rt(events));
    await ms.sync.run();
    expect(events).toEqual([]);
    const m = fake.addMovie({ title: 'New Film', rating: 'PG', guids: ['tmdb://4603', 'imdb://tt0004603'] });
    const s = fake.addShow({ title: 'New Show', rating: 'TV-14', episodes: 1, guids: ['tmdb://4399'] });
    await ms.sync.run();
    expect(events).toEqual(expect.arrayContaining([
      { type: 'itemAdded', itemId: item(m), itemType: 'Movie', tmdbId: 4603 },
      { type: 'itemAdded', itemId: item(s.show), itemType: 'Series', tmdbId: 4399 },
      { type: 'itemAdded', itemId: item(s.episodes[0]!), itemType: 'Episode', seriesId: item(s.show), season: 1, episode: 1 },
    ]));
    expect(events.length).toBe(3);
    events.length = 0;
    fake.remove(m);
    await ms.sync.run();
    expect(events).toEqual([{ type: 'itemRemoved', itemId: item(m), itemType: 'Movie' }]); // fork (1.1): with its type
  });

  it('a vanished section takes its items along; a new one is picked up', async () => {
    env = await plexEnv();
    const u = await identity(env.ms, 'admin');
    const id = env.fake.addSection('Docs', 'movie');
    env.fake.addMovie({ title: 'Doc One', rating: 'G', sectionId: id });
    await env.ms.sync.run();
    expect((await env.ms.views(u)).map((v) => v.name)).toEqual(['Movies', 'TV', 'Docs']);
    env.fake.sections = env.fake.sections.filter((s) => s.title !== 'TV');
    // a section is only dropped after MISSING_PASSES consecutive passes without it (a PMS hiccup never wipes a library)
    for (let i = 1; i < MISSING_PASSES; i++) {
      expect((await env.ms.sync.run()).removed).toEqual([]);
      expect((await env.ms.views(u)).map((v) => v.name)).toEqual(['Movies', 'TV', 'Docs']);
    }
    const r = await env.ms.sync.run();
    expect(r.removed.sort()).toEqual(['10', '11', '3', '4', '5', '6', '7', '8', '9']);
    expect((await env.ms.views(u)).map((v) => v.name)).toEqual(['Movies', 'Docs']);
    await expect(env.ms.item(u, item(3))).rejects.toMatchObject({ status: 404 });
  });

  it('websocket timeline events (state 5 / 9) mark items stale; the next pass refetches their details', async () => {
    env = await plexEnv();
    const frames = fixture('ws_timeline') as string[];
    for (const f of frames) await env.ms.sync.onNotification(f);
    await env.ms.sync.onNotification('not json');
    const stale = (await env.pool.query('select rating_key from plex_items where detail_at is null order by rating_key')).rows.map((r) => r.rating_key);
    expect(stale).toEqual(['4', '8', '9']); // seasons never had details; episode 9 got a state-5 event
    env.fake.items.get('9')!.Genre = [{ id: 99, tag: 'Edited' }];
    env.fake.calls.length = 0;
    await env.ms.sync.run();
    expect(env.fake.calls.find((c) => c.path.startsWith('/library/metadata/'))?.path).toBe('/library/metadata/9');
    expect((await env.pool.query("select tag from plex_tags where rating_key = 9 and kind = 'genre'")).rows).toEqual([{ tag: 'Edited' }]);
  });

  it('Plex down: the pass fails, the mirror (and access) stay as they were', async () => {
    env = await plexEnv();
    const u = await identity(env.ms, 'admin');
    env.fake.fail = { re: /^\/library\//, status: 500 };
    await expect(env.ms.sync.run()).rejects.toMatchObject({ status: 500 });
    expect((await env.ms.items(u, {})).total).toBe(3);
    env.fake.fail = null;
    await expect(env.ms.sync.run()).resolves.toMatchObject({ removed: [] });
  });

  it('concurrent run() calls share one pass', async () => {
    env = await plexEnv();
    env.fake.calls.length = 0;
    const [a, b] = await Promise.all([env.ms.sync.run(), env.ms.sync.run()]);
    expect(a).toBe(b);
    await new Promise((r) => setTimeout(r, 50));
    await env.ms.sync.run();
  });
});

describe('sync robustness (fail closed, no wipe on a bad answer)', () => {
  it('a re-rated title stays hidden from a capped profile when the pass aborts before the ages are recomputed', async () => {
    let rk = '';
    env = await plexEnv((f) => (rk = f.addMovie({ title: 'Was PG', rating: 'PG' })));
    const kid = await identity(env.ms, 'friend', kids(12));
    expect((await env.ms.item(kid, item(rk))).name).toBe('Was PG');
    env.fake.setRating(rk, 'R'); // PG (10) -> R (17), section 1
    env.fake.fail = { re: /^\/library\/sections\/2\/all/, status: 500 }; // the TV section's listing fails: the pass aborts
    await expect(env.ms.sync.run()).rejects.toThrow();
    env.ms.forgetItems();
    await expect(env.ms.item(kid, item(rk))).rejects.toMatchObject({ status: 404 });
    expect((await env.ms.items(kid, { types: 'Movie' })).items.map((i) => i.name)).not.toContain('Was PG');
    env.fake.fail = null;
    await env.ms.sync.run();
    env.ms.forgetItems();
    await expect(env.ms.item(kid, item(rk))).rejects.toMatchObject({ status: 404 });
  });

  it('upsertCore nulls the ages of a re-rated show and everything inheriting from it until refreshAges runs', async () => {
    env = await plexEnv();
    const { coreRow, upsertCore } = await import('../../src/plex/mirror.js');
    const show = { ...env.fake.items.get('3')!, contentRating: 'TV-MA' };
    await upsertCore(env.pool, [coreRow(show, 2)!]);
    const r = await env.pool.query(`select rating_key, age_req, age_opt from plex_items where rating_key = 3 or parent_key = 3 or grandparent_key = 3`);
    expect(r.rows.length).toBeGreaterThan(3);
    for (const x of r.rows) expect([x.rating_key, x.age_req, x.age_opt]).toEqual([x.rating_key, null, null]);
    // unchanged rating: ages stay
    await env.ms.sync.run();
    const before = (await env.pool.query('select age_req from plex_items where rating_key = 1')).rows[0].age_req;
    await upsertCore(env.pool, [coreRow({ ...env.fake.items.get('1')!, title: 'Renamed' }, 1)!]);
    expect((await env.pool.query('select age_req from plex_items where rating_key = 1')).rows[0].age_req).toBe(before);
  });

  it('an empty section list never wipes the mirror, an empty section listing only after MISSING_PASSES passes; no event storm', async () => {
    env = await plexEnv();
    const events: MediaEvent[] = [];
    (env.ms.sync as unknown as { rt: unknown }).rt = rt(events);
    const u = await identity(env.ms, 'admin');
    const count = async () => Number((await env!.pool.query('select count(*) n from plex_items')).rows[0].n);
    const n = await count();
    const sections = env.fake.sections;
    env.fake.sections = [];
    for (let i = 0; i < MISSING_PASSES + 2; i++) expect((await env.ms.sync.run()).removed).toEqual([]);
    expect(await count()).toBe(n);
    expect((await env.ms.views(u)).map((v) => v.name)).toEqual(['Movies', 'TV']);
    env.fake.sections = sections;
    expect(await env.ms.sync.run()).toMatchObject({ added: [], removed: [] });
    // one section answers with an empty listing (but the section itself is still there)
    const items = env.fake.items;
    const movies = [...items.entries()].filter(([, m]) => m.librarySectionID === 1 && m.type === 'movie');
    for (const [k] of movies) items.delete(k);
    for (let i = 1; i < MISSING_PASSES; i++) expect((await env.ms.sync.run()).removed).toEqual([]);
    for (const [k, m] of movies) items.set(k, m);
    expect(await env.ms.sync.run()).toMatchObject({ added: [], removed: [] });
    expect(await count()).toBe(n);
    expect(events).toEqual([]);
  });
});


// fork Task 8: a PLEX_URL saved for another Plex server (another machineIdentifier) must not leave the old server's mirror behind
// (rating keys and section ids are per server: they would collide with the new one's); the same server under a new URL keeps it.
describe('server guard (machineIdentifier)', () => {
  const OLD = fixture('identity').MediaContainer.machineIdentifier as string;
  const stored = async (pool: PlexEnv['pool']) => (await pool.query("select v #>> '{}' id from plex_sync_state where k = 'machine_identifier'")).rows[0]?.id;
  /** a new PlexMediaServer on the same database, as a PLEX_* save builds one (`url`: the address it calls) */
  const swap = (e: PlexEnv, fake: PlexFake, url = PLEX_URL) => {
    const ms = new PlexMediaServer({ client: new PlexClient(url, PLEX_TOKEN, fake.fetch), db: e.pool, kv: e.kv, migrate: () => migratePlex(e.pool), websocket: false, secret: PLEX_TEST_SECRET });
    const events: MediaEvent[] = [];
    const warns: Array<[unknown, string]> = [];
    (ms.sync as unknown as { rt: unknown }).rt = { dispatch: async (x: MediaEvent) => void events.push(x), log: { warn: (o: unknown, m: string) => void warns.push([o, m]), info: () => undefined } };
    const close = e.close;
    e.close = async () => { await ms.stop(); await close(); };
    return { ms, events, warns };
  };
  /** another server: only a TV section (id 2, the same as the old one's) with one show of its own under colliding rating keys */
  const otherServer = () => {
    const f = new PlexFake();
    f.machineIdentifier = 'another-plex-server-0000000000000000000';
    f.sections = f.sections.filter((s) => s.title === 'TV');
    for (const [k, m] of [...f.items]) if (m.librarySectionID === 1) f.items.delete(k);
    f.items.get('3')!.title = 'Other Show';
    return f;
  };
  const keys = async (pool: PlexEnv['pool']) => (await pool.query('select rating_key from plex_items order by rating_key')).rows.map((r) => String(r.rating_key));

  it('the first pass stores the identifier; another server rebuilds the mirror (stale items gone, no events), logged once without the token', async () => {
    env = await plexEnv();
    expect(await stored(env.pool)).toBe(OLD);
    expect(await keys(env.pool)).toContain('1'); // a movie of the old server
    const { ms, events, warns } = swap(env, otherServer());
    const r = await ms.sync.run();
    expect(await stored(env.pool)).toBe('another-plex-server-0000000000000000000');
    // the Movies section and its items are gone at once (no MISSING_PASSES grace: they belonged to the other server)
    expect((await env.pool.query('select section_id, title from plex_sections')).rows).toEqual([{ section_id: 2, title: 'TV' }]);
    expect((await env.pool.query("select count(*)::int n from plex_items where section_id = 1 or type in ('movie', 'collection')")).rows[0].n).toBe(0);
    expect((await env.pool.query('select title from plex_items where rating_key = 3')).rows[0].title).toBe('Other Show');
    expect((await env.pool.query('select count(*)::int n from plex_collection_items')).rows[0].n).toBe(0);
    // rebuilt like a first pass: no itemAdded / itemRemoved storm
    expect(r.removed).toEqual([]);
    expect(events).toEqual([]);
    expect(warns.filter(([, m]) => /server changed/.test(m))).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain(PLEX_TOKEN);
    // later passes: same server, nothing cleared or logged again; changes are events again
    const before = await keys(env.pool);
    await ms.sync.run();
    expect(await keys(env.pool)).toEqual(before);
    expect(warns.filter(([, m]) => /server changed/.test(m))).toHaveLength(1);
  });

  it('the same server under a new URL keeps the mirror (no rebuild, no log)', async () => {
    env = await plexEnv();
    const before = await keys(env.pool);
    const detailAt = (await env.pool.query('select max(detail_at) d from plex_items')).rows[0].d;
    const { ms, events, warns } = swap(env, env.fake, 'http://plex.example.com:32400');
    env.fake.calls.length = 0;
    expect(await ms.sync.run()).toMatchObject({ added: [], removed: [], details: 0 });
    expect(await keys(env.pool)).toEqual(before);
    expect((await env.pool.query('select max(detail_at) d from plex_items')).rows[0].d).toEqual(detailAt);
    expect(await stored(env.pool)).toBe(OLD);
    expect(events).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('an identity fetch failure changes nothing (identifier and mirror kept); the next pass with an identity rebuilds', async () => {
    env = await plexEnv();
    const other = otherServer();
    other.fail = { re: /^\/identity$/, status: 503 };
    const { ms, warns } = swap(env, other);
    await ms.sync.run();
    expect(await stored(env.pool)).toBe(OLD);
    // a normal pass: the old Movies section is only dropped after MISSING_PASSES passes, nothing was cleared
    expect((await env.pool.query('select title from plex_sections order by section_id')).rows.map((x) => x.title)).toEqual(['Movies', 'TV']);
    expect(await keys(env.pool)).toContain('1');
    expect(warns.filter(([, m]) => /identity unknown/.test(m))).toHaveLength(1);
    await ms.sync.run();
    expect(warns.filter(([, m]) => /identity unknown/.test(m))).toHaveLength(1); // once, not every pass
    expect(JSON.stringify(warns)).not.toContain(PLEX_TOKEN);
    other.fail = null;
    await ms.sync.run();
    expect(await stored(env.pool)).toBe('another-plex-server-0000000000000000000');
    expect((await env.pool.query('select title from plex_sections')).rows.map((x) => x.title)).toEqual(['TV']);
    // fork (T8 minor): a good identity read resets the once-only warning, so a later outage is logged again (once)
    other.fail = { re: /^\/identity$/, status: 503 };
    await ms.sync.run();
    await ms.sync.run();
    expect(warns.filter(([, m]) => /identity unknown/.test(m))).toHaveLength(2);
  });
});
