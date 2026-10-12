import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { previews } from '../src/previews.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(32));
const LEA_JF = '1'.repeat(32);
const movie = (id: string, name: string, rating: number, mins: number, genres = ['Drama']) => ({ Id: id, Name: name, Type: 'Movie', CommunityRating: rating, RunTimeTicks: mins * 600_000_000, Genres: genres, LocalTrailerCount: id === A ? 1 : 0, UserData: {},
  MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'ger', DisplayTitle: 'Deutsch (AC3)', IsDefault: true }, { Type: 'Audio', Language: 'eng', DisplayTitle: 'English (AAC)' }, { Type: 'Audio', Language: 'eng', DisplayTitle: 'English commentary' }, { Type: 'Subtitle', Language: 'ger', DisplayTitle: 'Deutsch' }] }] });
const CATALOG: Record<string, any> = { [A!]: movie(A!, 'Alpha', 7.1, 95), [B!]: movie(B!, 'Beta', 8.4, 150, ['Action']), [C!]: movie(C!, 'Gamma', 6.2, 100), [D!]: movie(D!, 'Delta', 9.0, 90), [E!]: movie(E!, 'Epsilon', 7.7, 100) };
const ep = (n: number) => ({ Id: String(n).repeat(32), Name: `E${n}`, Type: 'Episode', SeriesId: 'e'.repeat(32), IndexNumber: n, UserData: {} });
const UNPLAYED: Record<string, string[]> = { admin: [A!, B!, C!], lea: [B!, C!, D!] };

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let leaId: string;
let lastItems = '';

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const q = u.searchParams; lastItems = u.search;
      if (q.get('filters') === 'IsUnplayed') return { json: { Items: (UNPLAYED[q.get('userId') === LEA_JF ? 'lea' : 'admin'] ?? []).map((Id) => ({ Id })) } };
      if (q.get('fields') === 'People') return { json: { Items: [{ People: [{ Id: 'f'.repeat(32), Name: 'Ada Beispiel', Role: 'Kommissarin', Type: 'Actor', PrimaryImageTag: 'x' }, { Id: '9'.repeat(32), Name: 'Bo Regie', Type: 'Director' }] }] } };
      if (q.get('includeItemTypes') === 'BoxSet') return { json: { Items: [{ Id: '7'.repeat(32), Name: 'Alpha-Reihe', Type: 'BoxSet' }] } };
      if (q.get('ids')) return { json: { Items: q.get('ids')!.split(',').map((i) => CATALOG[i]).filter(Boolean), TotalRecordCount: 9 } };
      return { json: { Items: [] } };
    },
    'GET /Shows/[^/]+/Episodes': () => ({ json: { Items: [ep(6), ep(7)] } }),
    'POST /Items/[^/]+/PlaybackInfo': (u) => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: u.pathname.split('/')[2], Container: 'mkv', Bitrate: 8_000_000, MediaStreams: [] }] } }),
    'GET /Studios': () => ({ json: { Items: [{ Name: 'Studio Eins' }, { Name: 'Studio Zwei' }] } }),
    'GET /Items/[^/]+/Similar': () => ({ json: { Items: [CATALOG[D!], CATALOG[E!], CATALOG[B!]] } }),
    'GET /Items/[^/]+/LocalTrailers': (u) => ({ json: u.pathname.includes(A!) ? [{ Id: '5'.repeat(32) }] : [] }),
    'GET /Items/[^/]+/SpecialFeatures': () => ({ json: [{ Id: '4'.repeat(32), Name: 'Making of', Type: 'Video' }] }),
    'GET /Items/[^/]+/RemoteSearch/Subtitles/[a-z]+': () => ({ json: [{ Id: 'sub-1', Name: 'Alpha.2020.de.srt', ProviderName: 'OpenSubtitles', Format: 'srt', DownloadCount: 120, CommunityRating: 8 }] }),
    'POST /Items/[^/]+/RemoteSearch/Subtitles/[^/]+': () => ({ status: 204 }),
    'GET /Items/[^/]+': (u) => ({ json: CATALOG[u.pathname.split('/')[2]!] ?? { Id: u.pathname.split('/')[2], Name: 'X', Type: 'Movie' } }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: CATALOG[u.pathname.split('/')[4]!] ?? { Id: u.pathname.split('/')[4], Name: 'X', Type: 'Movie' } }),
  }, {
    seerr: {
      'GET /api/v1/discover/movies/upcoming': () => ({ json: { totalPages: 1, results: [{ id: 99, title: 'Bald im Kino', releaseDate: '2027-03-01', posterPath: '/p.jpg', overview: 'o', mediaInfo: { status: 2 } }, { id: 100, title: 'Noch offen', releaseDate: '2027-04-01' }] } }),
    },
  });
  s = await env.login();
  leaId = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'lea', 'l@x.de', 'Lea', 'friend', $1, 'lea', $2) returning id`,
    [LEA_JF, encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id;
});
afterAll(() => env.close());
const call = (method: string, url: string, body?: unknown, who = s) => env.app.inject({ method: method as 'GET', url, cookies: who.cookies, headers: { 'x-csrf-token': who.csrf }, payload: body as object });

describe('group matcher (opt-in)', () => {
  it('lists friends with their consent state', async () => {
    const f = (await call('GET', '/api/friends')).json().friends;
    expect(f).toEqual([{ id: leaId, name: 'Lea', sharesHistory: false }]);
  });
  it('refuses when a participant has not shared their history', async () => {
    const r = await call('POST', '/api/match', { userIds: [leaId] });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'history_not_shared', names: ['Lea'] });
  });
  it('intersects the unwatched lists, applies runtime/genre filters and sorts by rating', async () => {
    await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareHistory": true}')`, [leaId]);
    const r = (await call('POST', '/api/match', { userIds: [leaId] })).json();
    expect(r.participants).toEqual(['Admin', 'Lea']);
    expect(r.total).toBe(2); // B and C are unwatched by both
    expect(r.items.map((i: any) => i.name)).toEqual(['Beta', 'Gamma']); // by rating
    const short = (await call('POST', '/api/match', { userIds: [leaId], maxMinutes: 120 })).json();
    expect(short.items.map((i: any) => i.name)).toEqual(['Gamma']);
    const action = (await call('POST', '/api/match', { userIds: [leaId], genre: 'Action' })).json();
    expect(action.items.map((i: any) => i.name)).toEqual(['Beta']);
    expect(lastItems).toContain('ids='); // details fetched in chunks
  });
  it('validates input: nobody else, unknown ids, too many', async () => {
    expect((await call('POST', '/api/match', { userIds: [] })).statusCode).toBe(400);
    expect((await call('POST', '/api/match', { userIds: [(await env.pool.query('select id from users where name=\'Admin\'')).rows[0].id] })).statusCode).toBe(400);
    expect((await call('POST', '/api/match', { userIds: ['00000000-0000-4000-8000-000000000000'] })).statusCode).toBe(400);
  });
});

