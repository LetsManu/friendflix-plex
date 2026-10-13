import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { JellyfinError } from '../src/jellyfin/client.js';
import { JellyfinService } from '../src/jellyfin/service.js';
import { createMediaServer, MEDIA_SERVERS, mediaConfigProblems } from '../src/media/index.js';
import { toPlaybackDto } from '../src/jellyfin/dto.js';
import { MediaError, publicCapabilities, type MediaCapabilities } from '../src/media/types.js';
import { MemoryKV } from '../src/kv.js';
import { wrap } from '../src/routes/_shared.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';
import { keyFromBase64 } from '../src/crypto.js';

const BASE = {
  PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://a.example.com',
  OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', SEERR_URL: 'http://s', SEERR_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20),
};

describe('MEDIA_SERVER config', () => {
  // only what this repository guarantees: a fork registers further kinds without touching this test
  it('defaults to jellyfin and accepts jellyfin', () => {
    expect(loadConfig(BASE).MEDIA_SERVER).toBe('jellyfin');
    expect(loadConfig({ ...BASE, MEDIA_SERVER: 'jellyfin' }).MEDIA_SERVER).toBe('jellyfin');
    expect(MEDIA_SERVERS).toContain('jellyfin');
  });
  it('rejects unknown kinds (no silent fallback on a typo)', () => {
    for (const v of ['not-a-server', 'Jellyfin', ' jellyfin', '__proto__']) expect(() => loadConfig({ ...BASE, MEDIA_SERVER: v })).toThrow();
  });
  it('jellyfin still requires JELLYFIN_URL and a non-empty admin key', () => {
    const { JELLYFIN_URL: _u, ...noUrl } = BASE;
    expect(() => loadConfig(noUrl)).toThrow(/JELLYFIN_URL/);
    expect(() => loadConfig({ ...BASE, JELLYFIN_ADMIN_API_KEY: '' })).toThrow(/JELLYFIN_ADMIN_API_KEY/);
    // compose passes unset variables as '' (`${JELLYFIN_URL:-}`): same clear "required" message, not a URL parse error
    expect(() => loadConfig({ ...BASE, JELLYFIN_URL: '' })).toThrow(/JELLYFIN_URL is required for MEDIA_SERVER=jellyfin/);
    expect(() => loadConfig({ ...BASE, JELLYFIN_URL: 'not a url' })).toThrow();
  });
  it('jellyfin has no unsupported settings', () => {
    expect(mediaConfigProblems(loadConfig({ ...BASE, DOWNLOADS_ENABLED: 'false' }))).toEqual([]);
  });
});

describe('createMediaServer factory', () => {
  // the shared pool is handed to every implementation; Jellyfin ignores it (any use would throw here)
  const unused = () => { throw new Error('Jellyfin must not use the shared pool'); };
  const db = { query: unused, connect: unused } as unknown as pg.Pool;
  it('builds the Jellyfin implementation against JELLYFIN_URL with the admin key', async () => {
    const calls: Call[] = [];
    const ms = createMediaServer({ cfg: { ...cfg, JELLYFIN_URL: 'http://jf.test:8096' }, kv: new MemoryKV(), db, encKey: keyFromBase64(ENC_KEY), fetchImpl: fakeHttp({ 'GET /System/Ping': () => ({ json: 'ok' }), 'GET /Library/MediaFolders': () => ({ json: { Items: [{ Id: 'f1', Name: 'Filme' }] } }) }, calls) });
    expect(ms).toBeInstanceOf(JellyfinService);
    expect(ms.kind).toBe('jellyfin');
    expect(await ms.admin.ping()).toBe(true);
    expect(await ms.admin.libraries()).toEqual([{ id: 'f1', name: 'Filme' }]);
    expect(calls.at(-1)).toMatchObject({ path: '/Library/MediaFolders', auth: expect.stringContaining('Token="adminkey"') });
  });
  it('refuses an unknown kind even if config validation was bypassed', () => {
    expect(() => createMediaServer({ cfg: { ...cfg, MEDIA_SERVER: 'not-a-server' as never }, kv: new MemoryKV(), db, encKey: keyFromBase64(ENC_KEY) })).toThrow(/unknown MEDIA_SERVER/);
  });
});

