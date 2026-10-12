import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemDto } from '../src/jellyfin/dto.js';
import { tidyResume } from '../src/resume.js';
import { makeEnv, type TestEnv } from './helpers.js';

const mk = (o: Partial<ItemDto> & { id: string }): ItemDto => ({
  name: o.id, type: 'Movie', genres: [], image: false, backdrop: false, logo: false, trailers: 0, played: false, favorite: false,
  positionTicks: 50, runtimeTicks: 100, ...o,
});

describe('tidyResume', () => {
  it('drops <2% and >95%, falls back to playedPercentage', () => {
    const r = tidyResume([
      mk({ id: 'a', positionTicks: 1, lastPlayedDate: '2026-01-01T00:00:00Z' }),
      mk({ id: 'b', positionTicks: 96, lastPlayedDate: '2026-01-01T00:00:00Z' }),
      mk({ id: 'c', positionTicks: 50, lastPlayedDate: '2026-01-01T00:00:00Z' }),
      mk({ id: 'd', runtimeTicks: undefined, playedPercentage: 1, lastPlayedDate: '2026-01-01T00:00:00Z' }),
      mk({ id: 'e', runtimeTicks: undefined, playedPercentage: 30, lastPlayedDate: '2026-01-01T00:00:00Z' }),
    ], new Map());
    expect(r.map((i) => i.id).sort()).toEqual(['c', 'e']);
  });
  it('hides items until played again', () => {
    const hidden = new Map([['a', new Date('2026-02-01T00:00:00Z')]]);
    expect(tidyResume([mk({ id: 'a', lastPlayedDate: '2026-01-01T00:00:00Z' })], hidden)).toHaveLength(0);
    expect(tidyResume([mk({ id: 'a', lastPlayedDate: '2026-03-01T00:00:00Z' })], hidden)).toHaveLength(1);
  });
  it('hides by series id for episodes', () => {
    const hidden = new Map([['s', new Date('2026-02-01T00:00:00Z')]]);
    expect(tidyResume([mk({ id: 'e1', seriesId: 's', lastPlayedDate: '2026-01-01T00:00:00Z' })], hidden)).toHaveLength(0);
    expect(tidyResume([mk({ id: 'e2', seriesId: 's', lastPlayedDate: '2026-03-01T00:00:00Z' })], hidden)).toHaveLength(1);
  });
  it('dedupes per series keeping the newest, sorts newest first, caps at 20', () => {
    const r = tidyResume([
      mk({ id: 'e1', seriesId: 's', lastPlayedDate: '2026-01-01T00:00:00Z' }),
      mk({ id: 'e2', seriesId: 's', lastPlayedDate: '2026-01-05T00:00:00Z' }),
      mk({ id: 'm', lastPlayedDate: '2026-01-03T00:00:00Z' }),
    ], new Map());
    expect(r.map((i) => i.id)).toEqual(['e2', 'm']);
    const many = Array.from({ length: 30 }, (_, n) => mk({ id: `x${n}`, lastPlayedDate: new Date(2026, 0, n + 1).toISOString() }));
    expect(tidyResume(many, new Map())).toHaveLength(20);
  });
});

const EP = 'e'.repeat(32);
const SER = 's'.repeat(31) + '1';
const MOV = 'f'.repeat(32);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let resumeItems: unknown[] = [];

beforeAll(async () => {
  env = await makeEnv({
    'GET /UserItems/Resume': () => ({ json: { Items: resumeItems } }),
    'GET /Items': () => ({ json: { Items: [
      { Id: MOV, Name: 'Alt', Type: 'Movie', UserData: { Played: true, LastPlayedDate: '2026-01-01T10:00:00Z' } },
      { Id: EP, Name: 'Folge', Type: 'Episode', SeriesId: SER, UserData: { Played: true, LastPlayedDate: '2026-01-03T10:00:00Z' } },
    ] } }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: u.pathname.endsWith(MOV) ? { Id: MOV, Name: 'Film', Type: 'Movie', UserData: {} } : { Id: EP, Name: 'Folge', Type: 'Episode', SeriesId: SER, UserData: {} } }),
    'DELETE /UserPlayedItems/[^/]+': () => ({ status: 204 }),
  });
  s = await env.login();
});
afterAll(() => env.close());

const req = (method: 'GET' | 'DELETE', url: string) => env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });

describe('history routes', () => {
  it('merges resume items and sorts by lastPlayedDate', async () => {
    resumeItems = [{ Id: 'c'.repeat(32), Name: 'Laufend', Type: 'Movie', RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 50, LastPlayedDate: '2026-01-05T10:00:00Z' } }];
    const r = await req('GET', '/api/history');
    expect(r.json().items.map((i: any) => i.name)).toEqual(['Laufend', 'Folge', 'Alt']);
  });
  it('DELETE item marks only that item unplayed', async () => {
    const r = await req('DELETE', `/api/history/${EP}`);
    expect(r.statusCode).toBe(200);
    expect(env.jfCalls.filter((c) => c.method === 'DELETE').at(-1)!.path).toBe(`/UserPlayedItems/${EP}`);
  });
  it('DELETE scope=series marks the series unplayed', async () => {
    await req('DELETE', `/api/history/${EP}?scope=series`);
    expect(env.jfCalls.filter((c) => c.method === 'DELETE').at(-1)!.path).toBe(`/UserPlayedItems/${SER}`);
    expect((await req('DELETE', `/api/history/${EP}?scope=bad`)).statusCode).toBe(400);
  });
});

describe('resume route', () => {
  it('hides an item and shows it again after a newer play', async () => {
    const item = (date: string) => ({ Id: MOV, Name: 'Film', Type: 'Movie', RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 40, LastPlayedDate: date } });
    resumeItems = [item('2026-01-01T00:00:00Z')];
    expect((await req('GET', '/api/library/resume')).json().items).toHaveLength(1);
    expect((await req('DELETE', `/api/library/resume/${MOV}`)).statusCode).toBe(200);
    expect((await req('GET', '/api/library/resume')).json().items).toHaveLength(0);
    resumeItems = [item(new Date(Date.now() + 60_000).toISOString())];
    expect((await req('GET', '/api/library/resume')).json().items).toHaveLength(1);
  });
  it('hiding an episode hides the whole series entry until a newer play', async () => {
    const ep = (date: string) => ({ Id: EP, Name: 'Folge', Type: 'Episode', SeriesId: SER, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 40, LastPlayedDate: date } });
    resumeItems = [ep('2026-01-01T00:00:00Z')];
    expect((await req('DELETE', `/api/library/resume/${EP}`)).statusCode).toBe(200);
    expect((await env.pool.query('select item_id from resume_hidden where item_id=$1', [SER])).rowCount).toBe(1);
    expect((await req('GET', '/api/library/resume')).json().items).toHaveLength(0);
    resumeItems = [{ ...ep(new Date(Date.now() + 60_000).toISOString()), Id: 'e'.repeat(32) }]; // another episode, played later
    expect((await req('GET', '/api/library/resume')).json().items).toHaveLength(1);
  });
});
