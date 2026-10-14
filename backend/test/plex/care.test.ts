// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 22 on Plex (fork): active sessions (`/status/sessions`), library hygiene (`/library/sections/<id>/all?includeGuids=1`,
 * `updatedAt>>=`) and the metadata refresh (`PUT /library/metadata/<rk>/refresh`) of PlexMediaServer, and the admin routes on top
 * of them with MEDIA_SERVER=plex. The sessions fixture is hand-written in PMS's JSON shape (incl. paths and IP addresses that must
 * never reach a DTO).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hygieneTick } from '../../src/hygiene/scan.js';
import { MediaError } from '../../src/media/types.js';
import { resetStreamsMemoForTests } from '../../src/playstats.js';
import { plexSessionReasons, plexHygieneSource, toPlexHygieneFacts, toPlexServerSession, updatedSince } from '../../src/plex/care.js';
import { sessionIdentities } from '../../src/plex/limits.js';
import { MemoryKV } from '../../src/kv.js';
import { ADMIN, makeEnv, type TestEnv } from '../helpers.js';
import { fixture, PLEX_TOKEN, PlexFake } from '../plexfake.js';
import { item, plexEnv, type PlexEnv } from './setup.js';

const FF_SESSION = '0123456789abcdef-0123456789abcdef01234567';
const sessions = (): Array<Record<string, any>> => fixture('status_sessions').MediaContainer.Metadata;
/** nothing a client must never see: file paths, IP addresses, transcode URLs, the token */
const noLeak = (o: unknown) => {
  const s = JSON.stringify(o);
  for (const bad of ['/media/', '172.18.', '192.168.', '203.0.113', '/transcode/', PLEX_TOKEN, 'plex.tv']) expect(s).not.toContain(bad);
};

// ---------------------------------------------------------------- pure mappers

describe('toPlexServerSession', () => {
  it('a FriendFlix transcode: ff- device, play session id, identity, hardware, codecs of the output, position', () => {
    const s = toPlexServerSession(sessions()[0]!, (x) => (x === FF_SESSION ? 'ident-1' : undefined));
    expect(s).toEqual({
      sessionId: 's-ff-1', serverUserId: 'ident-1', deviceId: `ff-${FF_SESSION}`,
      item: { id: item(1), name: 'Test Movie One', type: 'Movie' }, playSessionId: FF_SESSION,
      playMethod: 'Transcode', reasons: ['other'], videoCodec: 'h264', audioCodec: 'aac', hardware: true, bitrate: 4_000_000, progressPct: 50, paused: false,
    });
    noLeak(s);
  });

  it('another Plex app: client + player name, Plex account, burnt subtitles, paused, no hardware', () => {
    const s = toPlexServerSession(sessions()[1]!);
    expect(s).toMatchObject({
      sessionId: 's-web-1', serverUserId: 'plex-account-7', deviceId: 'plexweb-firefox-1', client: 'Plex Web', deviceName: 'Firefox',
      item: { id: item(5), name: 'Episode 1', seriesName: 'MAD TEST', type: 'Episode' },
      playMethod: 'Transcode', reasons: ['subtitles', 'other'], hardware: false, paused: true, progressPct: 10,
    });
    expect(s!.playSessionId).toBeUndefined();
    noLeak(s);
  });

  it('direct play (no TranscodeSession): codecs of the file, no reasons, no hardware flag', () => {
    const s = toPlexServerSession(sessions()[2]!);
    expect(s).toMatchObject({ playMethod: 'DirectPlay', reasons: [], videoCodec: 'hevc', audioCodec: 'aac', client: 'Plex for LG', deviceName: 'Living room TV', progressPct: 0, paused: false });
    expect(s!.hardware).toBeUndefined();
    noLeak(s);
  });

  it('an entry without a ratingKey is skipped; copy/copy is DirectStream', () => {
    expect(toPlexServerSession(sessions()[3]!)).toBeNull();
    expect(toPlexServerSession({})).toBeNull();
    const s = toPlexServerSession({ ...sessions()[1]!, TranscodeSession: { key: '/transcode/sessions/x', videoDecision: 'copy', audioDecision: 'copy' } });
    expect(s).toMatchObject({ playMethod: 'DirectStream', reasons: [] });
  });

  it('a session with a FriendFlix-shaped id but another product and no known identity is foreign', () => {
    const raw = { ...sessions()[0]!, Player: { ...sessions()[0]!.Player, product: 'Plex Web' } };
    const s = toPlexServerSession(raw);
    expect(s!.deviceId).toBe(FF_SESSION);
    expect(s!.playSessionId).toBeUndefined();
    expect(s!.client).toBe('Plex Web');
  });
});

