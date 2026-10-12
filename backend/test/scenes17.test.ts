import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaCapabilities } from '../src/media/types.js';
import { makeEnv, type TestEnv } from './helpers.js';

/** Block 17 P1: "Besetzung & Infos" (GET /api/items/:id/castinfo) and chapters (GET /api/items/:id/chapters). */
const MOV = 'a'.repeat(32), SER = 'b'.repeat(32), EP = 'c'.repeat(32), HID = 'd'.repeat(32), NOCH = 'e'.repeat(32);
const P = (n: number) => n.toString(16).padStart(32, '0');
const hidden = new Set([HID]);
let peopleHits = 0;

const raw: Record<string, Record<string, unknown>> = {
  [MOV]: {
    Id: MOV, Name: 'Ashfall', Type: 'Movie', ProductionYear: 1979, OfficialRating: 'FSK-16', CommunityRating: 8.4, Genres: ['Horror', 'Sci-Fi'],
    People: [
      { Id: P(1), Name: 'Sigourney Weaver', Role: 'Ripley', Type: 'Actor', PrimaryImageTag: 't1' },
      { Id: P(2), Name: 'Tom Skerritt', Role: 'Dallas', Type: 'Actor' },
      { Id: P(3), Name: 'Ridley Scott', Type: 'Director', PrimaryImageTag: 't3' },
      { Id: P(4), Name: "Dan O'Bannon", Type: 'Writer' },
      { Id: P(1), Name: 'Sigourney Weaver', Role: 'Ripley (voice)', Type: 'Actor' },
    ],
    Studios: [{ Name: 'Twelfth Street Studios', Id: 'x' }, { Name: 'Brookline' }], Tags: ['space', 'alien'],
    Chapters: [
      { StartPositionTicks: 6_000_000_000, Name: 'Die Nostromo', ImageTag: 'c2' },
      { StartPositionTicks: 0, Name: 'Chapter 1', ImageTag: 'c1' },
      { StartPositionTicks: 12_000_000_000, Name: '  Kapitel 3 ' },
      { StartPositionTicks: 12_000_000_000, Name: 'Doppelt' },
    ],
  },
  [SER]: {
    Id: SER, Name: 'Dahlia', Type: 'Series', Genres: ['Drama', 'Mystery'],
    People: [
      { Id: P(10), Name: 'Louis Hofmann', Role: 'Jonas Kahnwald', Type: 'Actor', PrimaryImageTag: 'a' },
      { Id: P(11), Name: 'Lisa Vicari', Role: 'Martha Nielsen', Type: 'Actor' },
      { Id: P(12), Name: 'Baran bo Odar', Type: 'Creator' },
      { Id: P(13), Name: 'Jantje Friese', Type: 'Writer' },
    ],
    Studios: [{ Name: 'Wiedemann & Berg' }], Tags: ['time travel'],
  },
  [EP]: {
    Id: EP, Name: 'Geheimnisse', Type: 'Episode', SeriesId: SER, SeriesName: 'Dahlia', IndexNumber: 1, ParentIndexNumber: 1, Genres: [],
    People: [
      { Id: P(10), Name: 'Louis Hofmann', Role: 'Jonas', Type: 'Actor' },
      { Id: P(20), Name: 'Gast Eins', Role: 'Polizist', Type: 'GuestStar', PrimaryImageTag: 'g' },
      { Id: P(21), Name: 'Nur Hier', Role: 'Bäcker', Type: 'Actor' },
      { Id: P(22), Name: 'Episoden Regie', Type: 'Director' },
    ],
    Studios: [], Tags: [],
  },
  [HID]: { Id: HID, Name: 'Versteckt', Type: 'Movie', People: [{ Id: P(30), Name: 'Geheim', Type: 'Actor' }], Chapters: [{ StartPositionTicks: 0, Name: 'X' }] },
  [NOCH]: { Id: NOCH, Name: 'Ohne Kapitel', Type: 'Movie' },
};
const itemJson = (id: string) => { const r = raw[id]!; const { People: _p, Studios: _s, Tags: _t, Chapters: _c, ...rest } = r; return rest; };

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter((i) => raw[i] && !hidden.has(i));
      const fields = u.searchParams.get('fields') ?? '';
      if (fields === 'People') peopleHits++;
      return { json: { Items: ids.map((i) => (fields.includes('People') || fields.includes('Chapters') ? raw[i] : itemJson(i))) } };
    },
    'GET /Items/[^/]+': (u) => { const id = u.pathname.split('/')[2]!; return raw[id] && !hidden.has(id) ? { json: itemJson(id) } : { status: 404 }; },
    'GET /Users/[^/]+/Items/[^/]+': () => ({ status: 404 }),
  });
  s = await env.login();
});
afterAll(() => env.close());
const get = (url: string, cookies = s.cookies) => env.app.inject({ url, cookies });

