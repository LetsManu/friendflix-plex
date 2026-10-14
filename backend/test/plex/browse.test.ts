// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaUser } from '../../src/media/types.js';
import { publicCapabilities } from '../../src/media/types.js';
import { PLEX_TOKEN } from '../plexfake.js';
import { identity, ids, item, plexEnv, section, tag, type PlexEnv } from './setup.js';

describe('Plex browse + user data over the mirror', () => {
  let e: PlexEnv;
  let u: MediaUser;
  let other: MediaUser;
  const lib: Record<string, string> = {};
  const outputs: unknown[] = [];
  const keep = <T>(v: T): T => (outputs.push(v), v);

  beforeAll(async () => {
    e = await plexEnv((f) => {
      lib.alpha = f.addMovie({ title: 'Alpha Horror', rating: 'R', year: 1985, genres: ['Horror', 'Thriller'], audienceRating: 8.4, studio: 'Night Studio', guids: ['tmdb://4242', 'imdb://tt1'], addedAt: 1791990000 });
      lib.beta = f.addMovie({ title: 'Beta Comedy', rating: 'PG', year: 1999, genres: ['Comedy'], audienceRating: 6.1, studio: 'Sun Pictures', actors: [{ id: 501, tag: 'Jane Doe', role: 'Lead' }] });
      lib.gamma = f.addMovie({ title: 'Gamma Horror', rating: 'R', year: 2001, genres: ['Horror'], audienceRating: 7.0, actors: [{ id: 501, tag: 'Jane Doe', role: 'Villain' }] });
      // markers on one episode (Plex Pass analysis) + a label on the show
      const ep = f.items.get('5')!;
      ep.Marker = [{ id: 1, type: 'intro', startTimeOffset: 1000, endTimeOffset: 31000 }, { id: 2, type: 'credits', startTimeOffset: 50000, endTimeOffset: 60000 }];
      f.items.get('3')!.Label = [{ id: 77, tag: 'Anime' }];
      f.items.get('3')!.Country = [{ id: 78, tag: 'Japan' }];
    });
    u = await identity(e.ms, 'admin');
    other = await identity(e.ms, 'family');
  });
  afterAll(async () => {
    // nothing any browse call returned may ever contain the Plex token
    expect(JSON.stringify(outputs)).not.toContain(PLEX_TOKEN);
    await e.close();
  });

  it('items: default types, SortName, paging + total', async () => {
    const all = keep(await e.ms.items(u, {}));
    expect(all.items.map((i) => i.name)).toEqual(['Alpha Horror', 'Beta Comedy', 'Gamma Horror', 'MAD TEST', 'Test Movie One', 'Test Movie Two']);
    expect(all.total).toBe(6);
    const p2 = await e.ms.items(u, { start: 2, limit: 2 });
    expect(p2.items.map((i) => i.name)).toEqual(['Gamma Horror', 'MAD TEST']);
    expect(p2.total).toBe(6);
    expect((await e.ms.items(u, { desc: true, limit: 1 })).items[0]!.name).toBe('Test Movie Two');
    expect((await e.ms.items(u, { types: 'Movie,Series,BoxSet', limit: 1, start: 0 })).items[0]!.type).toBe('Movie');
    expect((await e.ms.items(u, { types: 'BoxSet' })).items.map((i) => i.name)).toEqual(['Both Movies']);
  });

  it('items: filters (genre any-of, studio, label, year, decade, minRating, q, ids, person, parent)', async () => {
    const names = async (q: Parameters<typeof e.ms.items>[1]) => (await e.ms.items(u, q)).items.map((i) => i.name);
    expect(await names({ genre: 'horror' })).toEqual(['Alpha Horror', 'Gamma Horror', 'MAD TEST']);
    expect(await names({ genre: 'Comedy|Thriller' })).toEqual(['Alpha Horror', 'Beta Comedy', 'MAD TEST']);
    expect(await names({ studio: 'night studio' })).toEqual(['Alpha Horror']);
    expect(await names({ tag: 'anime' })).toEqual(['MAD TEST']);
    expect(await names({ year: 1999 })).toEqual(['Beta Comedy']);
    expect(await names({ decade: 1980 })).toEqual(['Alpha Horror']);
    expect(await names({ minRating: 7 })).toEqual(['Alpha Horror', 'Gamma Horror']);
    expect(await names({ q: 'horr' })).toEqual(['Alpha Horror', 'Gamma Horror']);
    expect(await names({ q: '%' })).toEqual([]); // LIKE wildcards are literal
    expect(await names({ ids: [item(lib.beta!), item(3), 'not-an-id', item(999)] })).toEqual(['Beta Comedy', 'MAD TEST']);
    expect(await names({ person: tag(501) })).toEqual(['Beta Comedy', 'Gamma Horror']);
    expect(await names({ person: tag(10) })).toEqual(['MAD TEST']);
    expect(await names({ person: item(1) })).toEqual([]);
    expect(await names({ parentId: section(2) })).toEqual(['MAD TEST']);
    expect(await names({ parentId: section(1), sort: 'CommunityRating', desc: true })).toEqual(['Alpha Horror', 'Gamma Horror', 'Beta Comedy', 'Test Movie Two', 'Test Movie One']); // unrated last, ties by key in the same direction
    expect(await names({ parentId: item(3), types: 'Season' })).toEqual(['Season 1', 'Season 2']);
    expect(await names({ parentId: item(12), sort: 'PremiereDate,SortName' })).toEqual(['Test Movie One', 'Test Movie Two']);
    const newest = (await e.ms.items(u, { types: 'Episode', sort: 'DateCreated', desc: true, limit: 2 })).items;
    expect(newest.map((i) => i.type)).toEqual(['Episode', 'Episode']);
    expect(Date.parse(newest[0]!.dateCreated!)).toBeGreaterThanOrEqual(Date.parse(newest[1]!.dateCreated!));
    const random = await names({ sort: 'Random', limit: 50 });
    expect([...random].sort()).toEqual(['Alpha Horror', 'Beta Comedy', 'Gamma Horror', 'MAD TEST', 'Test Movie One', 'Test Movie Two']);
  });

  it('item DTO: series / season / episode / movie shapes', async () => {
    const show = keep(await e.ms.item(u, item(3)));
    expect(show).toMatchObject({ id: item(3), name: 'MAD TEST', type: 'Series', year: 2019, rating: 'TV-PG', childCount: 2, unplayedCount: 6, played: false, image: true });
    expect(show.genres).toEqual(['Mini-Series', 'Horror', 'Crime', 'Suspense', 'Thriller']);
    expect(show.premiereDate).toBe('2019-10-01T00:00:00.000Z');
    expect(show.indexNumber).toBeUndefined();
    const ep = keep(await e.ms.item(u, item(9)));
    expect(ep).toMatchObject({ type: 'Episode', seriesId: item(3), seriesName: 'MAD TEST', seasonId: item(8), indexNumber: 1, parentIndexNumber: 2, runtimeTicks: 600_210_000, rating: 'TV-PG' });
    expect(ep.imageTags?.seriesPrimary).toBe('1791799954');
    const season = await e.ms.item(u, item(4));
    expect(season).toMatchObject({ type: 'Season', seriesId: item(3), indexNumber: 1, childCount: 3, unplayedCount: 3 });
    const movie = keep(await e.ms.item(u, item(1)));
    expect(movie).toMatchObject({ type: 'Movie', name: 'Test Movie One', trailers: 1, image: true, backdrop: true, logo: false, imageTags: { primary: '1791799951', backdrop: '1791799951' } });
    await expect(e.ms.item(u, item(424242))).rejects.toMatchObject({ status: 404 });
    await expect(e.ms.item(u, 'a'.repeat(32))).rejects.toMatchObject({ status: 404 });
  });

  it('seasons, episodes, next / first episode', async () => {
    expect(ids(await e.ms.seasons(u, item(3)))).toEqual([item(4), item(8)]);
    expect((await e.ms.episodes(u, item(3))).map((x) => [x.parentIndexNumber, x.indexNumber])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]);
    expect((await e.ms.episodes(u, item(3), item(8))).map((x) => x.id)).toEqual([item(9), item(10), item(11)]);
    expect((await e.ms.nextEpisode(u, item(3), item(7)))?.id).toBe(item(9));
    expect(await e.ms.nextEpisode(u, item(3), item(11))).toBeNull();
    expect(await e.ms.firstEpisode(u, item(3))).toEqual({ id: item(5), runtimeTicks: 600_210_000 });
    await expect(e.ms.seasons(u, item(1))).rejects.toMatchObject({ status: 404 });
    expect(await e.ms.seasonEpisodeIds(u, item(3), 2)).toEqual(new Map([[1, item(9)], [2, item(10)], [3, item(11)]]));
    expect(await e.ms.upcoming()).toEqual([]);
  });

  it('played state: series cascade, counts, isolation between identities', async () => {
    const v0 = await e.ms.userDataVersion(u);
    await e.ms.setPlayed(u, item(4), true); // season 1
    expect(await e.ms.userDataVersion(u)).not.toBe(v0);
    expect((await e.ms.item(u, item(3))).unplayedCount).toBe(3);
    expect((await e.ms.item(u, item(5))).played).toBe(true);
    expect((await e.ms.item(other, item(5))).played).toBe(false);
    await e.ms.setPlayed(u, item(3), true);
    expect((await e.ms.item(u, item(3)))).toMatchObject({ played: true, unplayedCount: 0 });
    expect((await e.ms.items(u, { filter: 'played' })).items.map((i) => i.name)).toEqual(['MAD TEST']);
    expect((await e.ms.items(u, { filter: 'unplayed' })).items.map((i) => i.name)).not.toContain('MAD TEST');
    expect(await e.ms.unplayedIds(u, 'Movie,Series')).not.toContain(item(3));
    expect(await e.ms.unplayedIds(other, 'Movie,Series')).toContain(item(3));
    await e.ms.setPlayed(u, item(3), false);
    expect((await e.ms.item(u, item(3)))).toMatchObject({ played: false, unplayedCount: 6 });
  });

  it('favourites + the favorites filter', async () => {
    await e.ms.setFavorite(u, item(lib.beta!), true);
    expect((await e.ms.item(u, item(lib.beta!))).favorite).toBe(true);
    expect((await e.ms.items(u, { filter: 'favorites' })).items.map((i) => i.name)).toEqual(['Beta Comedy']);
    expect((await e.ms.items(other, { filter: 'favorites' })).items).toEqual([]);
    await e.ms.setFavorite(u, item(lib.beta!), false);
    expect((await e.ms.items(u, { filter: 'favorites' })).items).toEqual([]);
  });

  it('progress reports: resume window, played at 90 %, history, resume list, next up, last watched', async () => {
    const r = (itemId: string, event: 'start' | 'progress' | 'stop', positionTicks: number) =>
      e.ms.report(u, { event, itemId, mediaSourceId: 'm', playSessionId: 'ps-1', positionTicks, paused: false });
    await r(item(1), 'start', 0);
    await r(item(1), 'progress', 200_000_000); // 20 s of 60 s
    expect((await e.ms.item(u, item(1))).positionTicks).toBe(200_000_000);
    expect(ids(await e.ms.resume(u))).toEqual([item(1)]);
    await r(item(2), 'stop', 10_000_000); // < 5 %: no resume point
    expect((await e.ms.item(u, item(2))).positionTicks).toBe(0);
    await r(item(5), 'stop', 590_000_000); // >= 90 %: played
    expect((await e.ms.item(u, item(5)))).toMatchObject({ played: true, positionTicks: 0 });
    expect(ids(await e.ms.nextUp(u))).toEqual([item(6)]);
    expect(ids(await e.ms.nextUp(u, item(3)))).toEqual([item(6)]);
    expect(await e.ms.nextUp(other)).toEqual([]);
    await e.ms.setPlayed(u, item(4), true);
    expect(ids(await e.ms.nextUp(u))).toEqual([item(9)]);
    const hist = await e.ms.history(u);
    expect(hist.map((i) => i.id)).toContain(item(1));
    expect(hist.map((i) => i.id)).toContain(item(5));
    expect(hist.every((i) => i.type === 'Movie' || i.type === 'Episode')).toBe(true);
    expect((await e.ms.lastWatched(u))?.id).toBe(item(3)); // an episode maps to its series
    await e.ms.setUserData(u, item(lib.gamma!), { positionTicks: 123, played: false, lastPlayedDate: '2026-01-01T00:00:00Z' });
    expect((await e.ms.item(u, item(lib.gamma!)))).toMatchObject({ positionTicks: 123, lastPlayedDate: '2026-01-01T00:00:00.000Z' });
  });

  it('similar (shared genres / cast, same type), genres, studios, facets, collections', async () => {
    expect((await e.ms.similar(u, item(lib.alpha!))).map((i) => i.name)).toEqual(['Gamma Horror']);
    expect((await e.ms.similar(u, item(lib.beta!))).map((i) => i.name)).toEqual(['Gamma Horror']); // shared actor
    expect((await e.ms.similar(u, item(9))).map((i) => i.type)).toEqual([]); // episode -> its series: no other series
    expect(await e.ms.genres(u)).toEqual(['Comedy', 'Crime', 'Horror', 'Mini-Series', 'Suspense', 'Thriller']);
    expect(await e.ms.genres(u, 'Movie')).toEqual(['Comedy', 'Horror', 'Thriller']);
    expect(await e.ms.studios(u)).toEqual(['Night Studio', 'Sun Pictures']);
    expect(await e.ms.facets(u, 'genre')).toContainEqual({ name: 'Horror', count: 3 });
    expect((await e.ms.collections(u)).map((c) => c.name)).toEqual(['Both Movies']);
  });

  it('people, person, search; tracks; extras vs trailers; traits; segments from markers', async () => {
    const people = keep(await e.ms.people(u, item(3)));
    expect(people[0]).toEqual({ id: tag(10), name: 'Teo Brandvik', role: 'Sam', type: 'Actor', image: false });
    expect((await e.ms.people(u, item(5))).length).toBe(7); // episodes fall back to the series cast
    expect(await e.ms.person(u, tag(10))).toEqual({ id: tag(10), name: 'Teo Brandvik', image: false });
    expect(await e.ms.person(u, item(3))).toBeNull();
    expect((await e.ms.searchPeople(u, 'jane')).map((p) => p.name)).toEqual(['Jane Doe']);
    const tracks = await e.ms.tracks(u, item(1));
    expect(tracks).toEqual({
      audio: [{ language: 'eng', title: 'English (AAC Mono)', isDefault: true }, { language: 'jpn', title: '日本語 (AAC Mono)', isDefault: false }],
      subtitles: [{ language: 'eng', title: 'English' }], runtimeTicks: 600_210_000, type: 'Movie',
    });
    expect((await e.ms.trailers(u, item(1))).map((t) => t.name)).toEqual(['Test Movie One (2020)']);
    expect(await e.ms.trailer(u, item(1))).toMatch(/^9f1e0/);
    expect(await e.ms.extras(u, item(1))).toEqual([]);
    expect(await e.ms.itemTraits(u, item(3))).toEqual({ genres: ['Mini-Series', 'Horror', 'Crime', 'Suspense', 'Thriller'], tags: ['Anime'], countries: ['Japan'] });
    expect(await e.ms.itemTraits(u, item(1))).toBeNull(); // series only, like Jellyfin
    expect(await e.ms.segments(u, item(5))).toEqual([{ type: 'intro', start: 1, end: 31 }, { type: 'outro', start: 50, end: 60 }]);
    expect(await e.ms.segments(u, item(6))).toEqual([]);
  });

  it('capabilities follow the library: markers -> intro/outro, BIF index -> trickplay; never upcoming / search / Plan B', async () => {
    expect(publicCapabilities(e.ms.capabilities)).toEqual({
      segments: ['intro', 'outro'], trickplay: true, upcoming: false, subtitleSearch: false, webhooks: false, changeFeed: true, planB: false, subtitleExtract: true,
      chapters: false, // no chapter marks in this library (see depth.test.ts)
      playbackPrefetch: false, // POST /api/playback/info starts the Plex transcode
    });
    delete e.fake.items.get('5')!.Marker;
    e.fake.touch(5);
    await e.ms.sync.run();
    expect(publicCapabilities(e.ms.capabilities).segments).toEqual([]);
  });

  it('admin-key lookups: findByTmdb, seriesHasEpisode, libraryStreams, added / premiering / continuing', async () => {
    expect(await e.ms.findByTmdb(4242, 'movie')).toEqual({ id: item(lib.alpha!), name: 'Alpha Horror' });
    expect(await e.ms.findByTmdb(4242, 'tv')).toBeNull();
    expect(await e.ms.findByTmdb(-1, 'movie')).toBeNull();
    expect(await e.ms.seriesHasEpisode(item(3))).toBe(true);
    expect(await e.ms.seriesHasEpisode(item(1))).toBe(false);
    const movies = await e.ms.libraryStreams('Movie', 0, 2);
    expect(movies[0]).toEqual({ id: item(1), audio: ['eng', 'jpn'], subtitles: ['eng', 'eng'] });
    const eps = await e.ms.libraryStreams('Episode', 0, 100);
    expect(eps.length).toBe(6);
    expect(eps[0]!.seriesId).toBe(item(3));
    expect((await e.ms.addedItems(u, { start: 0, limit: 3 }))[0]!.name).toBe('Alpha Horror');
    expect((await e.ms.premieringEpisodes(u, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).length).toBe(0); // fixture episodes carry no air date
    expect(await e.ms.continuingSeries(u)).toEqual([]);
    expect(await e.ms.searchSubtitles()).toEqual([]);
    await expect(e.ms.downloadSubtitle()).rejects.toMatchObject({ status: 501 });
  });

  it('credentials: no Plex token in mediaAuth, Plan B refused, playback 501 until the playback module is plugged in', async () => {
    const cred = await e.ms.mediaAuth(u);
    expect(cred).toEqual({ token: u.jellyfin_user_id, deviceId: `ff-${u.id}` });
    expect(JSON.stringify(cred)).not.toContain(PLEX_TOKEN);
    expect(() => e.ms.planBAuthHeader()).toThrow(/Plan B/);
    await expect(e.ms.playbackInfo(u, item(1), { maxBitrate: 1 })).rejects.toMatchObject({ status: 501 });
    expect((await e.ms.playMeta(u, item(1)))?.positionTicks).toBeGreaterThanOrEqual(0);
    expect(await e.ms.playMeta(u, item(424242))).toBeNull();
    await expect(e.ms.stopEncoding(u, 'x')).resolves.toBeUndefined();
    expect((await e.ms.subtitleStream(u, item(1), 'm', 3, 'vtt')).status).toBe(501);
  });

  it('admin: libraries = Plex sections, ping, no external sessions', async () => {
    expect(await e.ms.admin.libraries()).toEqual([{ id: section(1), name: 'Movies' }, { id: section(2), name: 'TV' }]);
    expect(await e.ms.admin.ping()).toBe(true);
    expect(await e.ms.admin.externalSessions()).toEqual([]);
    await e.ms.admin.deleteIdentity('does-not-exist'); // unknown counts as removed
  });

  it('every request to Plex carries the token in the X-Plex-Token header, never in the URL', () => {
    expect(e.fake.calls.length).toBeGreaterThan(5);
    for (const c of e.fake.calls) {
      expect(c.search).not.toContain(PLEX_TOKEN);
      if (c.path !== '/identity') expect(c.token).toBe(PLEX_TOKEN);
      expect(c.headers['X-Plex-Product']).toBe('FriendFlix');
    }
  });
});
