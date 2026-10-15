// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fork: the cover wall of the in-app login on Plex (MediaAdmin.loginArtIds / posterThumb, backend/src/plex/loginart.ts). The
 * allow-list (LOGIN_ART_RATINGS) is checked exactly and case-sensitively against Plex's own contentRating spellings, unrated
 * items never come back, posters go through the photo transcoder at 200 px with the token in the header only, capped at 2 MB,
 * and the public JSON names no item id, rating key, Plex host or token.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_ART_COUNT, LOGIN_ART_RATINGS, LOGIN_ART_WIDTH } from '../../src/loginArt.js';
import { encodePlexId, plexKey } from '../../src/plex/ids.js';
import { POSTER_MAX_BYTES, plexArtAllowed, plexArtSpelling } from '../../src/plex/loginart.js';
import { makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';
import { plexEnv, type PlexEnv } from './setup.js';

const ALLOW = new Set(LOGIN_ART_RATINGS);

describe('Plex contentRating -> cover-wall allow-list', () => {
  it('plain values are compared as they are, country-prefixed ones as <CC>-<value>, us/<value> as the plain US value', () => {
    expect(['TV-PG', 'PG', 'de/12', 'gb/12A', 'gb/U', 'us/PG', 'us/TV-Y7', 'de/FSK 12', ''].map(plexArtSpelling))
      .toEqual(['TV-PG', 'PG', 'DE-12', 'GB-12A', 'GB-U', 'PG', 'TV-Y7', 'DE-FSK 12', null]);
    expect(plexArtSpelling(null)).toBeNull();
    expect(plexArtSpelling(undefined)).toBeNull();
  });

  it('keeps the Plex spellings that are on the allow-list and mean 12 or younger', () => {
    const kept = ['G', 'PG', 'TV-G', 'TV-PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', '0', '6', '12', '12A', 'FSK 12', 'FSK-6',
      'de/0', 'de/6', 'de/12', 'gb/U', 'gb/PG', 'gb/12', 'gb/12A', 'us/G', 'us/PG', 'us/TV-PG'];
    for (const r of kept) expect(plexArtAllowed(r, ALLOW), r).toBe(true);
  });

  it('drops unrated, higher, unknown, other-country and differently-cased values (fail closed)', () => {
    const dropped = [null, undefined, '', 'NR', 'Not Rated', 'Unrated', 'PG-13', 'TV-14', 'TV-MA', 'R', '16', 'FSK 16',
      'de/16', 'de/18', 'gb/15', 'us/PG-13', 'us/R', 'fr/12', 'at/6', 'au/PG', 'nl/AL', 'ca/G', 'de/FSK 12',
      'pg', 'tv-pg', 'Tv-Pg', 'fsk 12', 'gb/u', 'gb/12a', 'DE/12', 'de/12 ', ' PG',
      // on the allow-list as written, but the fork's age map cannot place it without a country: dropped
      'U', 'DE-12', 'GB-U'];
    for (const r of dropped) expect(plexArtAllowed(r as string | null | undefined, ALLOW), String(r)).toBe(false);
  });

  it('a value outside the given allow-list is dropped even when its age would pass', () => {
    expect(plexArtAllowed('PG', new Set(['G']))).toBe(false);
    expect(plexArtAllowed('G', new Set(['G']))).toBe(true);
  });
});

describe('Plex MediaAdmin.loginArtIds / posterThumb', () => {
  let e: PlexEnv;
  const lib: Record<string, string> = {};
  beforeAll(async () => {
    e = await plexEnv((f) => {
      lib.de12 = f.addMovie({ title: 'Twelve', rating: 'de/12' });
      lib.gbU = f.addMovie({ title: 'Universal', rating: 'gb/U' });
      lib.pg = f.addMovie({ title: 'Parental', rating: 'PG' });
      lib.de16 = f.addMovie({ title: 'Sixteen', rating: 'de/16' });
      lib.pg13 = f.addMovie({ title: 'Teen', rating: 'PG-13' });
      lib.lower = f.addMovie({ title: 'Lower', rating: 'pg' });
      lib.unrated = f.addMovie({ title: 'Home Video' });
      lib.nr = f.addMovie({ title: 'Not rated', rating: 'NR' });
      const show = f.addShow({ title: 'Kids Show', rating: 'TV-Y7', episodes: 2, episodeRating: 'TV-Y7' });
      lib.show = show.show;
      lib.ep = show.episodes[0]!;
      lib.adult = f.addShow({ title: 'Adult Show', rating: 'TV-MA', episodes: 1 }).show;
    });
  }, 60_000);
  afterAll(() => e.close());
  afterEach(() => { e.fake.photo = {}; });

  /** every movie / show of the mirror whose own rating passes (the fixtures bring their own, e.g. TV-PG shows) */
  const expected = async () => (await e.pool.query<{ rating_key: string; content_rating: string | null }>(
    `select rating_key, content_rating from plex_items where type in ('movie', 'show') and thumb is not null`)).rows
    .filter((r) => plexArtAllowed(r.content_rating, ALLOW)).map((r) => encodePlexId('item', String(r.rating_key))).sort();

  it('returns only movies and shows whose own Plex rating is on the allow-list; unrated, NR, higher and mis-cased are never among them', async () => {
    const want = await expected();
    const got = await e.ms.admin.loginArtIds!({ ratings: LOGIN_ART_RATINGS, limit: 500 });
    expect([...got].sort()).toEqual(want);
    for (const k of ['de12', 'gbU', 'pg', 'show']) expect(got, k).toContain(encodePlexId('item', lib[k]!));
    for (const k of ['de16', 'pg13', 'lower', 'unrated', 'nr', 'adult', 'ep']) expect(got, k).not.toContain(encodePlexId('item', lib[k]!));
    for (const id of got) expect(id).toMatch(/^9f1e0[0-9a-f]{27}$/);
  });

  it('honours the limit and the allow-list it is given; an empty allow-list or limit gives nothing; no Plex request is made', async () => {
    const before = e.fake.calls.length;
    expect(await e.ms.admin.loginArtIds!({ ratings: LOGIN_ART_RATINGS, limit: 2 })).toHaveLength(2);
    expect(await e.ms.admin.loginArtIds!({ ratings: ['GB-U'], limit: 10 })).toEqual([encodePlexId('item', lib.gbU!)]);
    expect(await e.ms.admin.loginArtIds!({ ratings: [], limit: 10 })).toEqual([]);
    expect(await e.ms.admin.loginArtIds!({ ratings: LOGIN_ART_RATINGS, limit: 0 })).toEqual([]);
    expect(e.fake.calls.length).toBe(before); // from the mirror only
  });

  it('a rating changed in Plex counts after the next sync (de/12 -> de/16 leaves the wall, and back)', async () => {
    const id = encodePlexId('item', lib.de12!);
    e.fake.setRating(lib.de12!, 'de/16');
    await e.ms.sync.run();
    expect(await e.ms.admin.loginArtIds!({ ratings: LOGIN_ART_RATINGS, limit: 500 })).not.toContain(id);
    e.fake.setRating(lib.de12!, 'de/12');
    await e.ms.sync.run();
    expect(await e.ms.admin.loginArtIds!({ ratings: LOGIN_ART_RATINGS, limit: 500 })).toContain(id);
  });

  it('posterThumb: the photo transcoder at the asked width with the token in the header only, never in the URL', async () => {
    const id = encodePlexId('item', lib.gbU!);
    const before = e.fake.calls.length;
    const img = await e.ms.admin.posterThumb!(id, LOGIN_ART_WIDTH);
    expect(img).toEqual({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), type: 'image/jpeg' });
    const calls = e.fake.calls.slice(before);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.path).toBe('/photo/:/transcode');
    const q = new URLSearchParams(c.search);
    expect(q.get('url')).toMatch(new RegExp(`^/library/metadata/${lib.gbU}/thumb(/\\d+)?$`));
    expect([q.get('width'), q.get('upscale')]).toEqual(['200', '0']);
    expect(c.token).toBe(PLEX_TOKEN);
    expect(c.search).not.toContain(PLEX_TOKEN);
    expect(c.search.toLowerCase()).not.toContain('x-plex-token');
  });

  it('posterThumb refuses what is no poster: unknown or foreign ids, non-images, error answers, more than 2 MB', async () => {
    const id = encodePlexId('item', lib.pg!);
    expect(await e.ms.admin.posterThumb!('0'.repeat(32), 200)).toBeNull(); // a Jellyfin-shaped id
    expect(await e.ms.admin.posterThumb!(encodePlexId('tag', 1), 200)).toBeNull();
    expect(await e.ms.admin.posterThumb!(encodePlexId('item', 999999), 200)).toBeNull();
    expect(await e.ms.admin.posterThumb!(encodePlexId('item', lib.ep!), 200)).toBeNull(); // episodes are not on the wall
    e.fake.photo = { type: 'text/html', bytes: new TextEncoder().encode('<html>') };
    expect(await e.ms.admin.posterThumb!(id, 200)).toBeNull();
    e.fake.photo = { status: 500 };
    expect(await e.ms.admin.posterThumb!(id, 200)).toBeNull();
    e.fake.photo = { type: 'image/png' };
    expect(await e.ms.admin.posterThumb!(id, 200)).toBeNull();
    e.fake.photo = { type: 'image/webp' };
    expect((await e.ms.admin.posterThumb!(id, 200))?.type).toBe('image/webp');
    // too big: announced, and (without a usable content-length) found while reading
    e.fake.photo = { length: String(POSTER_MAX_BYTES + 1) };
    expect(await e.ms.admin.posterThumb!(id, 200)).toBeNull();
    e.fake.photo = { bytes: new Uint8Array(POSTER_MAX_BYTES + 1) };
    expect(await e.ms.admin.posterThumb!(id, 200)).toBeNull();
    e.fake.photo = { bytes: new Uint8Array(POSTER_MAX_BYTES) };
    expect((await e.ms.admin.posterThumb!(id, 200))?.bytes.length).toBe(POSTER_MAX_BYTES);
  });

  it('posterThumb only ever asks the transcoder for the mirror\'s own poster path of that item', async () => {
    await e.pool.query("update plex_items set thumb='/library/metadata/1/thumb/1?X-Plex-Token=x' where rating_key=$1", [lib.pg]);
    expect(await e.ms.admin.posterThumb!(encodePlexId('item', lib.pg!), 200)).toBeNull();
    await e.pool.query("update plex_items set thumb='http://elsewhere.example.com/x.jpg' where rating_key=$1", [lib.pg]);
    expect(await e.ms.admin.posterThumb!(encodePlexId('item', lib.pg!), 200)).toBeNull();
    await e.pool.query('update plex_items set thumb=null where rating_key=$1', [lib.pg]);
    expect(await e.ms.admin.posterThumb!(encodePlexId('item', lib.pg!), 200)).toBeNull();
    // and an item without a poster is not a candidate either
    expect(await e.ms.admin.loginArtIds!({ ratings: LOGIN_ART_RATINGS, limit: 500 })).not.toContain(encodePlexId('item', lib.pg!));
  });
});

