// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Playback through the core Plex service (P1: mirror, access rules, user data) with the playback delegate plugged in, and through the
 * real routes: kids caps deny playback, the DTOs and every route answer are free of the Plex token, the transcoder is driven correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryKV } from '../../src/kv.js';
import type pg from 'pg';
import { PlexClient } from '../../src/plex/client.js';
import { encodePlexId } from '../../src/plex/ids.js';
import { migratePlex } from '../../src/plex/migrations.js';
import { plexPlaybackFactory } from '../../src/plex/playback.js';
import { PlexMediaServer } from '../../src/plex/service.js';
import { cfg, makeEnv, resetDb, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';
import { identity, item, kids } from './setup.js';
import { TranscoderFake } from './streamfake.js';

const build = (pool: pg.Pool, kv: MemoryKV, fake: PlexFake) => {
  const tf = new TranscoderFake(fake.fetch);
  const ms = new PlexMediaServer({
    client: new PlexClient(PLEX_URL, PLEX_TOKEN, tf.fetch), db: pool, kv, migrate: () => migratePlex(pool), websocket: false,
    playback: plexPlaybackFactory({ kv, secret: cfg.INTERNAL_SECRET, sleep: async () => undefined }),
  });
  return { ms, tf };
};

describe('playback delegate behind PlexMediaServer (access rules from the core)', () => {
  let pool: pg.Pool;
  let ms: PlexMediaServer;
  let tf: TranscoderFake;
  const fake = new PlexFake();
  const kid = fake.addMovie({ title: 'Kinderfilm', rating: 'de/0' });
  beforeAll(async () => {
    pool = await resetDb();
    ({ ms, tf } = build(pool, new MemoryKV(), fake));
    await ms.sync.run();
  });
  afterAll(async () => {
    await ms.stop();
    await pool.end();
  });

  it('a kids profile cannot start, prepare, download or fetch subtitles of a capped title; an allowed one plays', async () => {
    const k = await identity(ms, 'friend', kids(6));
    const n = tf.calls.length;
    await expect(ms.playbackInfo(k, item(2), { maxBitrate: 8_000_000 })).rejects.toMatchObject({ status: 404 }); // R
    await expect(ms.downloadSource(k, item(2), { quality: 'sd' })).rejects.toMatchObject({ status: 404 });
    await expect(ms.subtitleStream(k, item(1), encodePlexId('part', 1), 4, 'vtt')).rejects.toMatchObject({ status: 404 }); // PG-13
    expect(await ms.playMeta(k, item(2))).toBeNull();
    expect(tf.calls.slice(n).filter((c) => !c.path.startsWith('/library/sections') && c.path !== '/library/metadata/2')).toEqual([]);
    const info = await ms.playbackInfo(k, item(kid), { maxBitrate: 8_000_000 });
    const ready = await ms.preparePlayback(k, info, { maxBitrate: 8_000_000 });
    expect(ready.hlsUrl).toContain(`/media/Videos/${item(kid)}/hls/`);
    expect(tf.sessions.get(info.playSessionId)?.rk).toBe(kid);
    expect(JSON.stringify(ready)).not.toContain(PLEX_TOKEN);
  });

  it('another identity cannot stop or fetch a session', async () => {
    const a = await identity(ms, 'admin');
    const b = await identity(ms, 'admin');
    const info = await ms.preparePlayback(a, await ms.playbackInfo(a, item(1), { maxBitrate: 8_000_000 }), { maxBitrate: 8_000_000 });
    await ms.stopEncoding(b, info.playSessionId);
    expect(tf.sessions.get(info.playSessionId)!.stopped).toBe(false);
    expect((await ms.mediaFetch(b, `/video/:/transcode/universal/session/${info.playSessionId}/base/00000.ts`)).status).toBe(404);
    expect((await ms.mediaFetch(a, `/video/:/transcode/universal/session/${info.playSessionId}/base/00000.ts`)).status).toBe(200);
  });
});

describe('through the routes (makeEnv server: plex)', () => {
  let env: TestEnv;
  let tf: TranscoderFake;
  const bodies: string[] = [];
  const fake = new PlexFake();
  // Block 20: a 4K h264/aac mp4 at 30 Mbit/s (direct play at home without caps)
  const big = fake.addMovie({ title: 'Big Picture' });
  Object.assign(fake.items.get(big)!.Media[0], { bitrate: 30_000, height: 2160, width: 3840, container: 'mp4' });
  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake, plexFetch: (f) => (tf = new TranscoderFake(f.fetch)).fetch });
  });
  afterAll(async () => {
    for (const b of bodies) expect(b).not.toContain(PLEX_TOKEN);
    await env.close();
  });

  it('POST /api/playback/info: started transcode, session-bound public URLs, resume, trickplay; subtitles via the backend route', async () => {
    fake.items.get('1')!.Media[0].Part[0].indexes = 'sd'; // BIF generated
    const s = await env.login();
    const r = await env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: item(1), audioLang: 'jpn' } });
    bodies.push(r.body);
    expect(r.statusCode).toBe(200);
    const info = r.json();
    expect(info.hlsUrl).toMatch(new RegExp(`^/media/Videos/${item(1)}/hls/[0-9a-f]{16}-[0-9a-f]{24}/index\\.m3u8$`));
    expect(info.audioIndex).toBe(2);
    expect(tf.sessions.get(info.playSessionId)!.audio).toBe('3');
    expect(info.trickplay?.url).toContain(`/media/Videos/${item(1)}/${encodePlexId('part', 1)}/Trickplay/2000/{n}.jpg?sig=`);
    expect(r.body).not.toMatch(/\/library\/|\/video\/:|plex\.test|X-Plex/i);
    const sub = await env.app.inject({ url: info.subtitles.find((x: { index: number }) => x.index === 4).url, cookies: s.cookies });
    bodies.push(sub.body);
    expect(sub.statusCode).toBe(200);
    expect(sub.headers['content-type']).toContain('text/vtt');
    expect(sub.body).toContain('00:00:01.000 --> 00:00:03.500');
  });

  it('Block 20 on Plex: remote cap from the client address, transcodeReason, rung bitrate + height reach the transcoder', async () => {
    const s = await env.login();
    const play = async (ip: string, body: object = {}) => {
      const r = await env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-real-ip': ip }, payload: { itemId: item(big), ...body } });
      bodies.push(r.body);
      expect(r.statusCode).toBe(200);
      const info = r.json();
      return { info, q: tf.sessions.get(info.playSessionId)?.query };
    };
    const home = await play('192.168.1.10');
    expect(home.info.directUrl).toBeDefined();
    expect(home.info.transcodeReason).toBeUndefined();
    const away = await play('203.0.113.9');
    expect(away.info.directUrl).toBeUndefined();
    expect(away.info.maxBitrate).toBeLessThan(home.info.maxBitrate);
    expect(away.info.roleMaxBitrate).toBe(away.info.maxBitrate); // the effective ceiling outside the home networks
    expect(away.info.transcodeReason).toBe('remoteCap');
    expect(away.q!.get('maxVideoBitrate')).toBe(String(away.info.maxBitrate / 1000 - 192));
    expect(away.q!.get('videoResolution')).toBe('1920x1080');
    const slow = await play('192.168.1.10', { maxBitrate: 4_000_000, reasonHint: 'network' });
    expect(slow.info.transcodeReason).toBe('network');
    expect([slow.q!.get('maxVideoBitrate'), slow.q!.get('videoResolution')]).toEqual(['3808', '1280x720']);
    const picked = await play('192.168.1.10', { maxBitrate: 1_500_000, reasonHint: 'manual' });
    expect(picked.info.transcodeReason).toBe('manual');
    expect(picked.q!.get('videoResolution')).toBe('854x480');
  });
});
