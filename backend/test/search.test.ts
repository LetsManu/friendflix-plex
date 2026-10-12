import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

const P = 'a'.repeat(32), HID = 'b'.repeat(32), MOV = 'c'.repeat(32), SER = 'd'.repeat(32), EP = 'e'.repeat(32), NOITEMS = 'f'.repeat(32), FILM = '1'.repeat(32);
const movie = { Id: MOV, Name: 'Alien', Type: 'Movie', ProductionYear: 1979, CommunityRating: 8.4, Genres: ['Horror'] };
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const fail = new Set<string>(); // which sub-requests answer 500
let genres = ['Action', 'Abenteuer', 'Horror'];
let genreHits = 0;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const t = u.searchParams.get('includeItemTypes');
      if (fail.has(t ?? '')) return { status: 500 };
      if (t === 'Episode') return { json: { Items: [{ Id: EP, Name: 'Alien Folge', Type: 'Episode' }] } };
      if (u.searchParams.get('personIds') === NOITEMS) return { json: { Items: [] } };
      if (u.searchParams.get('personIds')) return { json: { Items: [movie] } };
      return { json: { Items: [movie, { Id: SER, Name: 'Alien Serie', Type: 'Series' }], TotalRecordCount: 2 } };
    },
    'GET /Persons': () => (fail.has('Persons') ? { status: 500 } : { json: { Items: [{ Id: P, Name: 'Sigourney', ImageTags: { Primary: 'x' } }, { Id: HID, Name: 'Sig Zwei' }] } }),
    'GET /Genres': () => { genreHits++; return fail.has('Genres') ? { status: 500 } : { json: { Items: genres.map((Name) => ({ Name })) } }; },
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/')[2];
      if (id === P) return { json: { Id: P, Name: 'Sigourney', Type: 'Person', Overview: 'Schauspielerin', PremiereDate: '1949-10-08T00:00:00.0000000Z', ImageTags: { Primary: 'x' } } };
      if (id === NOITEMS) return { json: { Id: NOITEMS, Name: 'Niemand', Type: 'Person' } };
      if (id === FILM) return { json: { Id: FILM, Name: 'Film', Type: 'Movie' } };
      return { status: 404 };
    },
  });
  s = await env.login();
});
afterAll(() => env.close());
const get = (url: string) => env.app.inject({ url, cookies: s.cookies });

