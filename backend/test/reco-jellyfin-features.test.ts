// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { featurePeople } from '../src/jellyfin/dto.js';
import { makeEnv, type TestEnv } from './helpers.js';

/** R1: MediaServer.libraryFeatures (Jellyfin mapping) against the fake server. */
const id = (c: string) => c.repeat(32);
const M1 = id('a'), S1 = id('c'), E1 = id('d'), BOX = id('b'), M2 = id('e');
const TOKEN = 'secret-session-token-123';
const person = (n: number, type: string, name = `Person ${n}`) => ({ Id: id(n.toString(16)), Name: name, Type: type, Role: type === 'Actor' ? 'Hero' : undefined, PrimaryImageTag: 'tag', Path: '/mnt/people/x' });

const movie = {
  Id: M1, Name: 'Ashfall', Type: 'Movie', Overview: 'A volcano erupts over a small harbour town.', Taglines: ['Run.', 'Second tagline'],
  Genres: ['Drama', 'Thriller'], Tags: ['disaster'], Studios: [{ Name: 'North Pictures', Id: 'x' }, { Name: 'Harbour Films' }],
  ProductionLocations: ['Iceland'], ProductionYear: 2019, PremiereDate: '2019-05-01T00:00:00.0000000Z', RunTimeTicks: 60_000_000_000, // 100 min
  CommunityRating: 7.4, CriticRating: 81, Path: '/mnt/media/ashfall.mkv', MediaSources: [{ Path: '/mnt/media/ashfall.mkv' }], ImageTags: { Primary: 'p' },
  People: [person(1, 'Actor'), person(2, 'Director'), person(3, 'Writer'), person(4, 'Actor'), person(5, 'Composer'), person(6, 'Director'), person(7, 'Director')],
  UserData: { Played: true }, AccessToken: TOKEN, ProviderIds: { Tmdb: '1' },
};
const series = {
  Id: S1, Name: 'Show', Type: 'Series', Overview: 'Neighbours.', Genres: ['Comedy'], Status: 'Continuing', PremiereDate: '2021-01-01T00:00:00Z',
  People: [], Studios: [], Tags: [], ProductionLocations: [],
};
const episode = { Id: E1, Name: 'Pilot', Type: 'Episode', SeriesId: S1, Overview: 'Episode text', Genres: ['Comedy'] };
const bare = { Id: M2, Name: 'Bare', Type: 'Movie' };

let env: TestEnv;
let boxFails = false;
beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const types = (u.searchParams.get('includeItemTypes') ?? '').split(',');
      if (types[0] === 'BoxSet' || u.searchParams.get('parentId')) {
        if (boxFails) return { status: 500 };
        return { json: { Items: u.searchParams.get('parentId') ? [{ Id: M1 }, { Id: S1 }] : [{ Id: BOX }] } };
      }
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const all = [movie, series, episode, bare].filter((i) => types.includes(i.Type) && (!ids.length || ids.includes(i.Id)));
      const start = Number(u.searchParams.get('startIndex') ?? 0), limit = Number(u.searchParams.get('limit') ?? 100);
      return { json: { Items: all.slice(start, start + limit) } };
    },
  });
});
afterAll(() => env.close());

