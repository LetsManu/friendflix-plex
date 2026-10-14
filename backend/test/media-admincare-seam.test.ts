// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapTranscodeReasons } from '../src/jellyfin/dto.js';
import { MediaError } from '../src/media/types.js';
import { makeEnv, type TestEnv } from './helpers.js';

/** Block 22 T2: optional seam methods transcodeSessions / libraryHygiene / refreshMetadata (Jellyfin). */
const id = (c: string) => c.repeat(32);
const M1 = id('a'), M2 = id('b'), S1 = id('c'), E1 = id('d'), ITEM = id('e'), FOREIGN = id('f');
const TOKEN = 'secret-session-token-123';

const sessions = [
  { // FriendFlix device, transcoding with hardware
    Id: 'sess1', UserId: id('1'), DeviceId: 'ff-dev123', Client: 'FriendFlix', DeviceName: 'Portal', AccessToken: TOKEN,
    NowPlayingItem: { Id: ITEM, Name: 'Ashfall', Type: 'Movie', RunTimeTicks: 1000, Path: '/mnt/media/ashfall.mkv' },
    PlayState: { PlayMethod: 'Transcode', PositionTicks: 250, IsPaused: false, PlaySessionId: 'ps-1' },
    TranscodingInfo: { VideoCodec: 'h264', AudioCodec: 'aac', HardwareAccelerationType: 'vaapi', Bitrate: 8_000_000, CompletionPercentage: 40, TranscodeReasons: ['VideoCodecNotSupported', 'SomethingNew'], Url: 'http://jellyfin:8096/videos/x/master.m3u8?api_key=zzz', Path: '/config/transcodes/abc.ts' },
  },
  { // other app, direct play, paused
    Id: 'sess2', UserId: id('2'), DeviceId: 'infuse-xyz', Client: 'Infuse', DeviceName: 'Apple TV',
    NowPlayingItem: { Id: FOREIGN, Name: 'Pilot', SeriesName: 'Show', Type: 'Episode', RunTimeTicks: 2000 },
    PlayState: { PlayMethod: 'DirectPlay', PositionTicks: 1000, IsPaused: true },
  },
  { // idle session: not playing anything
    Id: 'sess3', UserId: id('3'), DeviceId: 'web', Client: 'Jellyfin Web', DeviceName: 'Chrome', PlayState: {},
  },
  { // transcode with "none" hardware and a comma separated reason string (older servers)
    Id: 'sess4', UserId: id('4'), DeviceId: 'ff-dev456', Client: 'FriendFlix', DeviceName: 'Portal',
    NowPlayingItem: { Id: M1, Name: 'Other', Type: 'Movie' },
    PlayState: { PlayMethod: 'Transcode', IsPaused: false },
    TranscodingInfo: { VideoCodec: 'h264', HardwareAccelerationType: 'none', TranscodeReasons: 'ContainerBitrateExceedsLimit,AudioCodecNotSupported' },
  },
];

const stream = (o: Record<string, unknown>) => ({ Index: 0, IsExternal: false, DeliveryUrl: 'http://jellyfin:8096/sub.vtt?api_key=zzz', Path: '/mnt/media/subs.srt', ...o });
const items: Record<string, any[]> = {
  Movie: [
    {
      Id: M1, Name: 'Ashfall', Type: 'Movie', Overview: 'A film.', ProductionYear: 2001, ProviderIds: { Tmdb: '603', Imdb: 'tt0133093' },
      ImageTags: { Primary: 'p1' }, BackdropImageTags: ['b1'], RunTimeTicks: 72_000_000_000, LocationType: 'FileSystem', Path: '/mnt/media/x.mkv',
      MediaSources: [{
        Id: 'ms1', Path: '/mnt/media/x.mkv', Protocol: 'File', Container: 'mkv', Bitrate: 45_000_000, Size: 40_000_000_000, RunTimeTicks: 72_000_000_000,
        MediaStreams: [
          stream({ Type: 'Video', Codec: 'hevc', BitDepth: 10, Height: 2160, VideoRange: 'HDR' }),
          stream({ Type: 'Audio', Codec: 'dts', Language: 'eng', Channels: 6 }),
          stream({ Type: 'Subtitle', Codec: 'PGSSUB', Language: 'ger', IsForced: false, IsTextSubtitleStream: false }),
          stream({ Type: 'Subtitle', Codec: 'subrip', Language: 'deu', IsForced: true, IsTextSubtitleStream: true }),
          stream({ Type: 'EmbeddedImage', Codec: 'mjpeg' }),
        ],
      }],
    },
    { Id: M2, Name: 'Bare', Type: 'Movie', PremiereDate: '1999-03-31T00:00:00Z', LocationType: 'Virtual', ImageTags: {}, BackdropImageTags: [] },
  ],
  Series: [{ Id: S1, Name: 'Show', Type: 'Series', Overview: '', ProductionYear: 2010, ImageTags: { Primary: 'p' }, BackdropImageTags: [], ProviderIds: {} }],
  Episode: [{
    Id: E1, Name: 'Pilot', Type: 'Episode', SeriesId: S1, SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2, RunTimeTicks: 0,
    MediaSources: [{ Container: 'mp4', MediaStreams: [stream({ Type: 'Video', Codec: 'h264', BitDepth: 8, Height: 1080, VideoRange: 'SDR' })] }],
  }],
};