describe('recommendations, friends rated, thumbs', () => {
  it('recommends to a friend once per week, notifies, and shows the row with caption', async () => {
    const r = await call('POST', '/api/recommend', { itemId: D, toUserIds: [leaId], note: 'Unbedingt ansehen!' });
    expect(r.json()).toEqual({ sent: 1 });
    expect((await call('POST', '/api/recommend', { itemId: D, toUserIds: [leaId] })).statusCode).toBe(409);
    const n = (await env.pool.query("select title, body from notifications where user_id=$1 and kind='recommend'", [leaId])).rows;
    expect(n[0].title).toContain('Admin empfiehlt dir „Delta“');
    // read as Lea: Lea has no session in this test -> check via DB-backed endpoint with a session of her own
    const lea = await makeLeaSession();
    const rec = (await call('GET', '/api/recommendations', undefined, lea)).json().items;
    expect(rec[0]).toMatchObject({ name: 'Delta', caption: 'Von Admin: Unbedingt ansehen!' });
    await call('POST', '/api/recommendations/seen', undefined, lea);
    expect((await env.pool.query('select seen from recommendations')).rows[0].seen).toBe(true);
  });
  it('shows friends\' good ratings, respects the opt-out and my own ratings', async () => {
    const lea = await makeLeaSession();
    await call('PUT', `/api/items/${E}/rating`, { stars: 5 }, lea);
    await call('PUT', `/api/items/${B}/rating`, { stars: 2 }, lea); // below 4: not shown
    const row = (await call('GET', '/api/library/friends-rated')).json().items;
    expect(row.map((i: any) => i.name)).toEqual(['Epsilon']);
    expect(row[0].caption).toBe('Lea 5★');
    await env.pool.query(`update user_prefs set data = '{"shareHistory": true, "shareRatings": false}' where user_id=$1`, [leaId]);
    expect((await call('GET', '/api/library/friends-rated')).json().items).toEqual([]);
    await env.pool.query(`update user_prefs set data = '{"shareHistory": true}' where user_id=$1`, [leaId]);
    await call('PUT', `/api/items/${E}/rating`, { stars: 4 }); // I rated it myself -> no longer a suggestion
    expect((await call('GET', '/api/library/friends-rated')).json().items).toEqual([]);
  });
  it('thumbs: up seeds "because", down hides titles from similar rows', async () => {
    expect((await call('PUT', `/api/items/${A}/thumb`, { value: 1 })).json()).toEqual({ value: 1 });
    expect((await call('GET', `/api/items/${A}`)).json().thumb).toBe(1);
    await call('PUT', `/api/items/${E}/thumb`, { value: -1 });
    const b = (await call('GET', '/api/library/because')).json();
    expect(b.because).toMatchObject({ id: A, name: 'Alpha', liked: true });
    expect(b.items.map((i: any) => i.name)).toEqual(['Delta', 'Beta']); // Epsilon removed
    expect((await call('PUT', `/api/items/${A}/thumb`, { value: 0 })).json()).toEqual({ value: 0 });
    expect((await call('PUT', `/api/items/${A}/thumb`, { value: 5 })).statusCode).toBe(400);
  });
  it('thumbs: 2 ("Super") is stored, read back and also seeds "because"', async () => {
    expect((await call('PUT', `/api/items/${A}/thumb`, { value: 2 })).json()).toEqual({ value: 2 });
    expect((await call('GET', `/api/items/${A}`)).json().thumb).toBe(2);
    const b = (await call('GET', '/api/library/because')).json();
    expect(b.because).toMatchObject({ id: A, liked: true });
    expect((await call('PUT', `/api/items/${A}/thumb`, { value: 0 })).json()).toEqual({ value: 0 });
  });
});