describe('libraryFeatures (Jellyfin)', () => {
  it('is advertised by the capability flag and the method', () => {
    expect(env.ctx.jf.capabilities.libraryFeatures).toBe(true);
    expect(typeof env.ctx.jf.libraryFeatures).toBe('function');
  });

  it('maps genres, tags, studios, people, year, runtime, ratings, countries, tagline, collection; episodes are not listed', async () => {
    const list = await env.ctx.jf.libraryFeatures!(0, 200);
    expect(list.map((f) => f.id)).toEqual([M1, S1, M2]); // the episode rolls up into its series
    expect(list[0]).toEqual({
      id: M1, type: 'Movie', genres: ['Drama', 'Thriller'], tags: ['disaster'], studios: ['North Pictures', 'Harbour Films'],
      people: [id('2'), id('6'), id('3'), id('1'), id('4')], countries: ['Iceland'], year: 2019, runtimeMin: 100, communityRating: 7.4, criticRating: 81,
      collectionId: BOX, overview: 'A volcano erupts over a small harbour town.', tagline: 'Run.',
    });
    expect(list[1]).toMatchObject({ id: S1, type: 'Series', genres: ['Comedy'], seriesStatus: 'continuing', year: 2021, collectionId: BOX, overview: 'Neighbours.' });
    expect(list[2]).toEqual({ id: M2, type: 'Movie', genres: [], tags: [], studios: [], people: [], countries: [] });
  });

  it('asks for films and series sorted SortName,Id and pages with startIndex / limit; ids and savedSince are passed on', async () => {
    env.jfCalls.length = 0;
    await env.ctx.jf.libraryFeatures!(400, 200);
    await env.ctx.jf.libraryFeatures!(0, 10, { ids: [M1, S1.toUpperCase()], savedSince: '2026-10-13T10:00:00.000Z' });
    const [a, b] = env.jfCalls.filter((c) => c.path === '/Items' && c.search.includes('Movie')).map((c) => new URLSearchParams(c.search));
    expect(a!.get('includeItemTypes')).toBe('Movie,Series');
    expect(a!.get('sortBy')).toBe('SortName,Id');
    expect(a!.get('sortOrder')).toBe('Ascending');
    expect(a!.get('startIndex')).toBe('400');
    expect(a!.get('limit')).toBe('200');
    expect(a!.get('minDateLastSaved')).toBeNull();
    expect(a!.get('ids')).toBeNull();
    expect(b!.get('ids')).toBe(`${M1},${S1}`);
    expect(b!.get('minDateLastSaved')).toBe('2026-10-13T10:00:00.000Z');
    const asked = new Set((a!.get('fields') ?? '').split(','));
    for (const f of ['Overview', 'Taglines', 'People', 'Studios']) expect(asked.has(f)).toBe(true);
    for (const bad of ['Path', 'MediaSources', 'MediaStreams']) expect(asked.has(bad)).toBe(false); // nothing that carries a path
  });

  it('answers an ids list without valid ids with nothing and without a request', async () => {
    env.jfCalls.length = 0;
    expect(await env.ctx.jf.libraryFeatures!(0, 10, { ids: [] })).toEqual([]);
    expect(await env.ctx.jf.libraryFeatures!(0, 10, { ids: ['../x', 'nothex'] })).toEqual([]);
    expect(env.jfCalls.filter((c) => c.path === '/Items')).toHaveLength(0);
  });

  it('carries no path, URL, token, image tag or user data', async () => {
    const json = JSON.stringify(await env.ctx.jf.libraryFeatures!(0, 200));
    for (const bad of [TOKEN, 'http', '/mnt/', 'Path', 'ImageTags', 'Primary', 'UserData', 'Played', 'api_key', 'Hero', 'Person ']) expect(json).not.toContain(bad);
  });

  it('a failing box set lookup only drops the collection ids, not the page', async () => {
    boxFails = true;
    await env.kv.del('jf:boxsets:v1');
    try {
      const list = await env.ctx.jf.libraryFeatures!(0, 200);
      expect(list).toHaveLength(3);
      expect(list.every((f) => f.collectionId === undefined)).toBe(true);
    } finally {
      boxFails = false;
      await env.kv.del('jf:boxsets:v1');
    }
  });
});

describe('libraryRoots (Jellyfin)', () => {
  it('maps an episode to its series and a film / series to itself, with the admin key; unknown ids are absent', async () => {
    env.jfCalls.length = 0;
    const out = await env.ctx.jf.libraryRoots!([E1, M1, S1.toUpperCase(), id('f'), 'not-an-id']);
    expect([...out].sort()).toEqual([[M1, M1], [S1, S1], [E1, S1]].sort());
    const calls = env.jfCalls.filter((c) => c.path === '/Items');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toContain('Token="adminkey"');
    const q = new URLSearchParams(calls[0]!.search);
    expect(q.get('includeItemTypes')).toBe('Movie,Series,Episode');
    expect(q.get('userId')).toBeNull();
  });
});

describe('featurePeople', () => {
  const p = (n: number, type: string) => ({ id: id(n.toString(16)), name: `P${n}`, type, image: false });
  it('takes up to 2 directors, 2 creators, 2 writers, then actors in billing order, 8 in all, no duplicates', () => {
    const people = [
      ...Array.from({ length: 10 }, (_, i) => p(i + 1, 'Actor')), p(20, 'Director'), p(21, 'Director'), p(22, 'Director'),
      p(23, 'Writer'), p(24, 'Creator'), p(1, 'Writer'), p(25, 'Composer'),
    ];
    const out = featurePeople(people);
    expect(out).toHaveLength(8);
    expect(out.slice(0, 2)).toEqual([id('14'), id('15')]); // directors (hex ids 20, 21)
    expect(out).not.toContain(id('16')); // third director
    expect(out).not.toContain(id('19')); // composer
    expect(new Set(out).size).toBe(8);
  });
  it('normalises dashed GUIDs', () => {
    expect(featurePeople([{ id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', name: 'x', type: 'Actor', image: false }])).toEqual([id('a')]);
  });
});