describe('plexSessionReasons', () => {
  it('derives reasons from the decisions', () => {
    expect(plexSessionReasons(undefined)).toEqual([]);
    expect(plexSessionReasons({ videoDecision: 'copy', audioDecision: 'transcode' })).toEqual(['audioCodec']);
    expect(plexSessionReasons({ videoDecision: 'transcode', audioDecision: 'transcode' })).toEqual(['other']);
    expect(plexSessionReasons({ videoDecision: 'copy', audioDecision: 'copy', subtitleDecision: 'burn' })).toEqual(['subtitles']);
    expect(plexSessionReasons({ videoDecision: 'directstream', audioDecision: 'copy' })).toEqual([]);
  });
});

describe('hygiene mappers', () => {
  const listing = fixture('movies_all').MediaContainer.Metadata[0];
  const epDetail = fixture('ep_detail').MediaContainer.Metadata[0];

  it('a listing entry without detail: Media facts, no streams (= not probed), no path', () => {
    const f = toPlexHygieneFacts(listing, 'Movie');
    expect(f).toMatchObject({ id: item(1), type: 'Movie', name: 'Test Movie One', year: 2020, overview: false, poster: true, backdrop: true, providerIds: {}, runtimeTicks: 600_210_000, virtual: false });
    expect(f.sources).toEqual([{ container: 'mkv', bitrate: 1_902_000, sizeBytes: 14268835, runtimeTicks: 600_210_000, video: [], audio: [], subtitles: [] }]);
    noLeak(f);
  });

  it('detail media: streams with language, forced, text, bit depth, HDR', () => {
    const f = toPlexHygieneFacts({ ...epDetail, Guid: [{ id: 'tvdb://1' }, { id: 'imdb://tt0133093' }] }, 'Episode', epDetail.Media);
    expect(f).toMatchObject({ id: item(5), type: 'Episode', seriesId: item(3), seriesName: 'MAD TEST', season: 1, episode: 1, providerIds: { tvdb: '1', imdb: 'tt0133093' } });
    const s = f.sources[0]!;
    expect(s.video).toEqual([{ codec: 'h264', bitDepth: 8, height: 360 }]);
    expect(s.audio.map((a) => a.lang)).toEqual(['eng', 'jpn']);
    expect(s.subtitles[0]).toEqual({ codec: 'srt', lang: 'eng', forced: false, text: true });
    noLeak(f);
    const hdr = plexHygieneSource({ Part: [{ Stream: [{ streamType: 1, codec: 'hevc', bitDepth: 10, colorTrc: 'smpte2084' }, { streamType: 3, codec: 'pgs', languageCode: 'ger', forced: 1 }] }] });
    expect(hdr.video[0]).toEqual({ codec: 'hevc', bitDepth: 10, hdr: true });
    expect(hdr.subtitles[0]).toEqual({ codec: 'pgs', lang: 'ger', forced: true, text: false });
    expect(plexHygieneSource({ Part: [{ Stream: [{ streamType: 1, codec: 'h264', colorTrc: 'bt709' }] }] }).video[0]!.hdr).toBe(false);
  });

  it('a series has no sources; year falls back to originallyAvailableAt', () => {
    const f = toPlexHygieneFacts({ ratingKey: '3', type: 'show', title: 'S', originallyAvailableAt: '2019-05-01', Media: [{ Part: [] }] }, 'Series');
    expect(f).toMatchObject({ year: 2019, sources: [], poster: false, backdrop: false });
    expect(f.seriesId).toBeUndefined();
  });

  it('updatedSince: Plex filter in epoch seconds, nothing for a bad date', () => {
    expect(updatedSince('2026-01-01T00:00:10.900Z')).toBe('&updatedAt%3E%3E=1767225610');
    expect(updatedSince(undefined)).toBe('');
    expect(updatedSince('nope')).toBe('');
  });
});