describe('scenes, X-Ray, extras, trailers, collections', () => {
  it('bookmarks: create, list per item, delete only own, validate', async () => {
    const id = (await call('POST', '/api/bookmarks', { itemId: A, position: 754, note: 'Beste Szene' })).json().id;
    expect((await call('GET', `/api/bookmarks?itemId=${A}`)).json().bookmarks).toMatchObject([{ position: 754, note: 'Beste Szene' }]);
    const lea = await makeLeaSession();
    await call('DELETE', `/api/bookmarks/${id}`, undefined, lea); // not Lea's
    expect((await call('GET', `/api/bookmarks?itemId=${A}`)).json().bookmarks).toHaveLength(1);
    await call('DELETE', `/api/bookmarks/${id}`);
    expect((await call('GET', `/api/bookmarks?itemId=${A}`)).json().bookmarks).toHaveLength(0);
    expect((await call('POST', '/api/bookmarks', { itemId: A, position: -1 })).statusCode).toBe(400);
    expect((await call('POST', '/api/bookmarks', { itemId: 'zz', position: 3 })).statusCode).toBe(400);
  });
  it('X-Ray returns cast with image flags', async () => {
    const p = (await call('GET', `/api/items/${A}/people`)).json().people;
    expect(p[0]).toEqual({ id: 'f'.repeat(32), name: 'Ada Beispiel', role: 'Kommissarin', type: 'Actor', image: true });
    expect(p[1]).toMatchObject({ type: 'Director', image: false });
  });
  it('collections and studios', async () => {
    const c = (await call('GET', '/api/library/collections')).json();
    expect(c.items[0]).toMatchObject({ name: 'Alpha-Reihe', type: 'BoxSet' });
    expect(c.studios).toEqual(['Studio Eins', 'Studio Zwei']);
    await call('GET', '/api/library/items?studio=Studio%20Eins');
    expect(lastItems).toContain('studios=Studio+Eins');
  });
  it('hover trailer: cached clip pipeline answers "preparing" first, can be disabled (see previews.test.ts)', async () => {
    expect((await call('GET', `/api/items/${A}/trailer`)).json()).toEqual({ error: 'preparing' });
    await previews(env.ctx).whenIdle();
    expect((await call('GET', `/api/items/${A}`)).json().item.trailers).toBe(1);
    await call('PUT', '/api/prefs', { shareHistory: true, hoverTrailers: false });
    expect((await call('GET', `/api/items/${A}/trailer`)).json()).toEqual({ error: 'disabled' });
  });
});