describe('GET /api/items/:id/castinfo', () => {
  it('film: cast with character names, crew, studios, tags, genres and rating (no duplicates)', async () => {
    const r = await get(`/api/items/${MOV}/castinfo`);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.item).toEqual({ id: MOV, name: 'Ashfall', type: 'Movie', year: 1979, rating: 'FSK-16', communityRating: 8.4 });
    expect(b.cast).toEqual([{ id: P(1), name: 'Sigourney Weaver', role: 'Ripley', image: true }, { id: P(2), name: 'Tom Skerritt', role: 'Dallas', image: false }]);
    expect(b.guests).toEqual([]);
    expect(b.directors).toEqual([{ id: P(3), name: 'Ridley Scott', image: true }]);
    expect(b.writers.map((p: { name: string }) => p.name)).toEqual(["Dan O'Bannon"]);
    expect(b.studios).toEqual(['Twelfth Street Studios', 'Brookline']);
    expect(b.tags).toEqual(['space', 'alien']);
    expect(b.genres).toEqual(['Horror', 'Sci-Fi']);
    // the credits lookup runs with the viewer's own server identity (its access rules apply)
    const call = env.jfCalls.find((c) => c.path === '/Items' && c.search.includes('People%2CStudios%2CTags'))!;
    expect(call.search).toContain('userId=');
    expect(call.auth ?? '').not.toContain('adminkey');
  });

  it('episode: series regulars as cast, everyone else on the episode as guest star, episode crew, series facts', async () => {
    const b = (await get(`/api/items/${EP}/castinfo`)).json();
    expect(b.item).toMatchObject({ id: EP, type: 'Episode', seriesId: SER, seriesName: 'Dahlia' });
    expect(b.cast.map((p: { role: string }) => p.role)).toEqual(['Jonas Kahnwald', 'Martha Nielsen']);
    expect(b.guests).toEqual([{ id: P(20), name: 'Gast Eins', role: 'Polizist', image: true }, { id: P(21), name: 'Nur Hier', role: 'Bäcker', image: false }]);
    expect(b.directors.map((p: { name: string }) => p.name)).toEqual(['Episoden Regie']);
    expect(b.writers.map((p: { name: string }) => p.name)).toEqual(['Jantje Friese']); // none on the episode: the series' writers
    expect(b.creators.map((p: { name: string }) => p.name)).toEqual(['Baran bo Odar']);
    expect(b.studios).toEqual(['Wiedemann & Berg']);
    expect(b.tags).toEqual(['time travel']);
    expect(b.genres).toEqual(['Drama', 'Mystery']);
  });

  it('needs a session', async () => {
    expect((await env.app.inject({ url: `/api/items/${MOV}/castinfo` })).statusCode).toBe(401);
  });

  it('invisible items are 404, also once their credits are cached', async () => {
    expect((await get(`/api/items/${HID}/castinfo`)).statusCode).toBe(404);
    hidden.delete(HID);
    expect((await get(`/api/items/${HID}/castinfo`)).statusCode).toBe(200);
    hidden.add(HID);
    env.ctx.jf.forgetItems(); // the short item() memo; the cached credits must not answer on their own
    const r = await get(`/api/items/${HID}/castinfo`);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('Geheim');
  });

  it('rejects malformed ids', async () => {
    expect((await get('/api/items/not-an-id/castinfo')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get('/api/items/not-an-id/castinfo')).statusCode).toBeLessThan(500);
  });

  it('servers without credits(): people() + tags from itemTraits()', async () => {
    const jf = env.ctx.jf as unknown as { credits?: unknown };
    jf.credits = undefined;
    try {
      await env.kv.del(`castinfo:v1:${(await env.pool.query('select jellyfin_user_id j from users limit 1')).rows[0].j}:${NOCH}`);
      raw[NOCH]!.People = [{ Id: P(40), Name: 'Fallback', Role: 'Held', Type: 'Actor' }];
      raw[NOCH]!.Tags = ['fallback-tag'];
      peopleHits = 0;
      const b = (await get(`/api/items/${NOCH}/castinfo`)).json();
      expect(peopleHits).toBe(1);
      expect(b.cast).toEqual([{ id: P(40), name: 'Fallback', role: 'Held', image: false }]);
      expect(b.studios).toEqual([]);
    } finally {
      delete jf.credits; // back to the prototype's method
    }
  });
});

describe('GET /api/items/:id/chapters', () => {
  it('sorted chapters with stills, generic names blanked, duplicates dropped', async () => {
    const r = await get(`/api/items/${MOV}/chapters`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      supported: true,
      chapters: [
        { start: 0, name: '', image: `/media/Items/${MOV}/Images/Chapter/1?tag=c1&maxWidth=320&quality=80` },
        { start: 600, name: 'Die Nostromo', image: `/media/Items/${MOV}/Images/Chapter/0?tag=c2&maxWidth=320&quality=80` },
        { start: 1200, name: '' },
      ],
    });
  });
  it('an item without chapters answers an empty list', async () => {
    expect((await get(`/api/items/${NOCH}/chapters`)).json()).toEqual({ supported: true, chapters: [] });
  });
  it('needs a session; invisible items are 404, also from the cache', async () => {
    expect((await env.app.inject({ url: `/api/items/${MOV}/chapters` })).statusCode).toBe(401);
    expect((await get(`/api/items/${HID}/chapters`)).statusCode).toBe(404);
    hidden.delete(HID);
    expect((await get(`/api/items/${HID}/chapters`)).json().chapters).toHaveLength(1);
    hidden.add(HID);
    env.ctx.jf.forgetItems();
    expect((await get(`/api/items/${HID}/chapters`)).statusCode).toBe(404);
  });
  it('capability off: supported=false without asking the server for chapters (still access-checked)', async () => {
    const prev = env.ctx.jf.capabilities;
    (env.ctx.jf as { capabilities: MediaCapabilities }).capabilities = { ...prev, chapters: false };
    try {
      env.jfCalls.length = 0;
      expect((await get(`/api/items/${MOV}/chapters`)).json()).toEqual({ supported: false, chapters: [] });
      expect(env.jfCalls.some((c) => c.search.includes('Chapters'))).toBe(false);
      expect((await get(`/api/items/${HID}/chapters`)).statusCode).toBe(404);
    } finally {
      (env.ctx.jf as { capabilities: MediaCapabilities }).capabilities = prev;
    }
  });
  it('/api/me reports the chapters capability', async () => {
    expect((await get('/api/me')).json().server.capabilities.chapters).toBe(true);
  });
});
