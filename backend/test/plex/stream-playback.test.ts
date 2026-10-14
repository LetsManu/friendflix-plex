// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryKV } from '../../src/kv.js';
import { MediaError, type ItemDto, type MediaUser } from '../../src/media/types.js';
import { PlexClient } from '../../src/plex/client.js';
import { fmp4Playlist, splitFmp4, VIRTUAL_RE } from '../../src/plex/downloads.js';
import { encodePlexId } from '../../src/plex/ids.js';
import { chapterImageUrl, chSig, partSig, sessionFor, tpSig, verifyChSig, verifyPartSig, verifySession, verifyTpSig } from '../../src/plex/mediapaths.js';
import { langMatches, PlexPlayback, plexPlaybackFactory } from '../../src/plex/playback.js';
import { decodeText, srtToVtt } from '../../src/plex/subtitles.js';
import { parseBifHeader } from '../../src/plex/trickplay.js';
import { KeyedMutex, plexHttpFromClient, rungHeight, transcodeQuery, waitForIndex } from '../../src/plex/transcode.js';
import { parseDecision, plexTranscodeReason, type ReasonFacts } from '../../src/plex/reason.js';
import { bifHeader, FakeFfmpeg, STREAM_TOKEN, TranscoderFake } from './streamfake.js';

const SECRET = 'x'.repeat(32); // test-only HMAC key
const vectors = JSON.parse(readFileSync(new URL('../../../test-vectors/media-paths.plex.json', import.meta.url), 'utf8')) as {
  secret: string;
  signatures: { part: Array<{ item: string; part: string; sig: string }>; trickplay: Array<{ item: string; part: string; sig: string }>; session: Array<{ item: string; nonce: string; session: string }>; chapter: Array<{ item: string; media: string; sig: string }> };
};
const MOVIE = encodePlexId('item', 1); // mkv h264/aac, audio 2 (eng, default) + 3 (jpn), subs 4 (embedded srt) + 5 (sidecar srt), BIF
const EP = encodePlexId('item', 5);
const HEVC = encodePlexId('item', 2);
const DENIED = encodePlexId('item', 9);
const PART1 = encodePlexId('part', 1);
const ALICE: MediaUser = { id: 'u-alice', jellyfin_user_id: 'p-alice', jellyfin_username: 'alice', jellyfin_pw_enc: '' };
const BOB: MediaUser = { id: 'u-bob', jellyfin_user_id: 'p-bob', jellyfin_username: 'bob', jellyfin_pw_enc: '' };
const opts = { maxBitrate: 20_000_000 };

function setup(o: { ffmpeg?: FakeFfmpeg; denied?: string[] } = {}) {
  const fake = new TranscoderFake();
  const ff = o.ffmpeg ?? new FakeFfmpeg();
  const kv = new MemoryKV();
  const itemCalls: string[] = [];
  const denied = new Set([DENIED, ...(o.denied ?? [])]);
  const item = async (_u: MediaUser, id: string): Promise<ItemDto> => {
    itemCalls.push(id);
    if (denied.has(id)) throw new MediaError(404, 'not visible');
    return { id, name: 'x', type: 'Movie', genres: [], image: true, backdrop: true, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 123_000_000, runtimeTicks: 600_210_000 };
  };
  const svc = { client: new PlexClient('http://plex.test:32400', STREAM_TOKEN, fake.fetch), item };
  const pb = plexPlaybackFactory({ kv, secret: SECRET, ffmpeg: ff, sleep: async () => undefined })(svc);
  return { fake, ff, kv, pb, itemCalls };
}
const leak = (v: unknown) => JSON.stringify(v).includes(STREAM_TOKEN) || /x-plex-token/i.test(JSON.stringify(v));