describe('sessionIdentities', () => {
  it('reads the limit bookkeeping (started + reported sessions); malformed keys are skipped', async () => {
    const kv = new MemoryKV();
    await kv.set(`plexstarted:ident-a:${FF_SESSION}`, '1', 60);
    await kv.set('plexplay:ident-b:fedcba9876543210-fedcba9876543210fedcba98', '2', 60);
    await kv.set('plexplay:ident-c:not-a-session', '3', 60);
    expect(await sessionIdentities(kv)).toEqual(new Map([[FF_SESSION, 'ident-a'], ['fedcba9876543210-fedcba9876543210fedcba98', 'ident-b']]));
  });
});

// ---------------------------------------------------------------- PlexMediaServer against the fake

describe('PlexMediaServer Block 22', () => {
  let e: PlexEnv | null = null;
  afterEach(async () => {
    await e?.close();
    e = null;
  });

  it('transcodeSessions: /status/sessions with the token header only; FriendFlix session tied to its identity', async () => {
    e = await plexEnv();
    await e.kv.set(`plexstarted:ident-x:${FF_SESSION}`, item(1), 60);
    e.fake.calls = [];
    const list = await e.ms.admin.transcodeSessions!();
    expect(list.map((s) => [s.item.name, s.playMethod, s.serverUserId])).toEqual([
      ['Test Movie One', 'Transcode', 'ident-x'], ['Episode 1', 'Transcode', 'plex-account-7'], ['Test Movie Two', 'DirectPlay', 'plex-account-1'],
    ]);
    expect(e.fake.calls.map((c) => [c.method, c.path, c.token])).toEqual([['GET', '/status/sessions', PLEX_TOKEN]]);
    expect(e.fake.calls[0]!.search).not.toContain(PLEX_TOKEN);
    noLeak(list);
  });

  it('transcodeSessions: Plex down -> rejects (the admin view then shows only what FriendFlix knows)', async () => {
    e = await plexEnv();
    e.fake.fail = { re: /^\/status\/sessions$/, status: 500 };
    await expect(e.ms.admin.transcodeSessions!()).rejects.toMatchObject({ status: 500 });
  });

  it('libraryHygiene: films, series and episodes with streams from the mirror', async () => {
    e = await plexEnv();
    const movies = await e.ms.libraryHygiene('Movie', { start: 0, limit: 200 });
    expect(movies.map((m) => m.name)).toEqual(['Test Movie One', 'Test Movie Two']);
    expect(movies[0]!.sources[0]!.audio.map((a) => a.lang)).toEqual(['eng', 'jpn']); // mirror detail
    const series = await e.ms.libraryHygiene('Series', { start: 0, limit: 200 });
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ type: 'Series', name: 'MAD TEST', sources: [], providerIds: { tvdb: '370160' } });
    const eps = await e.ms.libraryHygiene('Episode', { start: 0, limit: 200 });
    expect(eps.every((x) => x.type === 'Episode' && x.seriesId === item(3))).toBe(true);
    expect(eps.find((x) => x.id === item(5))!.sources[0]!.subtitles).toHaveLength(2);
    noLeak([movies, series, eps]);
    const lists = e.fake.calls.filter((c) => c.path.endsWith('/all'));
    expect(lists.every((c) => new URLSearchParams(c.search).get('includeGuids') === '1' && c.token === PLEX_TOKEN && !c.search.includes(PLEX_TOKEN))).toBe(true);
  });

  it('libraryHygiene: one page window across two movie sections, a short page = the end', async () => {
    e = await plexEnv((f) => {
      const sid = f.addSection('Kino 2', 'movie');
      f.addMovie({ title: 'Zweite A', sectionId: sid });
      f.addMovie({ title: 'Zweite B', sectionId: sid });
    });
    const page = (start: number, limit: number) => e!.ms.libraryHygiene('Movie', { start, limit }).then((r) => r.map((m) => m.name));
    expect(await page(0, 3)).toEqual(['Test Movie One', 'Test Movie Two', 'Zweite A']);
    expect(await page(1, 2)).toEqual(['Test Movie Two', 'Zweite A']);
    expect(await page(3, 3)).toEqual(['Zweite B']);
    expect(await page(4, 3)).toEqual([]);
  });

  it('libraryHygiene: savedSince -> updatedAt>>= (only items changed at or after it)', async () => {
    e = await plexEnv();
    const since = new Date(1791799952 * 1000).toISOString(); // movie 1: 1791799951, movie 2: 1791799952
    const r = await e.ms.libraryHygiene('Movie', { start: 0, limit: 200, savedSince: since });
    expect(r.map((m) => m.name)).toEqual(['Test Movie Two']);
    expect(e.fake.calls.at(-1)!.search).toContain('updatedAt%3E%3E=1791799952');
  });

  it('libraryHygiene: a listing without totalSize is an error, not a silent empty page', async () => {
    e = await plexEnv();
    const c = e.ms.client;
    const orig = c.container.bind(c);
    c.container = async (p: string) => {
      const r = await orig(p);
      if (p.includes('/all?')) delete r.totalSize;
      return r;
    };
    await expect(e.ms.libraryHygiene('Movie', { start: 0, limit: 10 })).rejects.toMatchObject({ status: 502 });
  });

  it('refreshMetadata: PUT /library/metadata/<rk>/refresh, marks the mirror row stale; 404 for unknown / non-Plex ids', async () => {
    e = await plexEnv();
    await e.ms.refreshMetadata(item(1));
    expect(e.fake.refreshed).toEqual(['1']);
    const put = e.fake.calls.find((c) => c.method === 'PUT')!;
    expect([put.path, put.token, put.search.includes(PLEX_TOKEN)]).toEqual(['/library/metadata/1/refresh', PLEX_TOKEN, false]);
    expect((await e.pool.query('select detail_at from plex_items where rating_key = 1')).rows[0].detail_at).toBeNull();
    await expect(e.ms.refreshMetadata(item(999))).rejects.toMatchObject({ status: 404 });
    await expect(e.ms.refreshMetadata('a'.repeat(32))).rejects.toBeInstanceOf(MediaError);
    e.fake.fail = { re: /\/refresh$/, status: 500 };
    const err = await e.ms.refreshMetadata(item(2)).catch((x) => x);
    expect(err).toMatchObject({ status: 502 });
    expect(String(err.message)).not.toContain(PLEX_TOKEN);
  });
});