describe('GET /api/search', () => {
  it('returns grouped results', async () => {
    const r = await get('/api/search?q=Alien');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.q).toBe('Alien');
    expect(b.titles.map((i: any) => i.name)).toEqual(['Alien', 'Alien Serie']);
    expect(b.episodes.map((i: any) => i.id)).toEqual([EP]);
    expect(b.people).toEqual([{ id: P, name: 'Sigourney', image: true }, { id: HID, name: 'Sig Zwei', image: false }]);
    expect(b.genres).toEqual([]);
    expect(b.partial).toBe(false);
    const c = env.jfCalls.filter((x) => x.path === '/Items' && x.search.includes('searchTerm=Alien'));
    expect(c.some((x) => x.search.includes('limit=24') && x.search.includes('Movie%2CSeries'))).toBe(true);
    expect(c.some((x) => x.search.includes('limit=8') && x.search.includes('includeItemTypes=Episode'))).toBe(true);
    expect(env.jfCalls.some((x) => x.path === '/Persons' && x.search.includes('limit=12') && x.search.includes('userId='))).toBe(true);
  });

  it('matches genres case-insensitively (max 6) and caches the genre list', async () => {
    genres = ['Action', 'Abenteuer', 'Horror', 'Actionkomödie'];
    await env.kv.del(`genres:${(await env.pool.query('select jellyfin_user_id j from users limit 1')).rows[0].j}:Movie,Series`);
    genreHits = 0;
    expect((await get('/api/search?q=ACTION')).json().genres).toEqual(['Action', 'Actionkomödie']);
    const second = (await get('/api/search?q=hor')).json();
    expect(second.genres).toEqual(['Horror']);
    expect(genreHits).toBe(1); // second request served from the cache
  });

  it('year query uses years= sorted by rating, no episodes', async () => {
    env.jfCalls.length = 0;
    const b = (await get('/api/search?q=1979')).json();
    expect(b.titles).toHaveLength(2);
    expect(b.episodes).toEqual([]);
    const it = env.jfCalls.find((x) => x.path === '/Items')!;
    expect(it.search).toContain('years=1979');
    expect(it.search).toContain('sortBy=CommunityRating');
    expect(it.search).toContain('sortOrder=Descending');
    expect(it.search).not.toContain('searchTerm');
    expect(env.jfCalls.filter((x) => x.path === '/Items' && x.search.includes('Episode'))).toHaveLength(0);
  });

  it('partial when one sub-request fails', async () => {
    fail.add('Episode');
    const b = (await get('/api/search?q=Alien')).json();
    fail.clear();
    expect(b.partial).toBe(true);
    expect(b.episodes).toEqual([]);
    expect(b.titles).toHaveLength(2);
  });

  it('502 when everything fails', async () => {
    for (const k of ['Movie,Series', 'Episode', 'Persons', 'Genres']) fail.add(k);
    await env.kv.del(`genres:${(await env.pool.query('select jellyfin_user_id j from users limit 1')).rows[0].j}:Movie,Series`);
    const r = await get('/api/search?q=Alien');
    fail.clear();
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('jellyfin');
  });

  it('400 on missing / short / long q, 401 anonymous', async () => {
    expect((await get('/api/search?q=a')).statusCode).toBe(400);
    expect((await get('/api/search?q=%20a%20')).statusCode).toBe(400);
    expect((await get('/api/search')).statusCode).toBe(400);
    expect((await get(`/api/search?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
    expect((await env.app.inject('/api/search?q=Alien')).statusCode).toBe(401);
  });
});

describe('GET /api/people/:id', () => {
  it('returns person and their titles', async () => {
    const r = await get(`/api/people/${P}`);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.person).toEqual({ id: P, name: 'Sigourney', overview: 'Schauspielerin', birthYear: 1949, image: true });
    expect(b.items.map((i: any) => i.id)).toEqual([MOV]);
    const c = env.jfCalls.filter((x) => x.path === '/Items' && x.search.includes('personIds')).pop()!;
    expect(c.search).toContain(`personIds=${P}`);
    expect(c.search).toContain('sortBy=PremiereDate%2CSortName');
    expect(c.search).toContain('limit=100');
  });
  it('404 for non-Person, person without visible items, unknown id; 400 bad id', async () => {
    expect((await get(`/api/people/${FILM}`)).statusCode).toBe(404);
    expect((await get(`/api/people/${NOITEMS}`)).statusCode).toBe(404);
    expect((await get(`/api/people/${'9'.repeat(32)}`)).statusCode).toBe(404);
    expect((await get('/api/people/zzz')).statusCode).toBe(400);
  });
});

describe('GET /api/library/items filters', () => {
  const lastItems = async (qs: string) => {
    env.jfCalls.length = 0;
    const r = await get(`/api/library/items?${qs}`);
    return { r, search: env.jfCalls.find((x) => x.path === '/Items')?.search ?? '' };
  };
  it('maps decade, year, minRating, person', async () => {
    const d = await lastItems('decade=1990&minRating=7&person=' + P);
    expect(d.r.statusCode).toBe(200);
    const p = new URLSearchParams(d.search);
    expect(p.get('years')).toBe('1990,1991,1992,1993,1994,1995,1996,1997,1998,1999');
    expect(p.get('minCommunityRating')).toBe('7');
    expect(p.get('personIds')).toBe(P);
    const y = new URLSearchParams((await lastItems('year=2001&decade=1990')).search);
    expect(y.get('years')).toBe('2001'); // year wins
    expect(new URLSearchParams((await lastItems('')).search).has('years')).toBe(false);
  });
  it('rejects invalid values', async () => {
    for (const qs of ['decade=1995', 'decade=1890', 'decade=2100', 'year=1899', 'year=2101', 'minRating=11', 'minRating=-1', 'person=nope', 'year=abc']) {
      expect((await lastItems(qs)).r.statusCode, qs).toBe(400);
    }
  });
});