describe('shared vectors: signatures and sessions', () => {
  it.each(vectors.signatures.part)('part sig %#', (v) => {
    expect(partSig(vectors.secret, v.item, v.part)).toBe(v.sig);
    expect(verifyPartSig(vectors.secret, v.item, v.part, v.sig)).toBe(true);
    expect(verifyPartSig('other-secret-other-secret', v.item, v.part, v.sig)).toBe(false);
  });
  it.each(vectors.signatures.trickplay)('trickplay sig %#', (v) => {
    expect(tpSig(vectors.secret, v.item, v.part)).toBe(v.sig);
    expect(verifyTpSig(vectors.secret, v.item, v.part, v.sig)).toBe(true);
    expect(verifyPartSig(vectors.secret, v.item, v.part, v.sig)).toBe(false);
  });
  it.each(vectors.signatures.chapter)('chapter still sig %#', (v) => {
    expect(chSig(vectors.secret, v.item, v.media)).toBe(v.sig);
    expect(verifyChSig(vectors.secret, v.item, v.media, v.sig)).toBe(true);
    expect(verifyTpSig(vectors.secret, v.item, v.media, v.sig)).toBe(false);
    expect(chapterImageUrl(vectors.secret, v.item, v.media, 3)).toBe(`/media/Items/${v.item}/Images/Chapter/3?media=${v.media}&sig=${v.sig}&maxWidth=320`);
  });
  it.each(vectors.signatures.session)('session %#', (v) => {
    expect(sessionFor(vectors.secret, v.item, v.nonce)).toBe(v.session);
    expect(verifySession(vectors.secret, v.item, v.session)).toBe(true);
    expect(verifySession(vectors.secret, MOVIE === v.item ? EP : MOVIE, v.session)).toBe(false);
  });
  it('sessions never contain a 32-hex run (the cast scope check reads the first one as the item id)', () => {
    for (let n = 0; n < 50; n++) expect(sessionFor(SECRET, MOVIE)).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('playbackInfo', () => {
  it('denied item: MediaError 404 before any Plex request', async () => {
    const { pb, fake } = setup();
    await expect(pb.playbackInfo(ALICE, DENIED, opts)).rejects.toMatchObject({ status: 404 });
    await expect(pb.playbackInfo(ALICE, 'a'.repeat(32), opts)).rejects.toMatchObject({ status: 404 });
    expect(fake.calls).toEqual([]);
  });

  it('DTO: public session-bound URLs only, no token, no Plex paths; tracks by Stream[] position', async () => {
    const { pb, fake } = setup();
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    expect(leak(info)).toBe(false);
    expect(JSON.stringify(info)).not.toMatch(/\/library\/|\/video\/:|32400|plex\.test/);
    expect(info.hlsUrl).toMatch(new RegExp(`^/media/Videos/${MOVIE}/hls/[0-9a-f]{16}-[0-9a-f]{24}/index\\.m3u8$`));
    expect(info.playSessionId).toBe(info.hlsUrl.split('/')[5]);
    expect(verifySession(SECRET, MOVIE, info.playSessionId)).toBe(true);
    expect(info.mediaSourceId).toBe(PART1);
    expect(info.directUrl).toBeUndefined(); // mkv
    expect(info.runtimeTicks).toBe(600_210_000);
    expect(info.audioTracks).toEqual([
      { index: 1, language: 'eng', title: 'English (AAC Mono)', isDefault: true },
      { index: 2, language: 'jpn', title: '日本語 (AAC Mono)', isDefault: false },
    ]);
    expect(info.subtitles.map((s) => [s.index, s.url])).toEqual([
      [3, `/api/items/${MOVIE}/subtitle/${PART1}/3/stream.vtt`],
      [4, `/api/items/${MOVIE}/subtitle/${PART1}/4/stream.vtt`],
    ]);
    expect(fake.calls.every((c) => c.headers['x-plex-token'] === STREAM_TOKEN)).toBe(true);
    expect(fake.sessions.size).toBe(0); // nothing started yet
  });

  it('audioLang picks a non-default track (ISO 639-2 B/T aliases), explicit audioIndex wins, invalid indexes are ignored', async () => {
    const { pb, fake } = setup();
    expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, audioLang: 'jpn' })).audioIndex).toBe(2);
    expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, audioLang: 'eng' })).audioIndex).toBeUndefined(); // default track
    expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, audioIndex: 1, audioLang: 'jpn' })).audioIndex).toBe(1);
    expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, audioIndex: 3 })).audioIndex).toBeUndefined(); // a subtitle stream
    expect(langMatches({ id: 1, streamType: 2, languageCode: 'deu' }, 'ger')).toBe(true);
    expect(langMatches({ id: 1, streamType: 2, languageCode: 'ger' }, 'deu')).toBe(true);
    expect(langMatches({ id: 1, streamType: 2, languageTag: 'ja' }, 'ja')).toBe(true);
    expect(langMatches({ id: 1, streamType: 2, languageCode: 'eng' }, 'ger')).toBe(false);
    void fake;
  });

  it('direct play only for browser containers within every cap; never for cast, noDirect, height caps, explicit audio', async () => {
    const { pb, fake } = setup();
    const m = fake.meta.get('1')!.Media[0];
    m.container = 'mp4';
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    expect(info.directUrl).toBe(`/media/Videos/${MOVIE}/stream?MediaSourceId=${PART1}&sig=${partSig(SECRET, MOVIE, PART1)}`);
    for (const o of [{ cast: true }, { noDirect: true }, { maxHeight: 240 }, { audioIndex: 2 }, { maxBitrate: 1_000_000 }]) {
      expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, ...o })).directUrl, JSON.stringify(o)).toBeUndefined();
    }
    expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, maxHeight: 720 })).directUrl).toBeDefined(); // 360p source within cap
    expect((await pb.playbackInfo(ALICE, MOVIE, { ...opts, cast: true })).subtitles.map((x) => x.url)).toEqual(info.subtitles.map((x) => x.url)); // signed for the receiver by the cast route
  });
});

