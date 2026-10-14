// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } } }),
    'POST /Sessions/Playing': () => ({ status: 204 }),
    'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
    'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
  });
  s = await env.login();
});
afterAll(() => env.close());

const call = (url: string, body: unknown) => env.app.inject({ method: 'POST', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const sent = (p: string) => env.jfCalls.filter((c) => c.path === p);
const base = { itemId: ID, playSessionId: 'ps-12345678', mediaSourceId: 'ms1', positionTicks: 1000, isPaused: false };

describe('progress after live-record expiry', () => {
  it('forwards Progress, recreates the live record, ignoring maxStreams', async () => {
    await env.pool.query("update users set role='guest'"); // 1 stream
    await call('/api/playback/start', base);
    for (const k of await env.kv.keys('play:')) await env.kv.del(k); // TTL expired
    await call('/api/playback/start', { ...base, playSessionId: 'ps-other-0001' }); // another stream took the only slot
    const r = await call('/api/playback/progress', { ...base, positionTicks: 9000 });
    expect(r.statusCode).toBe(200);
    expect(sent('/Sessions/Playing/Progress').at(-1)!.body).toMatchObject({ PositionTicks: 9000, PlaySessionId: base.playSessionId });
    expect(await env.kv.keys('play:')).toHaveLength(2);
    await env.pool.query("update users set role='admin'");
  });

  it('forwards Stopped without a live record', async () => {
    for (const k of await env.kv.keys('play:')) await env.kv.del(k);
    const n = sent('/Sessions/Playing/Stopped').length;
    const r = await call('/api/playback/stop', { ...base, positionTicks: 12345 });
    expect(r.statusCode).toBe(200);
    expect(sent('/Sessions/Playing/Stopped')).toHaveLength(n + 1);
    expect(sent('/Sessions/Playing/Stopped').at(-1)!.body).toMatchObject({ PositionTicks: 12345 });
    expect(await env.kv.keys('play:')).toHaveLength(0);
  });

  it('start still enforces the stream limit', async () => {
    await env.pool.query("update users set role='guest'");
    expect((await call('/api/playback/start', base)).statusCode).toBe(200);
    expect((await call('/api/playback/start', { ...base, playSessionId: 'ps-other-0002' })).statusCode).toBe(429);
    await env.pool.query("update users set role='admin'");
  });
});
