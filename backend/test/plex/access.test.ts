// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaUser } from '../../src/media/types.js';
import { ratingAge, resolveAccess, UNKNOWN_AGE } from '../../src/plex/access.js';
import { DEFAULT_ROLES } from '../../src/roles.js';
import { identity, ids, item, kids, plexEnv, section, tag, type PlexEnv } from './setup.js';

describe('contentRating -> age map', () => {
  it('US film + TV ratings', () => {
    expect([ratingAge('G'), ratingAge('PG'), ratingAge('PG-13'), ratingAge('R'), ratingAge('NC-17')]).toEqual([0, 10, 13, 17, 18]);
    expect([ratingAge('TV-Y'), ratingAge('TV-Y7'), ratingAge('TV-G'), ratingAge('TV-PG'), ratingAge('TV-14'), ratingAge('TV-MA')]).toEqual([0, 7, 0, 10, 14, 17]);
    expect([ratingAge('us/PG-13'), ratingAge(' pg-13 '), ratingAge('tv-ma')]).toEqual([13, 13, 17]);
  });
  it('German FSK in every spelling Plex delivers', () => {
    for (const [r, a] of [['de/0', 0], ['de/6', 6], ['de/12', 12], ['de/16', 16], ['de/18', 18], ['FSK 12', 12], ['FSK-16', 16], ['de/FSK 6', 6], ['ab 12', 12], ['12', 12], ['16+', 16]] as const) {
      expect(ratingAge(r), r).toBe(a);
    }
  });
  it('other countries (gb, au, ca, fr, nl, nz)', () => {
    expect([ratingAge('gb/U'), ratingAge('gb/PG'), ratingAge('gb/12A'), ratingAge('gb/15'), ratingAge('gb/18')]).toEqual([0, 8, 12, 15, 18]);
    expect([ratingAge('au/M'), ratingAge('au/MA 15+'), ratingAge('ca/14A'), ratingAge('fr/10'), ratingAge('nl/AL'), ratingAge('nz/R16')]).toEqual([15, 15, 14, 10, 0, 16]);
  });
  it('unrated (empty, NR, Not Rated) -> null; unknown strings -> UNKNOWN (fail closed)', () => {
    for (const r of [null, undefined, '', '  ', 'NR', 'Not Rated', 'Unrated', 'us/NR']) expect(ratingAge(r), String(r)).toBeNull();
    for (const r of ['XYZ-99', 'gb/PG-13', 'Approved', 'xx/12a3', '99']) expect(ratingAge(r), r).toBe(UNKNOWN_AGE);
  });
});

describe('resolveAccess', () => {
  const secs = [{ id: 1, title: 'Movies' }, { id: 2, title: 'TV' }];
  it('no policy / disabled -> nothing at all; libraries by title (case-insensitive)', () => {
    expect(resolveAccess(null, secs, 'x').sections).toEqual([]);
    expect(resolveAccess({ identity: 'x', libraries: null, maxAge: null, blockUnrated: [], disabled: true }, secs, 'x').sections).toEqual([]);
    expect(resolveAccess({ identity: 'x', libraries: ['movies', 'Nope'], maxAge: 12, blockUnrated: ['Movie', 'Series'], disabled: false }, secs, 'x'))
      .toEqual({ identity: 'x', sections: [1], maxAge: 12, blockTypes: ['movie', 'show', 'season', 'episode'] });
  });
});