describe('preparePlayback / transcoder flow', () => {
  it('PUT audio selection -> decision -> start (same session + client id, Platform/Product), then waits for the playlist', async () => {
    const { pb, fake } = setup();
    const info = await pb.playbackInfo(ALICE, MOVIE, { ...opts, audioLang: 'jpn' });
    fake.indexDelay = 3;
    await pb.preparePlayback(ALICE, info, opts);
    const seq = fake.calls.filter((c) => c.path !== '/library/metadata/1').map((c) => `${c.method} ${c.path}`);
    expect(seq.slice(0, 3)).toEqual(['PUT /library/parts/1', 'GET /video/:/transcode/universal/decision', 'GET /video/:/transcode/universal/start.m3u8']);
    expect(seq.slice(3)).toEqual(Array(4).fill(`GET /video/:/transcode/universal/session/${info.playSessionId}/base/index.m3u8`));
    const put = fake.calls.find((c) => c.method === 'PUT')!;
    expect(new URLSearchParams(put.search).get('audioStreamID')).toBe('3');
    expect(new URLSearchParams(put.search).get('allParts')).toBe('1');
    const s = fake.sessions.get(info.playSessionId)!;
    expect(s.audio).toBe('3');
    expect(s.platform).toBe('Chrome');
    expect(s.query.get('X-Plex-Client-Identifier')).toBe(info.playSessionId);
    expect(s.query.get('maxVideoBitrate')).toBeNull(); // source within the cap: the Web profile may stream-copy
    expect(s.query.get('subtitles')).toBe('none');
    expect(s.query.get('path')).toBe('/library/metadata/1');
    expect(leak(s.query.toString())).toBe(false);
  });

  it('limits: bitrate above the source cap and a height cap reach the transcoder; cast uses the Android (AAC) profile', async () => {
    const { pb, fake } = setup();
    const a = await pb.playbackInfo(ALICE, MOVIE, { maxBitrate: 1_000_000, maxHeight: 240 });
    await pb.preparePlayback(ALICE, a, opts);
    expect(fake.sessions.get(a.playSessionId)!.query.get('maxVideoBitrate')).toBe('808');
    expect(fake.sessions.get(a.playSessionId)!.query.get('videoResolution')).toBe('426x240');
    const c = await pb.playbackInfo(ALICE, MOVIE, { maxBitrate: 8_000_000, maxHeight: 1080, cast: true });
    await pb.preparePlayback(ALICE, c, opts);
    expect(fake.sessions.get(c.playSessionId)!.platform).toBe('Android');
    expect(fake.sessions.get(c.playSessionId)!.query.get('videoResolution')).toBeNull(); // 360p source
  });

  it('Block 20: a converted stream gets the rung\'s bitrate and height (4K source at 8 / 4 Mbit/s -> 1080p / 720p), in-cap copies stay unlimited', async () => {
    const { pb, fake } = setup();
    const m = fake.meta.get('1')!.Media[0];
    Object.assign(m, { height: 2160, width: 3840, bitrate: 40_000 });
    const q = async (o: Record<string, unknown>) => {
      const i = await pb.playbackInfo(ALICE, MOVIE, { ...opts, ...o });
      await pb.preparePlayback(ALICE, i, opts);
      return fake.sessions.get(i.playSessionId)!.query;
    };
    let s = await q({ maxBitrate: 8_000_000 });
    expect([s.get('maxVideoBitrate'), s.get('videoResolution')]).toEqual(['7808', '1920x1080']);
    s = await q({ maxBitrate: 4_000_000 });
    expect([s.get('maxVideoBitrate'), s.get('videoResolution')]).toEqual(['3808', '1280x720']);
    s = await q({ maxBitrate: 1_000_000 });
    expect([s.get('maxVideoBitrate'), s.get('videoResolution')]).toEqual(['808', '640x360']);
    s = await q({ maxBitrate: 4_000_000, maxHeight: 480 }); // the role's height cap wins when it is lower
    expect(s.get('videoResolution')).toBe('854x480');
    s = await q({ maxBitrate: 60_000_000 }); // 4K h264 within the cap: stream copy, no limits
    expect([s.get('maxVideoBitrate'), s.get('videoResolution')]).toEqual([null, null]);
    const h = setup(); // the video is converted anyway (hevc): rung limits even within the cap
    Object.assign(h.fake.meta.get('1')!.Media[0], { height: 2160, width: 3840, bitrate: 40_000, videoCodec: 'hevc' });
    const hi = await h.pb.playbackInfo(ALICE, MOVIE, { maxBitrate: 60_000_000 });
    await h.pb.preparePlayback(ALICE, hi, opts);
    s = h.fake.sessions.get(hi.playSessionId)!.query;
    expect([s.get('maxVideoBitrate'), s.get('videoResolution')]).toEqual(['59808', '1920x1080']);
    expect([rungHeight(8e6), rungHeight(7_999_999), rungHeight(4e6), rungHeight(1.5e6), rungHeight(1e6)]).toEqual([1080, 720, 720, 480, 360]);
  });

  it('Block 20: transcodeReason from the source and Plex\'s stream decisions; undefined for direct play', async () => {
    let { pb, fake } = setup(); // metadata is memoized per backend: one setup per source shape
    const reason = async (o: Record<string, unknown>, id = MOVIE) => {
      const i = await pb.playbackInfo(ALICE, id, { ...opts, ...o });
      return (await pb.preparePlayback(ALICE, i, opts)).transcodeReason;
    };
    fake.meta.get('1')!.Media[0].container = 'mp4';
    expect(await reason({})).toBeUndefined(); // direct play
    expect(await reason({ maxBitrate: 1_000_000, capReason: 'remoteCap' })).toBe('remoteCap');
    expect(await reason({ maxBitrate: 1_000_000, capReason: 'roleCap' })).toBe('roleCap');
    expect(await reason({ maxBitrate: 1_000_000, capReason: 'manual' })).toBe('manual');
    expect(await reason({ maxBitrate: 1_000_000 })).toBe('network');
    expect(await reason({ audioIndex: 2 })).toBe('audioTrack');
    ({ pb, fake } = setup()); // mkv
    expect(await reason({})).toBe('container'); // h264/aac in mkv: remuxed
    expect(await reason({ maxBitrate: 1_000_000, capReason: 'remoteCap' })).toBe('remoteCap'); // the cap re-encodes the video
    expect(await reason({}, HEVC)).toBe('videoCodec');
    expect(await reason({ maxBitrate: 300_000, capReason: 'remoteCap' }, HEVC)).toBe('videoCodec'); // server reasons outrank caps
    fake.decisionStreams = { video: 'copy', audio: 'transcode' }; // e.g. 7.1 audio the Web profile converts
    expect(await reason({})).toBe('audioCodec');
    fake.decisionStreams = { video: 'copy', audio: 'copy' };
    expect(await reason({})).toBe('container');
    const info = await pb.playbackInfo(ALICE, MOVIE, { ...opts, maxBitrate: 1_000_000, capReason: 'remoteCap' });
    expect(info.transcodeReason).toBe('remoteCap'); // already on the DTO before the decision
  });

  it('plexTranscodeReason / parseDecision (PMS decision JSON, lenient)', () => {
    const f: ReasonFacts = { container: 'mp4', videoCodec: 'h264', bitDepth: 8, audioCodec: 'aac', srcBps: 5e6, srcHeight: 1080, maxBitrate: 20e6 };
    expect(plexTranscodeReason(f)).toBe('other');
    expect(plexTranscodeReason({ ...f, bitDepth: 10 })).toBe('videoCodec');
    expect(plexTranscodeReason({ ...f, audioCodec: 'truehd' })).toBe('audioCodec');
    expect(plexTranscodeReason({ ...f, audioCodec: 'eac3' }, { audio: 'copy' })).toBe('other');
    expect(plexTranscodeReason({ ...f, maxHeight: 720 })).toBe('height');
    expect(plexTranscodeReason({ ...f, srcBps: 0 }, { video: 'transcode' })).toBe('network');
    expect(plexTranscodeReason({ ...f, srcBps: 0, capReason: 'roleCap' }, { video: 'transcode' })).toBe('roleCap');
    expect(plexTranscodeReason({ ...f, audioIndex: 2, audioCodec: 'dts' })).toBe('audioCodec');
    const pms = { MediaContainer: { generalDecisionCode: 1001, transcodeDecisionText: 'Direct play not available; Conversion OK.', Metadata: [{ Media: [{ selected: true, Part: [{ decision: 'transcode', Stream: [
      { streamType: 1, decision: 'copy' }, { streamType: 2, decision: 'transcode', selected: true }, { streamType: 3, decision: 'burn' },
    ] }] }] }] } };
    expect(parseDecision(pms)).toEqual({ video: 'copy', audio: 'transcode' });
    expect(parseDecision({ MediaContainer: { TranscodeSession: [{ videoDecision: 'transcode', audioDecision: 'copy' }] } })).toEqual({ video: 'transcode', audio: 'copy' });
    expect(parseDecision({ MediaContainer: { generalDecisionCode: 1001 } })).toEqual({ video: undefined, audio: undefined });
    expect(parseDecision(null)).toEqual({});
  });

  it('the default track is re-selected for sessions without a choice (the account selection may have been flipped)', async () => {
    const { pb, fake } = setup();
    fake.selected.set('1', '3');
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    await pb.preparePlayback(ALICE, info, opts);
    expect(fake.sessions.get(info.playSessionId)!.audio).toBe('2');
  });

  it('concurrent starts with different tracks never mix (lock around PUT -> decision -> start)', async () => {
    const { pb, fake } = setup();
    fake.decisionDelayMs = 15;
    const infos = await Promise.all([1, 2, 1, 2, 2, 1].map((a) => pb.playbackInfo(a === 2 ? BOB : ALICE, MOVIE, { ...opts, audioIndex: a })));
    await Promise.all(infos.map((i) => pb.preparePlayback(i.audioIndex === 2 ? BOB : ALICE, i, opts)));
    for (const i of infos) expect(fake.sessions.get(i.playSessionId)!.audio).toBe(i.audioIndex === 2 ? '3' : '2');
  });

  it('control: without the lock the account-level selection races (the fake models the snapshot-at-start behaviour)', async () => {
    const { pb, fake } = setup();
    fake.decisionDelayMs = 15;
    (pb.lock as unknown as { run: (k: string, fn: () => Promise<unknown>) => Promise<unknown> }).run = (_k, fn) => fn();
    const infos = await Promise.all([1, 2, 1, 2].map((a) => pb.playbackInfo(ALICE, MOVIE, { ...opts, audioIndex: a })));
    await Promise.all(infos.map((i) => pb.preparePlayback(ALICE, i, opts)));
    expect(infos.some((i) => fake.sessions.get(i.playSessionId)!.audio !== (i.audioIndex === 2 ? '3' : '2'))).toBe(true);
  });

  it('a session belongs to its identity and its item: foreign or forged sessions are refused', async () => {
    const { pb, fake } = setup();
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    await expect(pb.preparePlayback(BOB, info, opts)).rejects.toMatchObject({ status: 404 });
    await expect(pb.preparePlayback(ALICE, { ...info, playSessionId: sessionFor('wrong-secret-wrong-secret', MOVIE) }, opts)).rejects.toMatchObject({ status: 404 });
    await expect(pb.preparePlayback(ALICE, { ...info, itemId: EP }, opts)).rejects.toMatchObject({ status: 404 });
    expect(fake.sessions.size).toBe(0);
  });

  it('a failed decision (no playable conversion) is a MediaError, the start is never called', async () => {
    const { pb, fake } = setup();
    fake.decisionCode = 2000;
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    await expect(pb.preparePlayback(ALICE, info, opts)).rejects.toBeInstanceOf(MediaError);
    expect(fake.calls.some((c) => c.path.endsWith('start.m3u8'))).toBe(false);
  });

  it('direct play does not wait for the transcoder', async () => {
    const { pb, fake } = setup();
    fake.meta.get('1')!.Media[0].container = 'mp4';
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    fake.indexDelay = 1000;
    await pb.preparePlayback(ALICE, info, opts);
    expect(fake.calls.filter((c) => c.path.endsWith('index.m3u8'))).toEqual([]);
  });

  it('stopEncoding stops own sessions only and never throws', async () => {
    const { pb, fake } = setup();
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    await pb.preparePlayback(ALICE, info, opts);
    await pb.stopEncoding(BOB, info.playSessionId);
    expect(fake.sessions.get(info.playSessionId)!.stopped).toBe(false);
    await pb.stopEncoding(ALICE, info.playSessionId);
    expect(fake.sessions.get(info.playSessionId)!.stopped).toBe(true);
    await expect(pb.stopEncoding(ALICE, 'garbage')).resolves.toBeUndefined();
  });

  it('waitForIndex gives up with 504 and rejects non-404 errors', async () => {
    const http = { fetch: async () => new Response(null, { status: 404 }) };
    await expect(waitForIndex(http, 's', { timeoutMs: 0, sleep: async () => undefined })).rejects.toMatchObject({ status: 504 });
    const bad = { fetch: async () => new Response(null, { status: 500 }) };
    await expect(waitForIndex(bad, 's', { sleep: async () => undefined })).rejects.toMatchObject({ status: 502 });
  });
});

