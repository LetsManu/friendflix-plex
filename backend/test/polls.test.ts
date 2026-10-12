import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDuePolls, pollTick, resolveRequestedPolls } from '../src/polls.js';
import { calendarNotifications } from '../src/routes/polls.js';
import { parties } from '../src/routes/party.js';
import { seerrHooks } from '../src/hooks.js';
import { makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), SERIES = 'c'.repeat(32);
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let libraryHasDune = false;
let imported = '';

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => { const id = u.pathname.split('/').pop()!; return { json: { Id: id, Name: id === A ? 'Alien' : id === B ? 'Brazil' : 'Serie', Type: id === SERIES ? 'Series' : 'Movie' } }; },
    'GET /Items': (u) => u.searchParams.get('ids') ? { json: { Items: u.searchParams.get('ids')!.split(',').map((Id) => ({ Id, Name: Id === A ? 'Alien' : 'Brazil', Type: 'Movie' })) } } : ({ json: { Items: libraryHasDune && u.search.includes('tmdb.438631') ? [{ Id: 'd'.repeat(32), Name: 'Dune' }] : [] } }),
    'GET /Shows/Upcoming': () => ({ json: { Items: [{ Id: 'e'.repeat(32), Name: 'Pilot', Type: 'Episode', SeriesId: SERIES, SeriesName: 'Serie', IndexNumber: 1, ParentIndexNumber: 1, PremiereDate: '2020-01-01T00:00:00Z' }, { Id: 'f'.repeat(32), Name: 'Later', Type: 'Episode', SeriesId: SERIES, SeriesName: 'Serie', PremiereDate: '2999-01-01T00:00:00Z' }] } }),
  }, {
    seerr: {
      'GET /api/v1/movie/\\d+': () => ({ json: { title: 'Dune', posterPath: '/dune.jpg' } }),
      'GET /api/v1/user': () => ({ json: { results: imported ? [{ id: 9, jellyfinUserId: imported }] : [] } }),
      'POST /api/v1/user/import-from-jellyfin': (_u, _i, b) => { imported = b.jellyfinUserIds[0]; return { json: [{ id: 9 }] }; },
      'POST /api/v1/request': () => ({ json: { id: 77 } }),
      'POST /api/v1/request/77/approve': () => ({ json: {} }),
    },
  });
  admin = await env.login();
});
afterAll(() => env.close());
const call = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

