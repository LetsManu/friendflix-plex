// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryKV } from '../src/kv.js';
import { authenticate, newSession, saveSession } from '../src/session.js';
import { revokeSessions } from '../src/devices.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let me: { cookies: Record<string, string>; csrf: string };
beforeAll(async () => { env = await makeEnv(); me = await env.login(); });
afterAll(() => env.close());

let ip = 0;
const post = (url: string, body: unknown) => env.app.inject({ method: 'POST', url, payload: body as object, remoteAddress: `10.8.0.${++ip}` });

describe('MemoryKV', () => {
  it('replace only writes existing keys', async () => {
    const kv = new MemoryKV();
    expect(await kv.replace('a', '1', 10)).toBe(false);
    expect(await kv.get('a')).toBeNull();
    await kv.set('a', '1', 10);
    expect(await kv.replace('a', '2', 10)).toBe(true);
    expect(await kv.get('a')).toBe('2');
    await kv.set('b', 'x', -1); // expired
    expect(await kv.replace('b', 'y', 10)).toBe(false);
  });
  it('take returns the value once', async () => {
    const kv = new MemoryKV();
    await kv.set('a', '1', 10);
    expect(await kv.take('a')).toBe('1');
    expect(await kv.take('a')).toBeNull();
    expect(await kv.get('a')).toBeNull();
  });
  it('delIfEquals deletes only while the key holds that value', async () => {
    const kv = new MemoryKV();
    await kv.set('lock', 'mine', 10);
    expect(await kv.delIfEquals('lock', 'theirs')).toBe(false);
    expect(await kv.get('lock')).toBe('mine');
    expect(await kv.delIfEquals('lock', 'mine')).toBe(true);
    expect(await kv.get('lock')).toBeNull();
    expect(await kv.delIfEquals('lock', 'mine')).toBe(false);
  });
});

describe('races', () => {
  it('a stale touch after revoke does not recreate the session', async () => {
    const sid = me.cookies.ff_sid!;
    const raw = JSON.parse((await env.kv.get(`sess:${sid}`))!);
    await saveSession(env.ctx, sid, { ...raw, touchedAt: 1 }); // old enough to be refreshed
    const get = env.kv.get.bind(env.kv);
    env.kv.get = async (k: string) => { const v = await get(k); if (k === `sess:${sid}`) { env.kv.get = get; await revokeSessions(env.ctx, raw.userId); } return v; };
    const ok = await authenticate(env.ctx, { cookies: { ff_sid: sid } } as never);
    expect(ok).toBe(true); // it was loaded before the revoke
    expect(await env.kv.get(`sess:${sid}`)).toBeNull();
    me = await env.login();
  });

  it('saveSession for a new session still creates it', async () => {
    expect(await saveSession(env.ctx, 'new1', newSession({ userId: 'u', csrf: 'c', deviceApproved: true }))).toBe(true);
    expect(await env.kv.get('sess:new1')).not.toBeNull();
  });

  it('two concurrent claims with the same code: exactly one wins', async () => {
    const c = (await post('/api/tv/code', {})).json();
    const csrf = me.csrf;
    expect((await env.app.inject({ method: 'POST', url: '/api/tv/pair', payload: { code: c.code }, cookies: me.cookies, headers: { 'x-csrf-token': csrf } })).statusCode).toBe(200);
    // a wrong pollToken neither succeeds nor burns the code
    expect((await post('/api/tv/claim', { code: c.code, pollToken: 'x'.repeat(40) })).statusCode).toBe(403);
    const rs = await Promise.all([1, 2, 3, 4].map(() => post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 404)).toHaveLength(3);
    expect((await env.pool.query("select 1 from devices where label like 'Fernseher%'")).rowCount).toBe(1);
  });

  it('simultaneous first devices: only one is auto-approved', async () => {
    const u = (await env.pool.query('select id from users limit 1')).rows[0].id as string;
    await env.pool.query('delete from devices where user_id=$1', [u]);
    const reg = (d: string) => env.pool.query('select register_device($1,$2,$3) a', [u, d, 'x']);
    await Promise.all(['d1', 'd2', 'd3', 'd4', 'd5'].map(reg));
    const r = await env.pool.query('select count(*) filter (where approved) a, count(*) n from devices where user_id=$1', [u]);
    expect(r.rows[0]).toEqual({ a: '1', n: '5' });
  });
});
