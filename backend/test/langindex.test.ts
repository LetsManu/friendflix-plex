import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { langIndexTick, normLang } from '../src/langindex.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const M1 = hex(1), M2 = hex(2), M3 = hex(3), S1 = hex(10), HID = hex(12), STALE = hex(99);
const st = (Type: string, Language?: string) => ({ Type, Language });
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let movies: any[] = [];
let episodes: any[] = [];
let failEpisodes = false;
const adminAuth: string[] = [];
const idCalls: number[] = [];

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u, init) => {
      const t = u.searchParams.get('includeItemTypes');
      const start = Number(u.searchParams.get('startIndex') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 200);
      if ((t === 'Movie' || t === 'Episode') && !u.searchParams.get('userId')) {
        adminAuth.push(String((init.headers as Record<string, string>)?.Authorization));
        if (t === 'Episode' && failEpisodes) return { status: 500 };
        const all = t === 'Movie' ? movies : episodes;
        return { json: { Items: all.slice(start, start + limit), TotalRecordCount: all.length } };
      }
      // viewer detail fetch (language path): visible = everything except HID, genre filter honoured
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const g = u.searchParams.get('genres');
      const lib: Record<string, any> = {
        [M1]: { Id: M1, Name: 'Zorro', Type: 'Movie', Genres: ['Action'], CommunityRating: 6, PremiereDate: '2001-01-01T00:00:00Z', DateCreated: '2024-05-01T00:00:00Z' },
        [M2]: { Id: M2, Name: 'Anna', Type: 'Movie', Genres: ['Drama'], CommunityRating: 8, PremiereDate: '1999-01-01T00:00:00Z' },
        [M3]: { Id: M3, Name: 'Mitte', Type: 'Movie', Genres: ['Action'], CommunityRating: 7, PremiereDate: '2010-01-01T00:00:00Z', DateCreated: '2020-05-01T00:00:00Z' },
        [S1]: { Id: S1, Name: 'Serie', Type: 'Series', Genres: ['Action'], CommunityRating: 9 },
        [HID]: { Id: HID, Name: 'Versteckt', Type: 'Movie', Genres: ['Action'] },
      };
      for (const i of ids) if (i.startsWith('ffff')) lib[i] = { Id: i, Name: `Bulk ${i.slice(-4)}`, Type: 'Movie', Genres: [] };
      idCalls.push(ids.length);
      return { json: { Items: ids.filter((i) => i !== HID && lib[i]).map((i) => lib[i]).filter((i) => !g || i.Genres.includes(g)) } };
    },
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/')[2]!;
      if (id === EP_ID) return { json: { Id: EP_ID, Name: 'Folge', Type: 'Episode', SeriesId: S1 } };
      return { json: { Id: id, Name: 'X', Type: id === S1 ? 'Series' : 'Movie' } };
    },
  });
  s = await env.login();
});
afterAll(() => env.close());
const EP_ID = hex(500);
const get = (url: string) => env.app.inject({ url, cookies: s.cookies });

describe('normLang', () => {
  it('maps bibliographic codes, lowercases and drops undetermined', () => {
    expect(normLang('ger')).toBe('deu');
    expect(normLang('FRE')).toBe('fra');
    expect(normLang('chi')).toBe('zho');
    expect(normLang('eng')).toBe('eng');
    expect(normLang('und')).toBeNull();
    expect(normLang('')).toBeNull();
    expect(normLang(undefined)).toBeNull();
    expect(normLang('de')).toBeNull();
  });
});