// ---------------------------------------------------------------- behind the admin routes (MEDIA_SERVER=plex)

describe('Block 22 admin routes on Plex', () => {
  type Sess = { cookies: Record<string, string>; csrf: string };
  let env: TestEnv;
  let admin: Sess;
  const fake = new PlexFake();
  const as = (method: string, url: string, payload?: unknown) =>
    env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: payload as object });

  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake });
    admin = await env.login(ADMIN);
  });
  afterAll(() => env.close());

  it('hygiene: supported, a full scan stores the Plex items, refresh reaches Plex', async () => {
    await hygieneTick(env.ctx, { full: true, pauseMs: 0 });
    const sum = (await as('GET', '/api/admin/hygiene/summary')).json();
    expect(sum).toMatchObject({ canRefresh: true, state: { supported: true, running: false } });
    expect(sum.state.lastFull).toBeTruthy();
    const ids = (await env.pool.query<{ item_id: string; type: string }>('select item_id, type from hygiene_items order by item_id')).rows;
    const count = (t: string) => ids.filter((r) => r.type === t).length;
    expect([count('Movie'), count('Series'), count('Episode')]).toEqual([2, 1, [...fake.items.values()].filter((m) => m.type === 'episode').length]);
    const list = await as('GET', '/api/admin/hygiene');
    expect(list.statusCode, list.body).toBe(200);
    noLeak(list.json());
    // both films have no summary and no provider ids in the fixtures
    const r = await as('POST', `/api/admin/hygiene/${item(1)}/refresh`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.refreshed).toContain('1');
    expect((await as('POST', `/api/admin/hygiene/${item(999)}/refresh`, {})).statusCode).toBe(404);
  });

  it('streams: details from /status/sessions; other apps listed, the unmatched FriendFlix session is not', async () => {
    resetStreamsMemoForTests();
    const r = await as('GET', '/api/admin/streams');
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    expect(v.details).toBe(true);
    expect(v.streams.map((s: { title: string; source: string; method: string; reason: string | null }) => [s.title, s.source, s.method, s.reason])).toEqual([
      ['Episode 1', 'app', 'transcode', 'subtitles'], ['Test Movie Two', 'app', 'direct', null],
    ]);
    noLeak(v);
  });
});
