// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toTrickplayDto } from '../src/jellyfin/dto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), SER = 'c'.repeat(32);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let lastInfoQuery = '';
let itemsQuery = '';

const TRICK = { ms1: { '160': { Width: 160, Height: 90, TileWidth: 10, TileHeight: 10, ThumbnailCount: 300, Interval: 10000, Bandwidth: 1 }, '320': { Width: 320, Height: 180, TileWidth: 8, TileHeight: 8, ThumbnailCount: 300, Interval: 10000, Bandwidth: 1 } } };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: A, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } } }),
    'GET /Items/[^/]+/Similar': () => ({ json: { Items: [{ Id: B, Name: 'Ähnlich', Type: 'Movie' }, { Id: A, Name: 'Selbst', Type: 'Movie' }] } }),
    'GET /Items/[^/]+': () => ({ json: { Id: SER, Name: 'Serie', Type: 'Series' } }),
    'GET /Items': (u) => {
      itemsQuery = u.search;
      if (u.search.includes('fields=Trickplay')) return { json: { Items: [{ Id: A, Trickplay: TRICK }] } };
      if (u.search.includes('DatePlayed')) return { json: { Items: [{ Id: 'e'.repeat(32), Name: 'Folge', Type: 'Episode', SeriesId: SER }] } };
      return { json: { Items: [] } };
    },
    'POST /Items/[^/]+/PlaybackInfo': (u) => { lastInfoQuery = u.search; return { json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: 'ms1', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 6_000_000, MediaStreams: [] }] } }; },
  });
  s = await env.login();
});
afterAll(() => env.close());
const call = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });

describe('playback quality', () => {
  it('lets the viewer lower the bitrate (forces HLS when the source is bigger) but never exceed the role limit', async () => {
    const full = (await call('POST', '/api/playback/info', { itemId: A })).json();
    expect(full.maxBitrate).toBe(60_000_000); // admin role
    expect(full.roleMaxBitrate).toBe(60_000_000);
    expect(full.directUrl).toBeTruthy();

    const low = (await call('POST', '/api/playback/info', { itemId: A, maxBitrate: 2_000_000 })).json();
    expect(low.maxBitrate).toBe(2_000_000);
    expect(low.hlsUrl).toContain('MaxStreamingBitrate=2000000');
    expect(low.directUrl).toBeUndefined(); // 6 Mbit/s source > 2 Mbit/s cap -> transcode
    expect(lastInfoQuery).toContain('MaxStreamingBitrate=2000000');

    await env.pool.query("update users set role='guest'"); // guest limit: 8 Mbit/s
    const capped = (await call('POST', '/api/playback/info', { itemId: A, maxBitrate: 150_000_000 })).json();
    expect(capped.maxBitrate).toBe(8_000_000);
    await env.pool.query("update users set role='admin'");
  });
  it('rejects absurd values', async () => {
    expect((await call('POST', '/api/playback/info', { itemId: A, maxBitrate: 10 })).statusCode).toBe(400);
  });
});

describe('trickplay thumbnails', () => {
  it('maps the resolution closest to 320 px and builds sheet URLs through the gateway path', async () => {
    const t = (await call('POST', '/api/playback/info', { itemId: A })).json().trickplay;
    expect(t).toMatchObject({ width: 320, height: 180, tileWidth: 8, tileHeight: 8, count: 300, interval: 10000 });
    expect(t.url).toBe(`/media/Videos/${A}/Trickplay/320/{n}.jpg?MediaSourceId=ms1`);
  });
  it('is undefined for missing or broken data', () => {
    expect(toTrickplayDto(A, 'ms1', undefined)).toBeUndefined();
    expect(toTrickplayDto(A, 'ms1', { ms1: {} })).toBeUndefined();
    expect(toTrickplayDto(A, 'ms1', { ms1: { '320': { Width: 320 } } })).toBeUndefined();
    expect(toTrickplayDto(A, 'other', TRICK)?.width).toBe(320); // falls back to the first media source
  });
});

describe('similar titles and "Weil du ... gesehen hast"', () => {
  it('returns Jellyfin similar items', async () => {
    expect((await call('GET', `/api/items/${A}/similar`)).json().items.map((i: any) => i.name)).toEqual(['Ähnlich', 'Selbst']);
  });
  it('seeds from the last finished item, maps episodes to their series and removes the seed from the list', async () => {
    const r = (await call('GET', '/api/library/because')).json();
    expect(itemsQuery).toContain('sortBy=DatePlayed');
    expect(r.because).toEqual({ id: SER, name: 'Serie', liked: false });
    expect(r.items.length).toBeGreaterThan(0);
  });
});

describe('viewing preferences', () => {
  it('has safe defaults, validates and persists per user', async () => {
    expect((await call('GET', '/api/prefs')).json().prefs).toEqual({ autoplayNext: true, autoSkipIntro: false, shareHistory: false, shareRatings: true, hoverTrailers: true, hoverClip: true, autoStartPreview: true, audioLang: '', subtitleLang: '', quality: 0, stillWatching: true, stillWatchingEpisodes: 3, subtitleStyle: { size: 'm', color: 'white', background: 'semi', font: 'sans' }, spoilerProtection: false, animeOriginal: false, weeklyDigest: true, ntfyTopic: '', calm: false, audioFx: 'off', language: '' });
    const put = await call('PUT', '/api/prefs', { autoplayNext: false, autoSkipIntro: true, audioLang: 'ger', subtitleLang: 'eng', quality: 4_000_000, animeOriginal: true });
    expect(put.statusCode).toBe(200);
    expect((await call('GET', '/api/prefs')).json().prefs).toMatchObject({ autoplayNext: false, autoSkipIntro: true, audioLang: 'ger', subtitleLang: 'eng', quality: 4_000_000, animeOriginal: true });
    expect((await call('PUT', '/api/prefs', { animeOriginal: 'yes' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/prefs', { audioLang: 'german!' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/prefs', { quality: -5 })).statusCode).toBe(400);
  });
  it('parses older stored prefs (without the newer fields) to defaults', async () => {
    await env.pool.query("update profile_prefs set data = '{\"autoplayNext\":false,\"subtitleStyle\":{\"size\":\"xl\"}}'");
    expect((await call('GET', '/api/prefs')).json().prefs).toMatchObject({ autoplayNext: false, stillWatching: true, stillWatchingEpisodes: 3, spoilerProtection: false, animeOriginal: false, subtitleStyle: { size: 'xl', color: 'white', background: 'semi', font: 'sans' } });
  });
  it('requires CSRF and a session', async () => {
    expect((await env.app.inject({ method: 'PUT', url: '/api/prefs', cookies: s.cookies, payload: {} })).statusCode).toBe(403);
    expect((await env.app.inject({ url: '/api/prefs' })).statusCode).toBe(401);
  });
});