describe('MediaError mapping', () => {
  class OtherServerError extends MediaError {}
  const reply = () => {
    const r = { code: 0, body: undefined as unknown, codeFn(c: number) { r.code = c; return r; }, send(b: unknown) { r.body = b; return r; } };
    return { r, api: { code: (c: number) => r.codeFn(c), send: (b: unknown) => r.send(b) } };
  };
  const run = async (e: Error, o: Parameters<typeof wrap>[1] = {}) => {
    const { r, api } = reply();
    await wrap(async (_req: unknown, _reply: unknown) => { throw e; }, o)({}, api);
    return { code: r.code, body: r.body };
  };
  it('JellyfinError is a MediaError', () => {
    const e = new JellyfinError(404, 'x');
    expect(e).toBeInstanceOf(MediaError);
    expect(e.status).toBe(404);
  });
  it('any implementation\'s MediaError maps like a Jellyfin one: notFound -> 404, passthrough, else 502', async () => {
    for (const E of [JellyfinError, OtherServerError, MediaError]) {
      expect(await run(new E(403, 'x'), { notFound: [403, 404] })).toEqual({ code: 404, body: { error: 'not_found', status: 403 } });
      expect(await run(new E(429, 'x'), { passthrough: [429] })).toEqual({ code: 429, body: { error: 'jellyfin', status: 429 } });
      expect(await run(new E(500, 'x'))).toEqual({ code: 502, body: { error: 'jellyfin', status: 500 } });
    }
  });
  it('jellyfin: false and non-media errors are rethrown', async () => {
    await expect(run(new OtherServerError(404, 'x'), { jellyfin: false })).rejects.toBeInstanceOf(OtherServerError);
    await expect(run(new Error('boom'))).rejects.toThrow('boom');
  });
});

describe('capabilities exposure', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());

  const ALL = { segments: ['intro', 'outro', 'recap', 'preview'], trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false, chapters: true, playbackPrefetch: true };

  it('Jellyfin reports everything supported in /api/me and /api/server', async () => {
    const s = await env.login();
    const me = (await env.app.inject({ url: '/api/me', cookies: s.cookies })).json();
    expect(me.server).toEqual({ kind: 'jellyfin', capabilities: ALL });
    const srv = await env.app.inject({ url: '/api/server', cookies: s.cookies });
    expect(srv.statusCode).toBe(200);
    expect(srv.json()).toEqual({ kind: 'jellyfin', capabilities: ALL });
  });
  it('/api/server needs a session', async () => {
    expect((await env.app.inject({ url: '/api/server' })).statusCode).toBe(401);
  });
  it('whatever the implementation reports is what the client gets (sets become ordered arrays)', async () => {
    const caps: MediaCapabilities = { segments: new Set(['outro', 'intro']), trickplay: true, upcoming: false, subtitleSearch: false, webhooks: false, changeFeed: true, planB: false, subtitleExtract: true, chapters: false };
    expect(publicCapabilities(caps)).toEqual({ segments: ['intro', 'outro'], trickplay: true, upcoming: false, subtitleSearch: false, webhooks: false, changeFeed: true, planB: false, subtitleExtract: true, chapters: false, playbackPrefetch: true });
    const prev = env.ctx.jf.capabilities;
    (env.ctx.jf as { capabilities: MediaCapabilities }).capabilities = caps;
    try {
      const s = await env.login();
      expect((await env.app.inject({ url: '/api/me', cookies: s.cookies })).json().server.capabilities).toMatchObject({ segments: ['intro', 'outro'], upcoming: false, subtitleSearch: false });
    } finally {
      (env.ctx.jf as { capabilities: MediaCapabilities }).capabilities = prev;
    }
  });
  it('an implementation that predates `chapters` (optional flag) reports it as unsupported, and the chapters route says so', async () => {
    const { chapters: _c, ...old }: MediaCapabilities = { segments: new Set(), trickplay: false, upcoming: false, subtitleSearch: false, webhooks: false, changeFeed: false, planB: false, subtitleExtract: false, chapters: true };
    const legacy: MediaCapabilities = old; // compiles without the field
    expect(publicCapabilities(legacy)).toMatchObject({ chapters: false, playbackPrefetch: true }); // Block 20: absent = prefetch allowed
    const prev = env.ctx.jf.capabilities;
    (env.ctx.jf as { capabilities: MediaCapabilities }).capabilities = { ...prev, chapters: undefined };
    try {
      const s = await env.login();
      expect((await env.app.inject({ url: '/api/me', cookies: s.cookies })).json().server.capabilities.chapters).toBe(false);
    } finally {
      (env.ctx.jf as { capabilities: MediaCapabilities }).capabilities = prev;
    }
  });
});

describe('repository hygiene', () => {
  const repo = new URL('../../', import.meta.url).pathname;
  it('.gitignore never ignores source directories named media/ (only the bundled library folder at the root)', () => {
    const rules = readFileSync(join(repo, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    expect(rules).not.toContain('media/');
    expect(rules).not.toContain('media');
    expect(rules).toContain('/media/');
  });
  it('git does not ignore the seam sources (when git is available)', async () => {
    const { spawnSync } = await import('node:child_process');
    for (const f of ['backend/src/media/types.ts', 'backend/src/media/index.ts', 'backend/src/media/events.ts', 'gateway/src/upstream/index.ts']) {
      const r = spawnSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: repo });
      if (r.error || r.status === 128) return; // no git / not a checkout (e.g. a Docker build context): the .gitignore check above still runs
      expect(r.status, `${f} is git-ignored`).toBe(1); // 1 = not ignored
    }
  });
});