describe('langIndexTick', () => {
  it('indexes movies, aggregates episodes per series, normalises codes and drops und', async () => {
    movies = [
      { Id: M1, MediaStreams: [st('Audio', 'ger'), st('Audio', 'eng'), st('Subtitle', 'fre'), st('Video'), st('Audio', 'und')] },
      { Id: M2, MediaStreams: [], MediaSources: [{ MediaStreams: [st('Audio', 'eng'), st('Subtitle', 'ger')] }] }, // fallback to MediaSources
      { Id: M3, MediaStreams: [st('Audio', 'deu')] },
      { Id: STALE, MediaStreams: [st('Audio', 'jpn')] },
      { Id: HID, MediaStreams: [st('Audio', 'deu')] },
    ];
    episodes = [
      { Id: hex(100), SeriesId: S1, MediaStreams: [st('Audio', 'jpn'), st('Subtitle', 'ger')] },
      { Id: hex(101), SeriesId: S1, MediaStreams: [st('Audio', 'ger'), st('Subtitle', 'eng')] },
      { Id: hex(102), MediaStreams: [st('Audio', 'ger')] }, // no series -> ignored
    ];
    await langIndexTick(env.ctx, { force: true });
    const rows = (await env.pool.query('select item_id, type, audio, subs from item_langs order by item_id')).rows;
    const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));
    expect(by[M1]).toMatchObject({ type: 'Movie', audio: ['deu', 'eng'], subs: ['fra'] });
    expect(by[M2]).toMatchObject({ type: 'Movie', audio: ['eng'], subs: ['deu'] });
    expect(by[S1]).toMatchObject({ type: 'Series', audio: ['deu', 'jpn'], subs: ['deu', 'eng'] });
    expect(adminAuth.every((a) => a.includes('adminkey'))).toBe(true);
    expect(env.jfCalls.some((c) => c.path === '/Items' && c.search.includes('fields=MediaStreams,SeriesId') && c.search.includes('includeItemTypes=Episode'))).toBe(true);
  });

  it('removes rows of vanished items after a complete run, keeps everything after a failed one', async () => {
    await env.pool.query("insert into item_langs(item_id,type,audio) values ($1,'Movie','{eng}') on conflict do nothing", [STALE]);
    failEpisodes = true;
    await langIndexTick(env.ctx, { force: true }); // never throws, never deletes
    expect((await env.pool.query('select 1 from item_langs where item_id=$1', [STALE])).rowCount).toBe(1);
    failEpisodes = false;
    movies = movies.filter((m) => m.Id !== STALE);
    await langIndexTick(env.ctx, { force: true });
    expect((await env.pool.query('select 1 from item_langs where item_id=$1', [STALE])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from item_langs')).rowCount).toBe(5); // M1 M2 M3 HID S1
  });

  it('runs at most every 12 h unless forced', async () => {
    const before = env.jfCalls.length;
    await langIndexTick(env.ctx);
    expect(env.jfCalls.length).toBe(before);
    await langIndexTick(env.ctx, { force: true });
    expect(env.jfCalls.length).toBeGreaterThan(before);
  });
});

describe('GET /api/library/languages', () => {
  it('returns counts per code, highest first, cached', async () => {
    const b = (await get('/api/library/languages')).json();
    expect(b.audio[0]).toEqual({ code: 'deu', count: 4 }); // M1 M3 HID S1
    expect(b.audio.find((x: any) => x.code === 'eng')).toEqual({ code: 'eng', count: 2 });
    expect(b.subs.find((x: any) => x.code === 'deu')).toEqual({ code: 'deu', count: 2 });
    await env.pool.query('delete from item_langs');
    expect((await get('/api/library/languages')).json()).toEqual(b); // cached 10 min
    await env.kv.del('langs:summary');
    expect((await get('/api/library/languages')).json()).toEqual({ audio: [], subs: [] });
    await langIndexTick(env.ctx, { force: true });
  });
});

describe('GET /api/library/items with audio/subs', () => {
  it('returns only indexed and visible titles, sorted by name', async () => {
    const b = (await get('/api/library/items?audio=deu&types=Movie')).json();
    expect(b.items.map((i: any) => i.name)).toEqual(['Mitte', 'Zorro']); // HID invisible, S1 is a Series, Anna has no German audio
    expect(b.total).toBe(2);
    const both = (await get('/api/library/items?audio=deu')).json();
    expect(both.items.map((i: any) => i.name)).toEqual(['Mitte', 'Serie', 'Zorro']);
    const both2 = (await get('/api/library/items?audio=deu&subs=eng')).json();
    expect(both2.items.map((i: any) => i.id)).toEqual([S1]);
  });
  it('passes the other filters through and honours sort/desc', async () => {
    env.jfCalls.length = 0;
    const b = (await get('/api/library/items?audio=deu&genre=Action&minRating=5&sort=CommunityRating&desc=true')).json();
    expect(b.items.map((i: any) => i.name)).toEqual(['Serie', 'Mitte', 'Zorro']);
    const c = env.jfCalls.filter((x) => x.path === '/Items' && x.search.includes('ids='));
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.search.includes('genres=Action') && x.search.includes('minCommunityRating=5'))).toBe(true);
    const d = (await get('/api/library/items?audio=deu&sort=PremiereDate&types=Movie')).json();
    expect(d.items.map((i: any) => i.name)).toEqual(['Zorro', 'Mitte']);
  });
  it('sorts DateCreated by the library-added date, not the premiere date', async () => {
    const asc = (await get('/api/library/items?audio=deu&sort=DateCreated&types=Movie')).json();
    expect(asc.items.map((i: any) => i.name)).toEqual(['Mitte', 'Zorro']); // added 2020 / 2024 (premiere order would be Zorro, Mitte)
    expect(asc.items[0].dateCreated).toBe('2020-05-01T00:00:00Z');
    const desc = (await get('/api/library/items?audio=deu&sort=DateCreated&desc=true&types=Movie')).json();
    expect(desc.items.map((i: any) => i.name)).toEqual(['Zorro', 'Mitte']);
  });
  it('paginates with start/limit and serves later pages from the cached id list', async () => {
    const p1 = (await get('/api/library/items?audio=deu&limit=2')).json();
    expect(p1.items.map((i: any) => i.name)).toEqual(['Mitte', 'Serie']);
    expect(p1.total).toBe(3);
    env.jfCalls.length = 0;
    const p2 = (await get('/api/library/items?audio=deu&limit=2&start=2')).json();
    expect(p2.items.map((i: any) => i.name)).toEqual(['Zorro']);
    expect(p2.total).toBe(3);
    expect(env.jfCalls.filter((x) => x.path === '/Items').length).toBe(1); // only the page's details
  });
  it('is empty for an Episode-only type filter and 400 on bad codes', async () => {
    expect((await get('/api/library/items?audio=deu&types=Episode')).json()).toEqual({ items: [], total: 0 });
    expect((await get('/api/library/items?audio=de')).statusCode).toBe(400);
    expect((await get('/api/library/items?subs=DEU')).statusCode).toBe(400);
    expect((await get('/api/library/items?audio=deu1')).statusCode).toBe(400);
  });
});