let env: TestEnv;
const refreshed: string[] = [];
beforeAll(async () => {
  env = await makeEnv({
    'GET /Sessions': () => ({ json: sessions }),
    'GET /Items': (u) => {
      const type = u.searchParams.get('includeItemTypes') ?? '';
      const start = Number(u.searchParams.get('startIndex') ?? 0), limit = Number(u.searchParams.get('limit') ?? 100);
      return { json: { Items: (items[type] ?? []).slice(start, start + limit) } };
    },
    'POST /Items/[0-9a-f]+/Refresh': (u) => {
      const iid = u.pathname.split('/')[2]!;
      if (iid === id('0')) return { status: 404 };
      refreshed.push(iid);
      return { status: 204 };
    },
  });
});
afterAll(() => env.close());

describe('transcodeSessions', () => {
  it('maps PlayMethod, reasons (VideoCodecNotSupported → videoCodec, unknown → other), codecs, hardware, progress; includes ff- devices', async () => {
    const list = await env.ctx.jf.admin.transcodeSessions!();
    expect(list.map((s) => s.sessionId)).toEqual(['sess1', 'sess2', 'sess4']); // idle session left out
    expect(list[0]).toEqual({
      sessionId: 'sess1', serverUserId: id('1'), deviceId: 'ff-dev123', client: 'FriendFlix', deviceName: 'Portal',
      item: { id: ITEM, name: 'Ashfall', type: 'Movie' }, playSessionId: 'ps-1',
      playMethod: 'Transcode', reasons: ['videoCodec', 'other'], videoCodec: 'h264', audioCodec: 'aac', hardware: true,
      bitrate: 8_000_000, progressPct: 25, paused: false,
    });
    expect(list[1]).toMatchObject({ playMethod: 'DirectPlay', reasons: [], paused: true, progressPct: 50, client: 'Infuse', item: { id: FOREIGN, name: 'Pilot', seriesName: 'Show', type: 'Episode' } });
    expect(list[1]!.hardware).toBeUndefined();
    expect(list[2]).toMatchObject({ playMethod: 'Transcode', reasons: ['network', 'audioCodec'], hardware: false });
    const call = env.jfCalls.find((c) => c.path === '/Sessions')!;
    expect(call.search).toContain('activeWithinSeconds=30');
  });

  it('the DTO never contains the access token, a URL or a path', async () => {
    const json = JSON.stringify(await env.ctx.jf.admin.transcodeSessions!());
    for (const bad of [TOKEN, 'http://', 'api_key', '/mnt/media', '/config/transcodes']) expect(json).not.toContain(bad);
  });

  it('mapTranscodeReasons dedupes and maps bitrate reasons to network', () => {
    expect(mapTranscodeReasons(['ContainerNotSupported', 'ContainerBitrateExceedsLimit', 'VideoBitrateNotSupported', 'Foo', 'Bar'])).toEqual(['container', 'network', 'other']);
    expect(mapTranscodeReasons([])).toEqual([]);
  });
});