describe('mediaFetch, clips and downloads (virtual fMP4 over Plex TS)', () => {
  it('refuses absolute URLs, anything outside the session files, and sessions of other identities', async () => {
    const { pb, fake } = setup();
    const info = await pb.playbackInfo(ALICE, MOVIE, opts);
    await pb.preparePlayback(ALICE, info, opts);
    await expect(pb.mediaFetch(ALICE, 'http://evil.example/x')).rejects.toMatchObject({ status: 400 });
    await expect(pb.mediaFetch(ALICE, '//evil.example/x')).rejects.toMatchObject({ status: 400 });
    for (const p of ['/library/metadata/1', '/library/parts/1/0/file', '/video/:/transcode/universal/start.m3u8?path=/library/metadata/2', '/:/prefs']) {
      expect((await pb.mediaFetch(ALICE, p)).status, p).toBe(403);
    }
    expect((await pb.mediaFetch(BOB, `/video/:/transcode/universal/session/${info.playSessionId}/base/00001.ts`)).status).toBe(404);
    const own = await pb.mediaFetch(ALICE, `/video/:/transcode/universal/session/${info.playSessionId}/base/00001.ts`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe(`TS|${info.playSessionId}|1|audio=2`);
    void fake;
  });

  it('health check: clipTranscode forces a re-encode (Android, directStream=0, limits) and serves a TS master whose URIs stay fetchable', async () => {
    const { pb, fake } = setup();
    const info = await pb.playbackInfo(ALICE, MOVIE, { maxBitrate: 1_500_000 });
    const clip = await pb.clipTranscode(ALICE, info, { videoBitrate: 1_200_000, audioBitrate: 128_000, maxWidth: 1280 });
    expect(clip.path).toBe(`/ff-plex/hls/${clip.playSessionId}/master.m3u8`);
    const q = fake.sessions.get(clip.playSessionId)!.query;
    expect([q.get('directStream'), q.get('maxVideoBitrate'), q.get('videoResolution'), q.get('X-Plex-Platform')]).toEqual(['0', '1200', '1280x720', 'Android']);
    const resolve = (base: string, uri: string) => { const u = new URL(uri, new URL(base, 'http://jf.invalid')); return u.pathname + u.search; };
    const master = await (await pb.mediaFetch(ALICE, clip.path)).text();
    const variant = master.split('\n').find((l) => l && !l.startsWith('#'))!;
    const mediaPath = resolve(clip.path, variant);
    const segs = (await (await pb.mediaFetch(ALICE, mediaPath)).text()).split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs).toHaveLength(4);
    const seg = await pb.mediaFetch(ALICE, resolve(mediaPath, segs[3]!));
    expect(await seg.text()).toBe(`TS|${clip.playSessionId}|3|audio=2`);
    await pb.stopEncoding(ALICE, clip.playSessionId);
    expect(fake.sessions.get(clip.playSessionId)!.stopped).toBe(true);
  });

  it('preview clip / download: fMP4 playlist with init + remuxed fragments; a stopped session restarts on the next segment', async () => {
    const ff = new FakeFfmpeg();
    const { pb, fake } = setup({ ffmpeg: ff });
    const src = await pb.downloadSource(ALICE, MOVIE, { quality: 'hd', audioIndex: 2 });
    expect(src.masterPath).toMatch(VIRTUAL_RE);
    expect(src.originalEligible).toBe(false); // mkv
    expect(src.mediaSourceId).toBe(PART1);
    expect(src.sizeBytes).toBe(Math.round((60.021 * 2_628_000) / 8));
    expect(src.audio.map((a) => [a.index, a.lang, a.isDefault])).toEqual([[1, 'eng', true], [2, 'jpn', false]]);
    expect(leak(src)).toBe(false);
    expect(fake.sessions.size).toBe(0); // started lazily by the first playlist fetch
    const base = src.masterPath!.replace('master.m3u8', '');
    const master = await (await pb.mediaFetch(ALICE, src.masterPath!)).text();
    expect(master).toContain('media.m3u8');
    const media = await (await pb.mediaFetch(ALICE, `${base}media.m3u8`)).text();
    expect(media).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(media.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['0.m4s', '1.m4s', '2.m4s', '3.m4s']);
    const sess = fake.sessions.get(src.playSessionId)!;
    expect([sess.platform, sess.audio, sess.query.get('directStream'), sess.query.get('videoResolution'), sess.query.get('maxVideoBitrate')]).toEqual(['Android', '3', '0', null, '2500']);
    const init = Buffer.from(await (await pb.mediaFetch(ALICE, `${base}init.mp4`)).arrayBuffer());
    expect(init.toString('latin1')).toContain('INIT');
    expect(init.toString('latin1')).not.toContain('mdat');
    await pb.stopEncoding(ALICE, src.playSessionId); // downloadprep pauses like this
    const s2 = Buffer.from(await (await pb.mediaFetch(ALICE, `${base}2.m4s`)).arrayBuffer()).toString('latin1');
    expect(s2.startsWith('\0\0\0')).toBe(true);
    expect(s2).toContain('moof');
    expect(s2).toContain(`TS|${src.playSessionId}|2|audio=3`);
    expect(s2).not.toContain('moov');
    expect(fake.sessions.get(src.playSessionId)!.starts).toBe(2);
    expect(ff.calls.filter((c) => c.args.includes('mpegts')).length).toBe(2); // init (segment 0) + segment 2
    expect((await pb.mediaFetch(BOB, `${base}2.m4s`)).status).toBe(404);
  });

  it('original downloads: no master, mp4/h264/aac within caps is eligible', async () => {
    const { pb, fake } = setup();
    const m = fake.meta.get('1')!.Media[0];
    m.container = 'mp4';
    const src = await pb.downloadSource(ALICE, MOVIE, { quality: 'original' });
    expect(src.masterPath).toBeUndefined();
    expect(src.originalEligible).toBe(true);
    expect(src.sizeBytes).toBe(14268835);
    expect((await pb.downloadSource(ALICE, MOVIE, { quality: 'original', audioIndex: 2 })).originalEligible).toBe(false);
    expect((await pb.downloadSource(ALICE, MOVIE, { quality: 'original', maxBitrate: 1_000_000 })).originalEligible).toBe(false);
    expect((await pb.downloadSource(ALICE, HEVC, { quality: 'original' })).originalEligible).toBe(false);
  });
});

