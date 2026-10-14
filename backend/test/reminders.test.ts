// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reminderTick } from '../src/reminders.js';
import { calendarNotifications } from '../src/routes/polls.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const EP = 'e'.repeat(32);
const EP2 = 'f'.repeat(32);
const SERIES = 'a'.repeat(32);
const REAL = '1'.repeat(32); // Jellyfin replaces the placeholder episode by an item with a NEW id
const REAL2 = '2'.repeat(32);
const MOVIE = 'b'.repeat(32);
const secret = { 'x-webhook-secret': 'webhook-secret-123456' };

let env: TestEnv;
let a: { cookies: Record<string, string>; csrf: string };
let b: { cookies: Record<string, string>; csrf: string };
const mediaStatus: Record<string, number | undefined> = {};
const library = new Map<string, string>(); // 'movie:603' -> jf id
const episodes = new Map<string, { virtual: boolean }>();
const realEps = new Map<string, Array<{ Id: string; IndexNumber: number; LocationType: string }>>(); // `${series}:${season}`
let seriesHasFile = false;
let upcomingId = EP;
const ext: Array<{ url: string; body: string }> = [];

const epJson = (id: string) => ({ Id: id, Name: 'Pilot', Type: 'Episode', SeriesId: SERIES, SeriesName: 'Show', IndexNumber: 1, ParentIndexNumber: 2, PremiereDate: '2030-01-01T00:00:00Z' });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/').pop()!;
      if (id === EP || id === EP2) return { json: epJson(id) };
      if (id === SERIES) return { json: { Id: SERIES, Name: 'Show', Type: 'Series' } };
      if (id === MOVIE) return { json: { Id: MOVIE, Name: 'Film', Type: 'Movie' } };
      return { status: 404 };
    },
    'GET /Shows/Upcoming': () => ({ json: { Items: [{ ...epJson(upcomingId), PremiereDate: '2020-01-01T00:00:00Z' }] } }),
    'GET /Shows/[^/]+/Episodes': (u) => ({ json: { Items: realEps.get(`${u.pathname.split('/')[2]}:${u.searchParams.get('season')}`) ?? [] } }),
    'GET /Items': (u) => {
      if (u.searchParams.get('parentId')) return { json: { Items: seriesHasFile ? [{ Id: 'c'.repeat(32), Type: 'Episode', LocationType: 'FileSystem' }] : [] } };
      const tmdb = u.searchParams.get('anyProviderIdEquals');
      if (tmdb) {
        const type = u.searchParams.get('includeItemTypes') === 'Series' ? 'tv' : 'movie';
        const id = library.get(`${type}:${tmdb.replace('tmdb.', '')}`);
        return { json: { Items: id ? [{ Id: id, Name: 'X' }] : [] } };
      }
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter((i) => episodes.has(i));
      return { json: { Items: ids.map((id) => ({ Id: id, Type: 'Episode', LocationType: episodes.get(id)!.virtual ? 'Virtual' : 'FileSystem' })) } };
    },
  }, {
    ctxPatch: (c) => {
      c.cfg = { ...c.cfg, NTFY_URL: 'https://ntfy.example.com/ff', DISCORD_WEBHOOK_URL: 'https://discord.example.com/hook' };
      c.fetchImpl = (async (url: string, init: RequestInit) => { ext.push({ url: String(url), body: String(init.body) }); return new Response('ok'); }) as unknown as typeof fetch;
    },
    seerr: {
      'GET /api/v1/movie/\\d+': (u) => ({ json: { title: `Film ${u.pathname.split('/').pop()}`, posterPath: '/p.jpg', releaseDate: '2030-05-05', mediaInfo: mediaStatus[`movie:${u.pathname.split('/').pop()}`] ? { status: mediaStatus[`movie:${u.pathname.split('/').pop()}`] } : undefined } }),
      'GET /api/v1/tv/\\d+': () => ({ json: { name: 'Serie', firstAirDate: '2031-01-01' } }),
    },
  });
  a = await env.login(ADMIN);
  b = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: ['friendflix-admins'] });
});
afterAll(() => env.close());