describe('libraryHygiene', () => {
  it('maps overview / poster / backdrop / year / providerIds / virtual and per-source streams (forced, text, bitDepth, hdr)', async () => {
    const movies = await env.ctx.jf.libraryHygiene!('Movie', { start: 0, limit: 200 });
    expect(movies[0]).toEqual({
      id: M1, type: 'Movie', name: 'Ashfall', year: 2001, overview: true, poster: true, backdrop: true, providerIds: { tmdb: '603', imdb: 'tt0133093' },
      runtimeTicks: 72_000_000_000, virtual: false,
      sources: [{
        container: 'mkv', bitrate: 45_000_000, sizeBytes: 40_000_000_000, runtimeTicks: 72_000_000_000,
        video: [{ codec: 'hevc', bitDepth: 10, height: 2160, hdr: true }],
        audio: [{ codec: 'dts', lang: 'eng', channels: 6 }],
        subtitles: [{ codec: 'pgssub', lang: 'ger', forced: false, text: false }, { codec: 'subrip', lang: 'deu', forced: true, text: true }],
      }],
    });
    expect(movies[1]).toMatchObject({ id: M2, year: 1999, overview: false, poster: false, backdrop: false, virtual: true, sources: [], providerIds: {} });
    const [series] = await env.ctx.jf.libraryHygiene!('Series', { start: 0, limit: 200 });
    expect(series).toMatchObject({ id: S1, type: 'Series', overview: false, poster: true, backdrop: false, sources: [] });
    const [ep] = await env.ctx.jf.libraryHygiene!('Episode', { start: 0, limit: 200 });
    expect(ep).toMatchObject({ id: E1, type: 'Episode', seriesId: S1, seriesName: 'Show', season: 1, episode: 2, runtimeTicks: 0 });
    expect(ep!.sources[0]!.video).toEqual([{ codec: 'h264', bitDepth: 8, height: 1080, hdr: false }]);
  });

  it('passes minDateLastSaved only when savedSince is set; sortBy SortName,Id; paging', async () => {
    env.jfCalls.length = 0;
    await env.ctx.jf.libraryHygiene!('Movie', { start: 200, limit: 200 });
    await env.ctx.jf.libraryHygiene!('Episode', { start: 0, limit: 50, savedSince: '2026-10-13T10:00:00.000Z' });
    const [a, b] = env.jfCalls.filter((c) => c.path === '/Items').map((c) => new URLSearchParams(c.search));
    expect(a!.get('minDateLastSaved')).toBeNull();
    expect(a!.get('sortBy')).toBe('SortName,Id');
    expect(a!.get('startIndex')).toBe('200');
    expect(a!.get('limit')).toBe('200');
    expect(a!.get('includeItemTypes')).toBe('Movie');
    expect(a!.get('fields')).toContain('MediaSources');
    expect(a!.get('userId')).toBeNull(); // admin key, library-wide
    expect(b!.get('minDateLastSaved')).toBe('2026-10-13T10:00:00.000Z');
  });

  it('the DTO has no Path, URL or protocol', async () => {
    const json = JSON.stringify([...(await env.ctx.jf.libraryHygiene!('Movie', { start: 0, limit: 200 })), ...(await env.ctx.jf.libraryHygiene!('Episode', { start: 0, limit: 200 }))]);
    for (const bad of ['/mnt/media', 'http://', 'api_key', 'Path', 'path', 'File']) expect(json).not.toContain(bad);
  });
});

describe('refreshMetadata', () => {
  it('posts to /Items/<id>/Refresh with the admin key; 404 → MediaError(404)', async () => {
    env.jfCalls.length = 0;
    await env.ctx.jf.refreshMetadata!(M1);
    expect(refreshed).toEqual([M1]);
    const call = env.jfCalls.find((c) => c.path === `/Items/${M1}/Refresh`)!;
    expect(call.method).toBe('POST');
    const q = new URLSearchParams(call.search);
    expect(q.get('metadataRefreshMode')).toBe('FullRefresh');
    expect(q.get('imageRefreshMode')).toBe('FullRefresh');
    expect(q.get('replaceAllMetadata')).toBe('false');
    expect(q.get('replaceAllImages')).toBe('false');
    expect(call.auth).toContain('Token="adminkey"');
    const err = await env.ctx.jf.refreshMetadata!(id('0')).catch((e) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).status).toBe(404);
  });
});