describe('Plex access control (server side, over the mirror)', () => {
  let e: PlexEnv;
  const lib: Record<string, string> = {};
  let adult: { show: string; season: string; episodes: string[] };
  let mixed: { show: string; season: string; episodes: string[] };
  let unratedShow: { show: string; season: string; episodes: string[] };
  let animeSection = 0;

  beforeAll(async () => {
    e = await plexEnv((f) => {
      lib.g = f.addMovie({ title: 'Kinderfilm', rating: 'G', genres: ['Family'], actors: [{ id: 9001, tag: 'Kid Actor' }] });
      lib.de6 = f.addMovie({ title: 'Ab Sechs', rating: 'de/6' });
      lib.de12 = f.addMovie({ title: 'Ab Zwoelf', rating: 'de/12' });
      lib.gb15 = f.addMovie({ title: 'British Fifteen', rating: 'gb/15' });
      lib.unrated = f.addMovie({ title: 'Home Video' });
      lib.nr = f.addMovie({ title: 'Not Rated Film', rating: 'NR' });
      lib.unknown = f.addMovie({ title: 'Weird Rating', rating: 'XYZ-99' });
      lib.rOnly = f.addMovie({ title: 'Hard R', rating: 'R', actors: [{ id: 9002, tag: 'Only In R' }] });
      adult = f.addShow({ title: 'Adult Show', rating: 'TV-MA', episodeRating: 'TV-PG' });
      mixed = f.addShow({ title: 'Mixed Show', rating: 'TV-Y7', episodes: 3, episodeRating: 'TV-Y7' });
      f.setRating(mixed.episodes[2]!, 'TV-14');
      unratedShow = f.addShow({ title: 'Unrated Show', episodeRating: 'TV-Y' });
      animeSection = f.addSection('Anime', 'movie');
      lib.anime = f.addMovie({ title: 'Anime Film', rating: 'PG', sectionId: animeSection });
    });
  });
  afterAll(async () => e.close());

  const movies = async (u: MediaUser) => (await e.ms.items(u, { types: 'Movie', limit: 200 })).items.map((i) => i.name).sort();
  const sees = (u: MediaUser, rk: string) => e.ms.item(u, item(rk)).then(() => true, () => false);

  it('admin (no cap, all libraries) sees everything, incl. unrated and unknown ratings', async () => {
    const u = await identity(e.ms, 'admin');
    expect(await movies(u)).toEqual(['Ab Sechs', 'Ab Zwoelf', 'Anime Film', 'British Fifteen', 'Hard R', 'Home Video', 'Kinderfilm', 'Not Rated Film', 'Test Movie One', 'Test Movie Two', 'Weird Rating']);
    expect((await e.ms.views(u)).map((v) => v.name)).toEqual(['Movies', 'TV', 'Anime']);
    for (const k of [adult.show, adult.episodes[0]!, unratedShow.show, mixed.episodes[2]!]) expect(await sees(u, k)).toBe(true);
  });

  it('guest role (cap 12): over-age, unrated, NR and unknown ratings are blocked (fail closed)', async () => {
    const u = await identity(e.ms, 'guest');
    expect(DEFAULT_ROLES.guest!.maxParentalRating).toBe(12);
    expect(await movies(u)).toEqual(['Ab Sechs', 'Ab Zwoelf', 'Anime Film', 'Kinderfilm']);
    for (const k of ['1', '2', lib.gb15!, lib.unrated!, lib.nr!, lib.unknown!, lib.rOnly!]) {
      expect(await sees(u, k), k).toBe(false);
      await expect(e.ms.item(u, item(k))).rejects.toMatchObject({ status: 404 });
    }
  });

  it('episodes and seasons inherit the show rating; an over-age episode of an allowed show stays hidden', async () => {
    const u = await identity(e.ms, 'guest');
    // TV-MA show with TV-PG episodes: show, seasons and episodes hidden everywhere
    expect(await sees(u, adult.show)).toBe(false);
    expect(await sees(u, adult.season)).toBe(false);
    for (const ep of adult.episodes) expect(await sees(u, ep)).toBe(false);
    await expect(e.ms.episodes(u, item(adult.show))).rejects.toMatchObject({ status: 404 });
    await expect(e.ms.seasons(u, item(adult.show))).rejects.toMatchObject({ status: 404 });
    const allEps = (await e.ms.items(u, { types: 'Episode', limit: 200 })).items;
    expect(allEps.some((x) => x.seriesName === 'Adult Show')).toBe(false);
    expect(await e.ms.firstEpisode(u, item(adult.show))).toBeNull();
    // TV-Y7 show: the TV-14 episode is hidden, the others are visible
    expect(ids(await e.ms.episodes(u, item(mixed.show)))).toEqual([item(mixed.episodes[0]!), item(mixed.episodes[1]!)].sort());
    expect(await sees(u, mixed.episodes[2]!)).toBe(false);
    expect((await e.ms.item(u, item(mixed.show))).unplayedCount).toBe(2); // counts only what the viewer may see
    // unrated show: blocked although its episodes carry TV-Y
    expect(await sees(u, unratedShow.show)).toBe(false);
    expect(await sees(u, unratedShow.episodes[0]!)).toBe(false);
  });

  it('kids profile (cap 6 + block unrated): only G / FSK 6 / TV-Y and below', async () => {
    const u = await identity(e.ms, 'friend', kids(6));
    expect(await movies(u)).toEqual(['Ab Sechs', 'Kinderfilm']);
    expect(await sees(u, lib.de12!)).toBe(false);
    expect(await sees(u, '3')).toBe(false); // TV-PG = 10
    expect((await e.ms.items(u, { types: 'Series' })).items).toEqual([]); // TV-Y7 = 7 > 6
    const k12 = await identity(e.ms, 'friend', kids(12));
    expect((await e.ms.items(k12, { types: 'Series' })).items.map((i) => i.name)).toEqual(['MAD TEST', 'Mixed Show']);
    // kids cap 0
    const baby = await identity(e.ms, 'friend', kids(0));
    expect(await movies(baby)).toEqual(['Kinderfilm']);
  });

  it('the kids cap never loosens a stricter role cap; trailers inherit the movie rating', async () => {
    const u = await identity(e.ms, 'guest', kids(12));
    expect(await movies(u)).toEqual(['Ab Sechs', 'Ab Zwoelf', 'Anime Film', 'Kinderfilm']);
    const admin = await identity(e.ms, 'admin');
    const trailers = await e.ms.trailers(admin, item(1));
    expect(trailers.map((t) => t.type)).toEqual(['Trailer']);
    expect(await e.ms.trailers(u, item(1))).toEqual([]);
    expect(await e.ms.trailer(u, item(1))).toBeNull();
    await expect(e.ms.item(u, trailers[0]!.id)).rejects.toMatchObject({ status: 404 });
    expect((await e.ms.item(admin, trailers[0]!.id)).type).toBe('Trailer');
  });

  it('role libraries map to Plex section titles: views, lists, parents and items outside them are invisible', async () => {
    const u = await identity(e.ms, { ...DEFAULT_ROLES.friend!, libraries: ['movies'] });
    expect((await e.ms.views(u)).map((v) => v.name)).toEqual(['Movies']);
    expect((await e.ms.items(u, { types: 'Movie,Series', limit: 200 })).items.every((i) => i.type === 'Movie')).toBe(true);
    expect(await sees(u, lib.anime!)).toBe(false);
    expect(await sees(u, '3')).toBe(false);
    expect(await sees(u, '5')).toBe(false);
    expect((await e.ms.items(u, { parentId: section(2) })).items).toEqual([]);
    expect((await e.ms.items(u, { parentId: section(animeSection) })).items).toEqual([]);
    expect((await e.ms.items(u, { parentId: section(1), limit: 200 })).total).toBe(10);
    await expect(e.ms.item(u, section(2))).rejects.toMatchObject({ status: 404 });
    expect((await e.ms.item(u, section(1))).type).toBe('CollectionFolder');
    expect(await e.ms.genres(u, 'Series')).toEqual([]);
    expect(await e.ms.searchPeople(u, 'Dario')).toEqual([]);
  });

  it('identity without a policy, a disabled identity and a deleted identity see nothing', async () => {
    const { id } = await e.ms.admin.createIdentity('nopolicy', 'x');
    const none: MediaUser = { id: 'np', jellyfin_user_id: id, jellyfin_username: 'np', jellyfin_pw_enc: '' };
    expect(await movies(none)).toEqual([]);
    expect(await e.ms.views(none)).toEqual([]);
    await expect(e.ms.item(none, item(lib.g!))).rejects.toMatchObject({ status: 404 });
    const unknownId: MediaUser = { ...none, jellyfin_user_id: 'f'.repeat(32) };
    expect(await movies(unknownId)).toEqual([]);

    const u = await identity(e.ms, 'admin');
    expect((await movies(u)).length).toBe(11);
    await e.ms.admin.setDisabled(u.jellyfin_user_id, true);
    expect(await movies(u)).toEqual([]);
    expect(await sees(u, lib.g!)).toBe(false);
    await e.ms.admin.setDisabled(u.jellyfin_user_id, false);
    expect((await movies(u)).length).toBe(11);
    // disabling an identity that never had a policy must not open everything
    const { id: id2 } = await e.ms.admin.createIdentity('fresh', 'x');
    await e.ms.admin.setDisabled(id2, false);
    expect(await movies({ ...none, jellyfin_user_id: id2 })).toEqual([]);
    await e.ms.admin.deleteIdentity(u.jellyfin_user_id);
    expect(await movies(u)).toEqual([]);
  });

  it('a policy change applies at once (no stale access memo)', async () => {
    const u = await identity(e.ms, 'admin');
    expect(await sees(u, '2')).toBe(true);
    await e.ms.admin.applyPolicy(u.jellyfin_user_id, { template: DEFAULT_ROLES.guest!, disabled: false });
    expect(await sees(u, '2')).toBe(false);
  });

  it('collections are visible only with a visible member; member counts follow the viewer', async () => {
    const admin = await identity(e.ms, 'admin');
    const guest = await identity(e.ms, 'guest');
    const teen = await identity(e.ms, { ...DEFAULT_ROLES.friend!, maxParentalRating: 13 });
    expect((await e.ms.collections(admin)).map((c) => [c.name, c.childCount])).toEqual([['Both Movies', 2]]);
    expect((await e.ms.collections(teen)).map((c) => [c.name, c.childCount])).toEqual([['Both Movies', 1]]);
    expect(await e.ms.collections(guest)).toEqual([]);
    await expect(e.ms.item(guest, item(12))).rejects.toMatchObject({ status: 404 });
    expect(ids((await e.ms.items(teen, { parentId: item(12) })).items)).toEqual([item(1)]);
    expect((await e.ms.items(guest, { parentId: item(12) })).items).toEqual([]);
  });

  it('people: a person exists for the viewer only through a visible title', async () => {
    const admin = await identity(e.ms, 'admin');
    const guest = await identity(e.ms, 'guest');
    expect(await e.ms.person(admin, tag(9002))).toMatchObject({ name: 'Only In R' });
    expect(await e.ms.person(guest, tag(9002))).toBeNull();
    await expect(e.ms.item(guest, tag(9002))).rejects.toMatchObject({ status: 404 });
    expect((await e.ms.item(admin, tag(9002))).type).toBe('Person');
    expect((await e.ms.searchPeople(guest, 'Only')).length).toBe(0);
    expect((await e.ms.searchPeople(admin, 'Only')).map((p) => p.name)).toEqual(['Only In R']);
    expect((await e.ms.items(guest, { person: tag(9002) })).items).toEqual([]);
    expect(ids((await e.ms.items(admin, { person: tag(9002) })).items)).toEqual([item(lib.rOnly!)]);
    await expect(e.ms.people(guest, item(lib.rOnly!))).rejects.toMatchObject({ status: 404 });
  });

  it('hidden items cannot be written, searched, counted or used as seeds', async () => {
    const u = await identity(e.ms, 'friend', kids(6));
    for (const fn of [
      () => e.ms.setFavorite(u, item(2), true), () => e.ms.setPlayed(u, item(2), true),
      () => e.ms.setUserData(u, item(2), { positionTicks: 1, played: false, lastPlayedDate: new Date() }),
      () => e.ms.report(u, { event: 'progress', itemId: item(2), mediaSourceId: 'x', playSessionId: 'p', positionTicks: 5, paused: false }),
      () => e.ms.similar(u, item(2)), () => e.ms.tracks(u, item(2)),
    ]) await expect(fn()).rejects.toMatchObject({ status: 404 });
    expect((await e.ms.items(u, { q: 'Hard' })).items).toEqual([]);
    expect(await e.ms.unplayedIds(u, 'Movie')).toEqual(new Set([item(lib.g!), item(lib.de6!)]));
    expect(await e.ms.availableEpisodes(u, [item(5), item(mixed.episodes[0]!)])).toEqual(new Set());
    const guest = await identity(e.ms, 'guest');
    expect(await e.ms.availableEpisodes(guest, [item(5), item(mixed.episodes[2]!), item(adult.episodes[0]!), item(1)])).toEqual(new Set([item(5)]));
    expect((await e.ms.seasonEpisodeIds(u, item(3), 1)).size).toBe(0);
    expect(await e.ms.itemTraits(u, item(3))).toBeNull();
    expect(await e.ms.segments(u, item(2))).toEqual([]);
    const facetNames = (await e.ms.facets(u, 'genre')).map((f) => f.name);
    expect(facetNames).toEqual(['Family']);
  });

  it('a rating edit in Plex (updatedAt unchanged) is picked up by the next sync', async () => {
    const guest = await identity(e.ms, 'guest');
    expect(await sees(guest, '1')).toBe(false);
    e.fake.setRating(1, 'de/12');
    await e.ms.sync.run();
    expect(await sees(guest, '1')).toBe(true);
    e.fake.setRating(1, 'PG-13');
    await e.ms.sync.run();
    expect(await sees(guest, '1')).toBe(false);
    // the show's rating flows down to its episodes on the same pass
    e.fake.setRating(adult.show, 'TV-PG');
    await e.ms.sync.run();
    expect(await sees(guest, adult.episodes[0]!)).toBe(true);
    e.fake.setRating(adult.show, 'TV-MA');
    await e.ms.sync.run();
    expect(await sees(guest, adult.episodes[0]!)).toBe(false);
  });
});