describe('language picker and clip preview', () => {
  it('next episode: the one after the given episode, not the in-progress one itself', async () => {
    CATALOG[ep(6).Id] = ep(6);
    const r = (await call('GET', `/api/items/${ep(6).Id}/next`)).json();
    expect(r.item?.name).toBe('E7');
    expect((await call('GET', `/api/items/${B}/next`)).json()).toEqual({ item: null }); // a movie has none
  });
  it('tracks: one entry per audio language and subtitle language', async () => {
    const r = (await call('GET', `/api/items/${B}/tracks`)).json();
    expect(r.audio).toEqual([{ language: 'ger', title: 'Deutsch (AC3)', isDefault: true }, { language: 'eng', title: 'English (AAC)', isDefault: false }]);
    expect(r.subtitles).toEqual([{ language: 'ger', title: 'Deutsch' }]);
  });
  it('clip preview defaults to on', async () => {
    await call('PUT', '/api/prefs', { hoverTrailers: true });
    expect((await call('GET', '/api/prefs')).json().prefs.hoverClip).toBe(true);
    expect((await call('GET', `/api/items/${B}/trailer`)).json()).toEqual({ error: 'preparing' });
    await previews(env.ctx).whenIdle();
  });
});

describe('upcoming (Seerr) and subtitles', () => {
  it('maps upcoming releases with wish status and proxied posters', async () => {
    const r = (await call('GET', '/api/seerr/upcoming?type=movie')).json().results;
    expect(r[0]).toMatchObject({ tmdbId: 99, title: 'Bald im Kino', releaseDate: '2027-03-01', status: 'angefragt', poster: '/api/seerr/image/p.jpg' });
    expect(r[1].status).toBe('nicht_angefragt');
    expect((await call('GET', '/api/seerr/upcoming?type=music')).statusCode).toBe(400);
  });
  it('subtitle search and download need a non-guest role and validate input', async () => {
    const res = (await call('GET', `/api/items/${A}/subtitles/search?lang=ger`)).json().results;
    expect(res[0]).toMatchObject({ id: 'sub-1', provider: 'OpenSubtitles', downloads: 120 });
    expect((await call('GET', `/api/items/${A}/subtitles/search?lang=german`)).statusCode).toBe(400);
    expect((await call('POST', `/api/items/${A}/subtitles/download`, { subtitleId: 'sub-1' })).statusCode).toBe(200);
    expect(env.jfCalls.some((c) => c.method === 'POST' && c.path.includes('/RemoteSearch/Subtitles/sub-1'))).toBe(true);
    expect((await call('POST', `/api/items/${A}/subtitles/download`, { subtitleId: '../../x' })).statusCode).toBe(400);
    await env.pool.query("update users set role='guest' where name='Admin'");
    expect((await call('GET', `/api/items/${A}/subtitles/search?lang=ger`)).statusCode).toBe(403);
    await env.pool.query("update users set role='admin' where name='Admin'");
  });
});

/** Gives Lea a real session (same shape the login flow creates) so she can call the API. */
async function makeLeaSession() {
  const sid = 'lea-session-' + 'x'.repeat(30);
  await env.kv.set(`sess:${sid}`, JSON.stringify({ userId: leaId, csrf: 'leacsrf', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
  return { cookies: { ff_sid: sid }, csrf: 'leacsrf' };
}