describe('subtitles', () => {
  it('srtToVtt: header, dotted timestamps, ASS tags removed; Windows-1252 fallback', () => {
    expect(srtToVtt('1\r\n00:00:01,000 --> 00:00:03,500\r\nHello {\\an8}there\r\n\r\n2\r\n0:0:4,5 --> 00:00:05,000\r\nA --> B\r\n')).toBe(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello there\n\n2\n00:00:04.500 --> 00:00:05.000\nA -> B\n',
    );
    expect(decodeText(Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toBe('Grüße');
    expect(decodeText(Buffer.from('\uFEFFok', 'utf8'))).toBe('ok');
  });

  it('sidecar SRT (served by Plex as text/html) becomes WebVTT; embedded via ffmpeg through a loopback proxy (no token in its args)', async () => {
    const ff = new FakeFfmpeg();
    const { pb, fake } = setup({ ffmpeg: ff });
    const side = await pb.subtitleStream(ALICE, MOVIE, PART1, 4, 'vtt');
    expect(side.status).toBe(200);
    expect(side.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(await side.text()).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello there\n\n2\n00:00:04.000 --> 00:00:05.000\nSecond <i>line</i>\n');
    const emb = await pb.subtitleStream(ALICE, MOVIE, PART1, 3, 'vtt');
    expect(emb.status).toBe(200);
    expect(await emb.text()).toContain('PART1-DATA');
    const call = ff.calls.at(-1)!;
    expect(call.args).toContain('0:3');
    expect(call.args.join(' ')).toMatch(/-i http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36} /);
    expect(leak(call.args)).toBe(false);
    const partReq = fake.calls.find((c) => c.path === '/library/parts/1/0/file')!;
    expect(partReq.headers['x-plex-token']).toBe(STREAM_TOKEN); // the proxy adds it, ffmpeg never sees it
    // cached: no second extraction
    await pb.subtitleStream(ALICE, MOVIE, PART1, 3, 'vtt');
    expect(ff.calls.length).toBe(1);
  });

  it('wrong media source, non-subtitle or unknown index: 404; denied item: throws', async () => {
    const { pb } = setup();
    expect((await pb.subtitleStream(ALICE, MOVIE, encodePlexId('part', 2), 4, 'vtt')).status).toBe(404);
    expect((await pb.subtitleStream(ALICE, MOVIE, PART1, 1, 'vtt')).status).toBe(404);
    expect((await pb.subtitleStream(ALICE, MOVIE, PART1, 99, 'vtt')).status).toBe(404);
    await expect(pb.subtitleStream(ALICE, DENIED, PART1, 4, 'vtt')).rejects.toMatchObject({ status: 404 });
  });
});

describe('trickplay + playMeta', () => {
  it('BIF header: count, interval (multiplier 0 = 1000 ms), garbage rejected', () => {
    expect(parseBifHeader(bifHeader(30, 2, 0))).toEqual({ count: 30, intervalMs: 2000 });
    expect(parseBifHeader(bifHeader(10, 5, 1000))).toEqual({ count: 10, intervalMs: 5000 });
    expect(parseBifHeader(Buffer.alloc(80))).toBeNull();
    expect(parseBifHeader(bifHeader().subarray(0, 40))).toBeNull();
  });

  it('playMeta: resume from FriendFlix user data, 1x1 trickplay for the part with a signed URL', async () => {
    const { pb, fake } = setup();
    fake.meta.get('1')!.Media[0].Part[0].indexes = 'sd';
    const m = await pb.playMeta(ALICE, MOVIE);
    expect(m!.positionTicks).toBe(123_000_000);
    const tp = m!.trickplay(PART1)!;
    expect(tp).toEqual({ width: 320, height: 180, tileWidth: 1, tileHeight: 1, count: 30, interval: 2000, url: `/media/Videos/${MOVIE}/${PART1}/Trickplay/2000/{n}.jpg?sig=${tpSig(SECRET, MOVIE, PART1)}` });
    expect(tpSig(SECRET, MOVIE, PART1)).not.toBe(partSig(SECRET, MOVIE, PART1)); // own signature domain
    expect(m!.trickplay(encodePlexId('part', 2))).toBeUndefined();
    expect(await pb.playMeta(ALICE, DENIED)).toBeNull();
  });
});

describe('helpers', () => {
  it('fmp4Playlist maps NNNNN.ts to n.m4s and refuses foreign URIs', () => {
    const p = fmp4Playlist('#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:8, nodesc\n00000.ts\n#EXTINF:5, nodesc\n00001.ts\n#EXT-X-ENDLIST\n');
    expect(p.text).toBe('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:8, nodesc\n0.m4s\n#EXTINF:5, nodesc\n1.m4s\n#EXT-X-ENDLIST\n');
    expect(() => fmp4Playlist('#EXTM3U\nhttp://evil/x.ts\n')).toThrow();
  });
  it('splitFmp4 needs a moov and fragments', () => {
    expect(() => splitFmp4(Buffer.from('nothing here'))).toThrow();
  });
  it('transcodeQuery never carries a token', () => {
    const q = transcodeQuery({ ratingKey: '1', session: 's', platform: 'Chrome', directStream: true });
    expect([...q.keys()].some((k) => /token/i.test(k))).toBe(false);
  });
  it('KeyedMutex serializes per key and keeps going after a failure', async () => {
    const lock = new KeyedMutex();
    const log: string[] = [];
    const job = (k: string, n: string, fail = false) => lock.run(k, async () => { log.push(`+${n}`); await new Promise((r) => setTimeout(r, 5)); log.push(`-${n}`); if (fail) throw new Error('x'); });
    await Promise.allSettled([job('a', '1', true), job('a', '2'), job('b', '3')]);
    expect(log.indexOf('-1')).toBeLessThan(log.indexOf('+2'));
    expect(log.indexOf('+3')).toBeLessThan(log.indexOf('-1')); // other keys run in parallel
    expect(lock.size).toBe(0);
  });
  it('plexHttpFromClient sends the token as header only, plus the per-request client id / platform', async () => {
    const seen: Array<{ url: string; h: Headers }> = [];
    const client = new PlexClient('http://plex.test:32400', STREAM_TOKEN, (async (u: string, i: RequestInit) => { seen.push({ url: String(u), h: new Headers(i.headers) }); return new Response('ok'); }) as typeof fetch);
    await plexHttpFromClient(client).fetch('/x', { clientId: 'sess', platform: 'Android' });
    expect(seen[0]!.url).toBe('http://plex.test:32400/x');
    expect(seen[0]!.h.get('x-plex-token')).toBe(STREAM_TOKEN);
    expect(seen[0]!.h.get('x-plex-client-identifier')).toBe('sess');
    expect(seen[0]!.h.get('x-plex-platform')).toBe('Android');
  });
  it('PlexPlayback satisfies the service delegate shape', () => {
    const pb: PlexPlayback = setup().pb;
    expect(typeof pb.preparePlayback).toBe('function');
  });
});