describe('seam boundary', () => {
  it('only jellyfin/* and the media factory import the Jellyfin implementation', () => {
    const root = new URL('../src/', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(root);
    const offenders = files
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith('jellyfin/') && f !== 'media/index.ts')
      .filter((f) => /from '[./]*\/?jellyfin\//.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('transcodeReason on the playback DTO', () => {
  const mk = (src: Record<string, unknown> = {}, extra: Partial<Parameters<typeof toPlaybackDto>[0]> = {}) => toPlaybackDto({
    itemId: 'a'.repeat(32), deviceId: 'd', maxBitrate: 20_000_000, resumeTicks: 0,
    info: { PlaySessionId: 'ps', MediaSources: [{ Id: 'ms', Container: 'mkv', SupportsDirectPlay: false, Bitrate: 2_000_000, MediaStreams: [{ Type: 'Video', Height: 720 }], ...src }] },
    ...extra,
  });
  const tu = (reasons: string) => ({ TranscodingUrl: `/videos/x/master.m3u8?TranscodeReasons=${reasons}` });
  it('maps Jellyfin TranscodeReasons', () => {
    expect(mk(tu('ContainerNotSupported')).transcodeReason).toBe('container');
    expect(mk(tu('AudioCodecNotSupported')).transcodeReason).toBe('audioCodec');
    expect(mk(tu('AudioChannelsNotSupported')).transcodeReason).toBe('audioCodec');
    expect(mk(tu('VideoCodecNotSupported,AudioCodecNotSupported')).transcodeReason).toBe('videoCodec');
    expect(mk(tu('SubtitleCodecNotSupported')).transcodeReason).toBe('subtitles');
    expect(mk(tu('VideoResolutionNotSupported')).transcodeReason).toBe('height');
    expect(mk(tu('SomethingNew')).transcodeReason).toBe('other');
  });
  it('direct play has no reason', () => {
    expect(mk({ Container: 'mp4', SupportsDirectPlay: true }).transcodeReason).toBeUndefined();
  });
  it('a codec reason beats the cap reason; a cap reason beats Jellyfin\'s bitrate reasons', () => {
    expect(mk({ ...tu('ContainerNotSupported'), Bitrate: 9_000_000 }, { maxBitrate: 4_000_000, capReason: 'remoteCap' }).transcodeReason).toBe('container');
    expect(mk({ ...tu('ContainerBitrateExceedsLimit'), Bitrate: 9_000_000 }, { maxBitrate: 4_000_000, capReason: 'roleCap' }).transcodeReason).toBe('roleCap');
    expect(mk(tu('VideoBitrateNotSupported')).transcodeReason).toBe('network');
    expect(mk({ Container: 'mp4', SupportsDirectPlay: true, Bitrate: 9_000_000 }, { maxBitrate: 4_000_000, capReason: 'manual' }).transcodeReason).toBe('manual');
  });
  it('an explicit audio track is audioTrack', () => {
    expect(mk({ Container: 'mp4', SupportsDirectPlay: true }, { audioIndex: 2 }).transcodeReason).toBe('audioTrack');
  });
  it('a cap below the source outranks the audio track (a remote limit must not read as "audio track")', () => {
    expect(mk({ Container: 'mp4', SupportsDirectPlay: true, Bitrate: 9_000_000 }, { audioIndex: 2, maxBitrate: 4_000_000, capReason: 'remoteCap' }).transcodeReason).toBe('remoteCap');
    expect(mk({ Container: 'mp4', SupportsDirectPlay: true, Bitrate: 2_000_000 }, { audioIndex: 2, maxBitrate: 4_000_000, capReason: 'remoteCap' }).transcodeReason).toBe('audioTrack');
  });
});

describe('explicit video/audio bitrate on the transcode URL', () => {
  const q = (maxBitrate: number, maxHeight?: number) => new URL(toPlaybackDto({
    itemId: 'a'.repeat(32), deviceId: 'd', maxBitrate, resumeTicks: 0, maxHeight,
    info: { PlaySessionId: 'ps', MediaSources: [{ Id: 'ms', Container: 'mkv', Bitrate: 60_000_000, MediaStreams: [{ Type: 'Video', Height: 2160, Codec: 'hevc' }, { Type: 'Audio', Codec: 'truehd', Channels: 8, Bitrate: 6_000_000 }] }] },
  }).hlsUrl, 'http://x').searchParams;
  it('2160p HEVC + TrueHD 7.1 at 4 Mbit/s: video keeps the budget minus a 192 kbit/s stereo audio track', () => {
    const p = q(4_000_000);
    expect([p.get('VideoBitrate'), p.get('AudioBitrate'), p.get('AudioChannels'), p.get('MaxHeight'), p.get('MaxWidth')]).toEqual(['3808000', '192000', '2', '720', '1280']);
  });
  it('rung by cap, floor 300 kbit/s, never above the role height', () => {
    expect([q(20_000_000).get('MaxHeight'), q(8_000_000).get('MaxHeight'), q(1_500_000).get('MaxHeight'), q(800_000).get('MaxHeight')]).toEqual(['1080', '1080', '480', '360']);
    expect(q(800_000).get('VideoBitrate')).toBe('608000');
    expect(q(400_000).get('VideoBitrate')).toBe('300000');
    expect([q(20_000_000, 480).get('MaxHeight'), q(20_000_000, 480).get('MaxWidth')]).toEqual(['480', '854']);
  });
});