const bulk = (n: number, lang: string) => env.pool.query(
  `insert into item_langs(item_id,type,audio) select 'ffff' || lpad(g::text, 28, '0'), 'Movie', array[$2] from generate_series(1, $1::int) g`, [n, lang]);

describe('language path limits', () => {
  it('requests details in chunks of at most 80 ids', async () => {
    await bulk(170, 'qqq');
    idCalls.length = 0;
    const b = (await get('/api/library/items?audio=qqq&limit=200')).json();
    expect(b.total).toBe(170);
    expect(b.capped).toBeUndefined();
    expect(idCalls.sort((a, c) => c - a)).toEqual([80, 80, 10]);
    idCalls.length = 0;
    await get('/api/library/items?audio=qqq&limit=200&start=0'); // cached order: page fetched in chunks too
    expect(Math.max(...idCalls)).toBeLessThanOrEqual(80);
    await env.pool.query("delete from item_langs where item_id like 'ffff%'");
  });
  it('flags capped when more than 5000 candidates match, and keeps the flag on cached pages', async () => {
    await bulk(5001, 'zzz');
    const a = (await get('/api/library/items?audio=zzz&limit=5')).json();
    expect(a.capped).toBe(true);
    expect(a.total).toBe(5000);
    const again = (await get('/api/library/items?audio=zzz&limit=5&start=5')).json();
    expect(again.capped).toBe(true);
    await env.pool.query("delete from item_langs where item_id like 'ffff%'");
    expect((await get('/api/library/items?audio=deu&types=Movie')).json().capped).toBeUndefined();
  });
  it('extends the cached order on every page hit', async () => {
    await get('/api/library/items?audio=deu&limit=1');
    const set = vi.spyOn(env.kv, 'set');
    await get('/api/library/items?audio=deu&limit=1&start=1');
    const re = set.mock.calls.filter((c) => String(c[0]).startsWith('langitems:'));
    set.mockRestore();
    expect(re).toHaveLength(1);
    expect(re[0]![2]).toBe(120);
  });
  it('answers 429 rate_limited after 30 language queries a minute, but only for audio/subs', async () => {
    const uid = (await get('/api/me')).json().id as string;
    await env.kv.del(`ratelimit:langitems:${uid}`);
    await env.kv.set(`ratelimit:langitems:${uid}`, '30', 60);
    const r = await get('/api/library/items?audio=deu');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limited' });
    expect((await get('/api/library/items')).statusCode).toBe(200);
    await env.kv.del(`ratelimit:langitems:${uid}`);
    expect((await get('/api/library/items?audio=deu')).statusCode).toBe(200);
  });
});

describe('langIndexTick on process start', () => {
  const fresh = async () => { vi.resetModules(); return (await import('../src/langindex.js')).langIndexTick; };
  it('skips the first run when the index has rows and the last run is recent', async () => {
    await env.kv.set('langidx:last', String(Date.now() - 3600_000), 3600);
    const tick = await fresh();
    const before = env.jfCalls.length;
    await tick(env.ctx);
    expect(env.jfCalls.length).toBe(before);
  });
  it('runs on start when the index is empty or the last run is older than 12 h', async () => {
    const tick = await fresh();
    const before = env.jfCalls.length;
    await env.kv.set('langidx:last', String(Date.now() - 13 * 3600_000), 3600);
    await tick(env.ctx);
    expect(env.jfCalls.length).toBeGreaterThan(before);
    const rows = (await env.pool.query('select * from item_langs')).rows;
    await env.pool.query('delete from item_langs');
    await env.kv.set('langidx:last', String(Date.now()), 3600);
    const tick2 = await fresh();
    const mid = env.jfCalls.length;
    await tick2(env.ctx); // recent stamp but empty table
    expect(env.jfCalls.length).toBeGreaterThan(mid);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('GET /api/items/:id langs', () => {
  it('adds the language lists, using the series row for an episode', async () => {
    const m = (await get(`/api/items/${M1}`)).json();
    expect(m.langs).toEqual({ audio: ['deu', 'eng'], subs: ['fra'] });
    const e = (await get(`/api/items/${EP_ID}`)).json();
    expect(e.langs).toEqual({ audio: ['deu', 'jpn'], subs: ['deu', 'eng'] });
    const none = (await get(`/api/items/${hex(777)}`)).json();
    expect(none.langs).toBeUndefined();
  });
});