const call = (who: typeof a, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: who.cookies, headers: { 'x-csrf-token': who.csrf }, payload: body as object });
const notes = async (kind: string) => (await env.pool.query('select user_id, dedupe from notifications where kind=$1', [kind])).rows;
const uid = async (name: string) => (await env.pool.query('select id from users where name=$1', [name])).rows[0].id as string;

describe('reminders', () => {
  it('already available -> 409 with item id; no row', async () => {
    mediaStatus['movie:1'] = 5;
    library.set('movie:1', MOVIE);
    const r = await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'already_available', itemId: MOVIE });
    expect((await env.pool.query('select 1 from reminders')).rowCount).toBe(0);
  });

  it('is idempotent, lists, exposes keys, delete only own', async () => {
    const r1 = (await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 603 })).json();
    const r2 = (await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 603 })).json();
    expect(r2.id).toBe(r1.id);
    expect((await env.pool.query('select 1 from reminders')).rowCount).toBe(1);
    expect((await call(a, 'GET', '/api/reminders/keys')).json().keys).toEqual({ 'movie:603': r1.id });
    const l = (await call(a, 'GET', '/api/reminders')).json().reminders;
    expect(l[0]).toMatchObject({ id: r1.id, kind: 'tmdb', mediaType: 'movie', tmdbId: 603, title: 'Film 603', releaseDate: '2030-05-05', poster: '/api/seerr/image/p.jpg' });
    expect((await call(b, 'GET', '/api/reminders')).json().reminders).toEqual([]);
    expect((await call(b, 'DELETE', `/api/reminders/${r1.id}`)).statusCode).toBe(404);
    expect((await call(a, 'DELETE', `/api/reminders/${r1.id}`)).statusCode).toBe(200);
    expect((await call(a, 'DELETE', `/api/reminders/${r1.id}`)).statusCode).toBe(404);
  });

  it('rejects bad bodies and non-episode ids', async () => {
    expect((await call(a, 'POST', '/api/reminders', { mediaType: 'x' })).statusCode).toBe(400);
    expect((await call(a, 'POST', '/api/reminders', { episodeId: MOVIE })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: '/api/reminders', cookies: a.cookies, payload: { mediaType: 'tv', tmdbId: 5 } })).statusCode).toBe(403); // CSRF
  });

  it('MEDIA_AVAILABLE fires once per user; a requester only gets avail-', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    const [ua, ub] = [await uid('Admin'), await uid('Bea')];
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title) values (77,$1,'movie',700,'Dunmoor 3')", [ub]);
    for (const w of [a, b]) expect((await call(w, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 700 })).statusCode).toBe(200);
    library.set('movie:700', MOVIE);
    const hook = () => env.app.inject({ method: 'POST', url: '/internal/webhook/seerr', headers: secret, payload: { notification_type: 'MEDIA_AVAILABLE', subject: 'Dunmoor 3', media: { media_type: 'movie', tmdbId: '700' }, request: { request_id: '77' } } });
    expect((await hook()).statusCode).toBe(200);
    await hook();
    const rem = await notes('reminder');
    const rid = (await env.pool.query('select id from reminders where user_id=$1', [ua])).rows[0].id;
    expect(rem).toEqual([{ user_id: ua, dedupe: `remind-${rid}` }]);
    expect((await notes('available')).map((n) => n.user_id)).toEqual([ub]);
    expect((await env.pool.query('select user_id from reminders where fired_at is not null')).rowCount).toBe(2);
    expect((await call(a, 'GET', '/api/reminders')).json().reminders).toEqual([]);
    const n = (await env.pool.query("select link from notifications where kind='reminder'")).rows[0];
    expect(n.link).toBe(`/item/${MOVIE}`);
  });

  it('personal push never reaches Discord or the global ntfy topic', async () => {
    expect(ext.filter((e) => e.url.includes('discord') && e.body.includes('Film'))).toEqual([]);
    expect(ext.filter((e) => e.body.includes('Dunmoor 3') && e.body.includes('ist jetzt verfügbar') && !e.url.includes('discord'))).toEqual([]);
  });

  it('tick fallback finds titles via Jellyfin', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    mediaStatus['movie:800'] = undefined;
    expect((await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 800 })).statusCode).toBe(200);
    await reminderTick(env.ctx);
    expect(await notes('reminder')).toHaveLength(0);
    library.set('movie:800', MOVIE);
    await reminderTick(env.ctx);
    await reminderTick(env.ctx);
    expect(await notes('reminder')).toHaveLength(1);
  });

  it('episode reminder + follow + calendar job -> one notification', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    episodes.set(EP, { virtual: true });
    const r = await call(a, 'POST', '/api/reminders', { episodeId: EP });
    expect(r.json()).toMatchObject({ coveredByFollow: false });
    expect((await call(a, 'GET', '/api/reminders/keys')).json().keys[`ep:${EP}`]).toBe(r.json().id);
    expect((await call(a, 'POST', '/api/reminders', { episodeId: EP })).json().id).toBe(r.json().id);
    expect((await env.pool.query('select title, series_id from reminders')).rows[0]).toEqual({ title: 'Show S2E1', series_id: SERIES });
    await call(a, 'POST', `/api/series/${SERIES}/follow`);
    expect((await call(a, 'POST', '/api/reminders', { episodeId: EP })).json().coveredByFollow).toBe(true);
    // virtual: nothing fires
    await reminderTick(env.ctx);
    expect(await notes('episode')).toHaveLength(0);
    expect((await env.pool.query('select season, episode from reminders')).rows[0]).toEqual({ season: 2, episode: 1 });
    // announced episode still a placeholder in the season listing
    realEps.set(`${SERIES}:2`, [{ Id: EP, IndexNumber: 1, LocationType: 'Virtual' }]);
    await reminderTick(env.ctx);
    expect(await notes('episode')).toHaveLength(0);
    // the file arrives: Jellyfin replaces the placeholder by an item with a NEW id
    realEps.set(`${SERIES}:2`, [{ Id: 'f'.repeat(32), IndexNumber: 3, LocationType: 'FileSystem' }, { Id: REAL, IndexNumber: 1, LocationType: 'FileSystem' }]);
    upcomingId = REAL;
    await reminderTick(env.ctx);
    await calendarNotifications(env.ctx); // same dedupe key (real id) as the follow job
    const ep = await notes('episode');
    expect(ep).toHaveLength(1);
    expect(ep[0].dedupe).toBe(`cal-${await uid('Admin')}-${REAL}`);
    expect((await env.pool.query("select link from notifications where kind='episode'")).rows[0].link).toBe(`/watch/${REAL}`);
    upcomingId = EP;
    expect((await env.pool.query('select fired_at from reminders')).rows[0].fired_at).not.toBeNull();
  });

  it('episode already available -> 409', async () => {
    episodes.set(EP2, { virtual: false });
    expect((await call(a, 'POST', '/api/reminders', { episodeId: EP2 })).statusCode).toBe(409);
  });

  it('ItemAdded webhook needs the secret and fires movie + episode reminders', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    episodes.set(EP2, { virtual: true });
    expect((await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 900 })).statusCode).toBe(200);
    expect((await call(a, 'POST', '/api/reminders', { episodeId: EP2 })).statusCode).toBe(200);
    const post = (headers: Record<string, string>, payload: object) => env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', headers, payload });
    const movie = { type: 'ItemAdded', itemId: MOVIE, itemType: 'Movie', provider_tmdb: '900' };
    expect((await post({}, movie)).statusCode).toBe(403);
    expect(await notes('reminder')).toHaveLength(0);
    expect((await post(secret, movie)).statusCode).toBe(200);
    // the episode arrives under a new id (dashed + upper case as some plugin versions send it); matched on series + season + number
    const dashed = `${REAL2.slice(0, 8)}-${REAL2.slice(8, 12)}-${REAL2.slice(12, 16)}-${REAL2.slice(16, 20)}-${REAL2.slice(20)}`.toUpperCase();
    expect((await post(secret, { type: 'ItemAdded', itemId: dashed, itemType: 'Episode', seriesId: SERIES, seasonNumber: '1', episodeNumber: '1' })).statusCode).toBe(200);
    expect(await notes('episode')).toHaveLength(0); // wrong season: no match
    expect((await post(secret, { type: 'ItemAdded', itemId: dashed, itemType: 'Episode', seriesId: SERIES.toUpperCase(), seasonNumber: '2', episodeNumber: '1' })).statusCode).toBe(200);
    expect((await env.pool.query("select link from notifications where kind='episode'")).rows[0].link).toBe(`/watch/${REAL2}`);
    await post(secret, movie);
    expect(await notes('reminder')).toHaveLength(1);
    expect(await notes('episode')).toHaveLength(1);
    expect((await env.pool.query('select link from notifications where kind=$1', ['reminder'])).rows[0].link).toBe(`/item/${MOVIE}`);
  });

  it('a re-armed reminder notifies again (dedupe per reminder id)', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    library.set('movie:1000', MOVIE);
    mediaStatus['movie:1000'] = undefined;
    for (let i = 0; i < 2; i++) {
      expect((await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 1000 })).statusCode).toBe(200);
      await reminderTick(env.ctx);
    }
    const n = await notes('reminder');
    expect(n).toHaveLength(2);
    expect(new Set(n.map((x) => x.dedupe)).size).toBe(2);
  });

  it('a requester is only skipped when the avail- notice really exists', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    const ua = await uid('Admin');
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title) values (88,$1,'movie',1100,'Hearth 2')", [ua]);
    library.set('movie:1100', MOVIE);
    expect((await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 1100 })).statusCode).toBe(200);
    await reminderTick(env.ctx); // no avail-88 notice was ever created -> the reminder must notify
    expect(await notes('reminder')).toHaveLength(1);
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    await env.pool.query("insert into notifications(user_id, kind, title, dedupe) values ($1,'available','x','avail-88')", [ua]);
    expect((await call(a, 'POST', '/api/reminders', { mediaType: 'movie', tmdbId: 1100 })).statusCode).toBe(200);
    await reminderTick(env.ctx);
    expect(await notes('reminder')).toHaveLength(0);
  });

  it('a series reminder needs at least one real episode', async () => {
    await env.pool.query('truncate reminders');
    await env.pool.query('truncate notifications');
    library.set('tv:1396', SERIES);
    seriesHasFile = false;
    expect((await call(a, 'POST', '/api/reminders', { mediaType: 'tv', tmdbId: 1396 })).statusCode).toBe(200);
    await reminderTick(env.ctx);
    const post = (payload: object) => env.app.inject({ method: 'POST', url: '/internal/webhook/jellyfin', headers: secret, payload });
    await post({ type: 'ItemAdded', itemId: SERIES, itemType: 'Series', provider_tmdb: '1396' });
    expect(await notes('reminder')).toHaveLength(0);
    expect((await env.pool.query('select fired_at from reminders')).rows[0].fired_at).toBeNull();
    seriesHasFile = true;
    await reminderTick(env.ctx);
    expect(await notes('reminder')).toHaveLength(1);
    expect((await env.pool.query("select link from notifications where kind='reminder'")).rows[0].link).toBe(`/item/${SERIES}`);
    seriesHasFile = false;
  });
});
