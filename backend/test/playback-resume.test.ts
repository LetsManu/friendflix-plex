import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

// Resume position on /api/playback/info: a failed /Items lookup must never turn into "start at 0"
// (the first progress report would then overwrite the saved Jellyfin position).
const A = 'a'.repeat(32);
const SAVED = 12_345_000_000;
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let itemsMode: 'ok' | 'fail' | 'empty' = 'ok';
let itemMode: 'ok' | 'fail' = 'ok';

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': () => (itemMode === 'fail' ? { status: 500 } : { json: { Id: A, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: SAVED } } }),
    'GET /Users/[^/]+/Items/[^/]+': () => (itemMode === 'fail' ? { status: 500 } : { json: { Id: A, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: SAVED } } }),
    'GET /Items': () => (itemsMode === 'fail' ? { status: 500 } : itemsMode === 'empty' ? { json: { Items: [] } } : { json: { Items: [{ Id: A, UserData: { PlaybackPositionTicks: SAVED } }] } }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: 'ms1', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 6_000_000, MediaStreams: [] }] } }),
  });
  s = await env.login();
});
afterAll(() => env.close());
const info = (body: Record<string, unknown>) => env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: A, ...body } });

describe('playback/info resume position', () => {
  it('uses the /Items lookup when it works', async () => {
    itemsMode = 'ok'; itemMode = 'ok';
    expect((await info({})).json().resumeTicks).toBe(SAVED);
  });
  it('falls back to the single-item endpoint when the /Items lookup fails or is empty', async () => {
    itemMode = 'ok';
    for (const m of ['fail', 'empty'] as const) {
      itemsMode = m;
      const r = await info({});
      expect(r.statusCode).toBe(200);
      expect(r.json().resumeTicks).toBe(SAVED);
    }
  });
  it('answers 502 (player retries) instead of resuming at 0 when both lookups fail', async () => {
    itemsMode = 'fail'; itemMode = 'fail';
    env.ctx.jf.forgetItems(); // the earlier test filled the 10 s item memo
    const r = await info({});
    expect(r.statusCode).toBe(502);
    expect(r.json().resumeTicks).toBeUndefined();
  });
  it('an explicit start position needs no lookup', async () => {
    itemsMode = 'fail'; itemMode = 'fail';
    const r = await info({ startTicks: 0 });
    expect(r.statusCode).toBe(200);
    expect(r.json().resumeTicks).toBe(0);
  });
});