describe('polls', () => {
  it('library winner -> scheduled party room with auto-start, tie goes to first option', async () => {
    const r = await call('POST', '/api/polls', { title: 'Freitag', options: [{ jfItemId: A }, { jfItemId: B }], closesInMinutes: 5, startsAfterMinutes: 10 });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    expect((await call('POST', '/api/polls', { title: 'Zweite', options: [{ jfItemId: A }, { jfItemId: B }] })).statusCode).toBe(409); // one open poll per user
    const d = (await call('GET', `/api/polls/${id}`)).json();
    expect((await call('POST', `/api/polls/${id}/vote`, { optionId: d.options[1].id })).statusCode).toBe(200);
    await call('POST', `/api/polls/${id}/vote`, { optionId: d.options[0].id }); // changing the vote is allowed
    expect((await call('GET', `/api/polls/${id}`)).json().options.map((o: any) => o.votes)).toEqual([1, 0]);
    await env.pool.query("update polls set closes_at = now() - interval '1 second'");
    await closeDuePolls(env.ctx);
    const after = (await call('GET', `/api/polls/${id}`)).json();
    expect(after.status).toBe('scheduled');
    const room = parties.get(after.roomId)!;
    expect(room.title).toBe('Alien');
    expect(room.startAt).toBeGreaterThan(Date.now());
    expect((await call('POST', `/api/polls/${id}/vote`, { optionId: d.options[0].id })).statusCode).toBe(409); // closed
    expect((await call('GET', '/api/notifications')).json().notifications.some((n: any) => n.kind === 'poll_scheduled')).toBe(true);
    await pollTick(env.ctx); // idempotent
  });

  it('non-library winner needs admin approval -> seerr request -> auto-scheduled once available', async () => {
    await env.pool.query("update polls set status='started'");
    const r = await call('POST', '/api/polls', { title: 'Samstag', options: [{ tmdbId: 438631, mediaType: 'movie' }, { jfItemId: A }], closesInMinutes: 5 });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    const d = (await call('GET', `/api/polls/${id}`)).json();
    expect(d.options[0]).toMatchObject({ title: 'Dune', inLibrary: false });
    await call('POST', `/api/polls/${id}/vote`, { optionId: d.options[0].id });
    await env.pool.query("update polls set closes_at = now() - interval '1 second' where id=$1", [id]);
    await closeDuePolls(env.ctx);
    expect((await call('GET', `/api/polls/${id}`)).json().status).toBe('needs_approval');
    expect((await call('GET', '/api/admin/polls')).json().polls).toHaveLength(1);
    expect((await call('POST', `/api/admin/polls/${id}/approve`)).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/polls/${id}/approve`)).statusCode).toBe(409);
    const p = (await call('GET', `/api/polls/${id}`)).json();
    expect(p.status).toBe('requested');
    expect(env.seerrCalls.find((c) => c.path === '/api/v1/request')!.body).toMatchObject({ mediaType: 'movie', mediaId: 438631, userId: 9 });
    await resolveRequestedPolls(env.ctx);
    expect((await call('GET', `/api/polls/${id}`)).json().status).toBe('requested'); // not in library yet
    libraryHasDune = true;
    await seerrHooks.run(env.ctx, { type: 'available', tmdbId: 438631, mediaType: 'movie' });
    const done = (await call('GET', `/api/polls/${id}`)).json();
    expect(done.status).toBe('scheduled');
    expect(parties.get(done.roomId)!.itemId).toBe('d'.repeat(32));
  });

  it('polls without votes are cancelled; invalid options rejected', async () => {
    await env.pool.query("update polls set status='started'");
    const id = (await call('POST', '/api/polls', { title: 'Leer', options: [{ jfItemId: A }, { jfItemId: B }], closesInMinutes: 5 })).json().id;
    await env.pool.query("update polls set closes_at = now() - interval '1 second' where id=$1", [id]);
    await closeDuePolls(env.ctx);
    expect((await call('GET', `/api/polls/${id}`)).json().status).toBe('cancelled');
    expect((await call('POST', '/api/polls', { title: 'Bad', options: [{ jfItemId: 'xyz' }, { jfItemId: A }] })).statusCode).toBe(400);
  });
});

describe('ratings and calendar', () => {
  it('rates with short review, upserts, averages; rejects long reviews', async () => {
    expect((await call('PUT', `/api/items/${A}/rating`, { stars: 4, review: 'Stark!' })).statusCode).toBe(200);
    await call('PUT', `/api/items/${A}/rating`, { stars: 5, review: 'Noch besser beim 2. Mal' });
    const r = (await call('GET', `/api/items/${A}/ratings`)).json();
    expect(r.ratings).toHaveLength(1);
    expect(r.average).toBe(5);
    expect(r.ratings[0]).toMatchObject({ mine: true, review: 'Noch besser beim 2. Mal' });
    expect((await call('PUT', `/api/items/${A}/rating`, { stars: 6 })).statusCode).toBe(400);
    expect((await call('PUT', `/api/items/${A}/rating`, { stars: 3, review: 'x'.repeat(281) })).statusCode).toBe(400);
  });
  it('follows a series and gets exactly one notification per aired episode', async () => {
    expect((await call('POST', `/api/series/${SERIES}/follow`)).statusCode).toBe(200);
    const cal = (await call('GET', '/api/calendar')).json().items;
    expect(cal.every((e: any) => e.followed)).toBe(true);
    await calendarNotifications(env.ctx);
    await calendarNotifications(env.ctx);
    const n = (await call('GET', '/api/notifications')).json().notifications.filter((x: any) => x.kind === 'episode');
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain('S1E1');
  });
  it('skips series any profile of the account dropped (calendar + notifications)', async () => {
    await env.ctx.db.query("delete from notifications where kind='episode'");
    await env.ctx.db.query("insert into dropped(profile_id,item_id) select id, $1 from profiles", [SERIES]);
    expect((await call('GET', '/api/calendar')).json().items.filter((e: any) => e.seriesId === SERIES)).toHaveLength(0);
    await calendarNotifications(env.ctx);
    expect((await call('GET', '/api/notifications')).json().notifications.filter((x: any) => x.kind === 'episode')).toHaveLength(0);
    await env.ctx.db.query('delete from dropped where item_id=$1', [SERIES]);
    expect((await call('GET', '/api/calendar')).json().items.some((e: any) => e.seriesId === SERIES)).toBe(true);
  });
});
