import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const MOV = hex(1), SER = hex(2), EP = hex(3), PLAYED = hex(4), PROG = hex(5), HID = hex(6), OTHER = hex(7);
const lib: Record<string, any> = {
  [MOV]: { Id: MOV, Name: 'Film', Type: 'Movie', UserData: {} },
  [SER]: { Id: SER, Name: 'Serie', Type: 'Series', ChildCount: 3, UserData: { UnplayedItemCount: 2 } },
  [EP]: { Id: EP, Name: 'Folge', Type: 'Episode', SeriesId: SER, UserData: {} },
  [PLAYED]: { Id: PLAYED, Name: 'Gesehen', Type: 'Movie', UserData: { Played: true } },
  [PROG]: { Id: PROG, Name: 'Mittendrin', Type: 'Movie', UserData: { PlaybackPositionTicks: 5000 } },
  [OTHER]: { Id: OTHER, Name: 'Anderes', Type: 'Movie', UserData: {} },
};
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const hdr = () => ({ 'x-csrf-token': s.csrf });
const get = (url: string) => env.app.inject({ url, cookies: s.cookies });
const put = (id: string, status: string) => env.app.inject({ method: 'PUT', url: `/api/items/${id}/status`, cookies: s.cookies, headers: hdr(), payload: { status } });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => {
      const i = lib[u.pathname.split('/')[2]!];
      return i ? { json: i } : { status: 404 };
    },
    'GET /Items': (u) => {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return { json: { Items: ids.map((i) => lib[i]).filter(Boolean) } };
    },
    'GET /UserItems/Resume': () => ({
      json: { Items: [
        { Id: PROG, Name: 'Mittendrin', Type: 'Movie', RunTimeTicks: 10000, UserData: { PlaybackPositionTicks: 5000, LastPlayedDate: '2020-01-01T00:00:00Z' } },
        { Id: EP, Name: 'Folge', Type: 'Episode', SeriesId: SER, RunTimeTicks: 10000, UserData: { PlaybackPositionTicks: 5000, LastPlayedDate: '2020-01-02T00:00:00Z' } },
        { Id: OTHER, Name: 'Anderes', Type: 'Movie', RunTimeTicks: 10000, UserData: { PlaybackPositionTicks: 4000, LastPlayedDate: '2020-01-03T00:00:00Z' } },
      ] },
    }),
    'GET /Shows/NextUp': () => ({ json: { Items: [{ Id: EP, Name: 'Folge', Type: 'Episode', SeriesId: SER }, { Id: hex(8), Name: 'Nächste', Type: 'Episode', SeriesId: hex(9) }] } }),
  });
  s = await env.login();
});
afterAll(() => env.close());

describe('watch status', () => {
  it('derives none / watching / watched from Jellyfin', async () => {
    expect((await get(`/api/items/${MOV}/status`)).json()).toEqual({ status: 'none' });
    expect((await get(`/api/items/${PROG}/status`)).json()).toEqual({ status: 'watching' });
    expect((await get(`/api/items/${PLAYED}/status`)).json()).toEqual({ status: 'watched' });
    expect((await get(`/api/items/${SER}/status`)).json()).toEqual({ status: 'watching' }); // unplayed < childCount
  });
  it('404 for invisible items, 400 for bad status', async () => {
    expect((await get(`/api/items/${HID}/status`)).statusCode).toBe(404);
    expect((await put(HID, 'planned')).statusCode).toBe(404);
    expect((await put(MOV, 'watching')).statusCode).toBe(400);
  });
  it('planned writes the watchlist, dropped replaces it and hides from Weiterschauen, none clears both', async () => {
    expect((await put(MOV, 'planned')).json()).toEqual({ status: 'planned' });
    expect((await get(`/api/items/${MOV}/status`)).json()).toEqual({ status: 'planned' });
    expect((await get(`/api/items/${MOV}`)).json().inWatchlist).toBe(true);

    expect((await put(MOV, 'dropped')).json()).toEqual({ status: 'dropped' });
    expect((await get(`/api/items/${MOV}/status`)).json()).toEqual({ status: 'dropped' });
    expect((await get(`/api/items/${MOV}`)).json().inWatchlist).toBe(false);
    expect((await env.pool.query('select 1 from resume_hidden where item_id=$1', [MOV])).rowCount).toBe(1);

    expect((await put(MOV, 'planned')).json()).toEqual({ status: 'planned' });
    expect((await env.pool.query('select 1 from dropped where item_id=$1', [MOV])).rowCount).toBe(0);

    expect((await put(MOV, 'none')).json()).toEqual({ status: 'none' });
    expect((await env.pool.query('select 1 from watchlist where item_id=$1', [MOV])).rowCount).toBe(0);
    expect((await put(PROG, 'none')).json()).toEqual({ status: 'watching' }); // derived status shows through
  });
  it('normalises an episode to its series', async () => {
    expect((await put(EP, 'planned')).json()).toEqual({ status: 'planned' });
    expect((await env.pool.query('select item_id from watchlist')).rows.map((r) => r.item_id)).toEqual([SER]);
    expect((await get(`/api/items/${EP}/status`)).json()).toEqual({ status: 'planned' });
    expect((await put(EP, 'none')).statusCode).toBe(200);
  });
  it('POST /watchlist ends "dropped"', async () => {
    await put(MOV, 'dropped');
    await env.app.inject({ method: 'POST', url: `/api/items/${MOV}/watchlist`, cookies: s.cookies, headers: hdr() });
    expect((await get(`/api/items/${MOV}/status`)).json()).toEqual({ status: 'planned' });
    await put(MOV, 'none');
  });
});

describe('dropped list', () => {
  it('GET /api/dropped lists visible dropped titles, newest first', async () => {
    await put(MOV, 'dropped');
    await put(OTHER, 'dropped');
    await env.pool.query("insert into dropped(profile_id,item_id) select profile_id, $1 from dropped limit 1", [HID]); // invisible one
    await env.pool.query("update dropped set dropped_at = now() - interval '1 day' where item_id=$1", [MOV]);
    const b = (await get('/api/dropped')).json();
    expect(b.items.map((i: any) => i.id)).toEqual([OTHER, MOV]);
  });
  it('dropped titles leave Weiterschauen and Als Nächstes (episodes by series)', async () => {
    await env.pool.query('delete from resume_hidden');
    const ids = async (u: string) => (await get(u)).json().items.map((i: any) => i.id).sort();
    expect(await ids('/api/library/resume')).toEqual([EP, PROG].sort()); // OTHER is dropped
    expect(await ids('/api/library/nextup')).toEqual([EP, hex(8)].sort());
    await put(SER, 'dropped');
    expect(await ids('/api/library/resume')).toEqual([PROG]);
    expect(await ids('/api/library/nextup')).toEqual([hex(8)]);
    await put(SER, 'none');
    await put(OTHER, 'none');
    await env.pool.query('delete from resume_hidden');
    expect(await ids('/api/library/resume')).toEqual([EP, OTHER, PROG].sort());
  });
});