describe('the public cover wall on Plex (/api/public/login-art)', () => {
  let env: TestEnv;
  const fake = new PlexFake();
  const keys = [fake.addMovie({ title: 'Wall A', rating: 'de/12' }), fake.addMovie({ title: 'Wall B', rating: 'gb/PG' }), fake.addMovie({ title: 'Wall C', rating: 'G' })];
  const hidden = [fake.addMovie({ title: 'Not on the wall', rating: 'de/16' }), fake.addMovie({ title: 'Unrated' })];
  beforeAll(async () => { env = await makeEnv({}, { server: 'plex', plexFake: fake }); }, 60_000);
  afterAll(() => env.close());

  it('lists same-origin paths only: no item ids, rating keys, titles, Plex host or token in the JSON or headers', async () => {
    const r = await env.app.inject('/api/public/login-art');
    expect(r.statusCode).toBe(200);
    const images = r.json().images as string[];
    expect(images.length).toBeGreaterThanOrEqual(keys.length);
    expect(images.length).toBeLessThanOrEqual(LOGIN_ART_COUNT);
    for (const p of images) expect(p).toMatch(/^\/api\/public\/login-art\/[A-Za-z0-9_-]{12}\/\d{1,2}$/);
    const text = r.body + JSON.stringify(r.headers);
    const ids = (await env.pool.query<{ rating_key: string }>('select rating_key from plex_items')).rows.map((x) => String(x.rating_key));
    for (const k of ids) expect(text).not.toContain(encodePlexId('item', k));
    for (const bad of [PLEX_TOKEN, PLEX_URL, 'plex.test', '32400', 'X-Plex-Token', '/library/', '/photo/', '9f1e', 'Wall A', 'de/12']) expect(text).not.toContain(bad);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('serves the transcoded poster bytes; the image answer carries no token or Plex address', async () => {
    const list = (await env.app.inject('/api/public/login-art')).json().images as string[];
    const img = await env.app.inject(list[0]!);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const text = img.rawPayload.toString('latin1') + JSON.stringify(img.headers);
    for (const bad of [PLEX_TOKEN, PLEX_URL, 'plex.test', 'X-Plex-Token']) expect(text).not.toContain(bad);
    // every poster fetched came from an allowed item, through the transcoder at 200 px
    const fetched = fake.calls.filter((c) => c.path === '/photo/:/transcode');
    expect(fetched.length).toBe(list.length);
    for (const c of fetched) {
      const q = new URLSearchParams(c.search);
      expect(q.get('width')).toBe('200');
      const rk = /^\/library\/metadata\/(\d+)\/thumb/.exec(q.get('url') ?? '')![1]!;
      expect(hidden).not.toContain(rk);
      const rating = (await env.pool.query<{ content_rating: string }>('select content_rating from plex_items where rating_key=$1', [rk])).rows[0]!.content_rating;
      expect(plexArtAllowed(rating, ALLOW), rating).toBe(true);
      expect(plexKey(encodePlexId('item', rk))).toBe(rk);
    }
  });
});
