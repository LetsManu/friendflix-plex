// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let me: { cookies: Record<string, string>; csrf: string };
let port: number;
const ORIGIN = 'https://portal.example.com';

beforeAll(async () => {
  env = await makeEnv();
  me = await env.login();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(() => env.close());

// every call comes from its own address so the per-IP rate limits (10/min on pair) do not interfere with the many small tests
let ipSeq = 0;
const post = (url: string, body?: unknown, who?: typeof me) => env.app.inject({ method: 'POST', url, payload: body as object, cookies: who?.cookies, headers: who ? { 'x-csrf-token': who.csrf } : {}, remoteAddress: `10.9.${(++ipSeq >> 8) & 255}.${ipSeq & 255}` });

describe('TV pairing', () => {
  it('the anonymous TV endpoints work even when the browser still holds an old session cookie (no csrf header)', async () => {
    const stale = { cookies: me.cookies };
    const r = await env.app.inject({ method: 'POST', url: '/api/tv/code', cookies: stale.cookies });
    expect(r.statusCode).toBe(200);
    expect((await env.app.inject({ method: 'POST', url: '/api/tv/claim', cookies: stale.cookies, payload: { code: r.json().code, pollToken: r.json().pollToken } })).statusCode).toBe(202);
    // pairing itself still requires the csrf token
    expect((await env.app.inject({ method: 'POST', url: '/api/tv/pair', cookies: stale.cookies, payload: { code: r.json().code } })).statusCode).toBe(403);
  });

  it('full flow: code -> pending -> confirmed on the phone -> TV gets its own approved device session', async () => {
    const c = (await post('/api/tv/code')).json();
    expect(c.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(c.pollToken.length).toBeGreaterThan(30);

    const pending = await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken });
    expect(pending.statusCode).toBe(202);

    expect((await post('/api/tv/pair', { code: c.code })).statusCode).toBe(401); // pairing needs a logged-in user
    expect((await post('/api/tv/pair', { code: c.code.toLowerCase().replace('-', ' ') }, me)).statusCode).toBe(200); // forgiving input
    expect((await post('/api/tv/pair', { code: c.code }, me)).statusCode).toBe(409); // second confirmation refused

    const claim = await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken });
    expect(claim.statusCode).toBe(200);
    const sid = claim.cookies.find((x) => x.name === 'ff_sid')!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.maxAge).toBe(30 * 86400);
    const tv = { ff_sid: sid.value };
    const who = await env.app.inject({ url: '/api/me', cookies: tv });
    expect(who.json()).toMatchObject({ name: 'Admin', deviceApproved: true, tv: true });
    expect((await env.app.inject({ url: '/api/me', cookies: me.cookies })).json().tv).toBe(false); // the phone is not a TV
    expect((await env.pool.query("select label, approved from devices where label like 'Fernseher%'")).rows[0]).toEqual({ label: 'Fernseher (TV-Modus)', approved: true });
    // the code is single use
    expect((await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).statusCode).toBe(404);
    expect((await env.pool.query("select 1 from audit_log where action in ('tv.pair','tv.claim')")).rowCount).toBe(2);
    expect((await env.pool.query("select title, link from notifications where kind='tv_paired'")).rows[0]).toMatchObject({ link: '/devices' });
  });

  it('TV sessions are long-lived (30 days) while phone sessions follow the normal limits', async () => {
    const c = (await post('/api/tv/code')).json();
    await post('/api/tv/pair', { code: c.code }, me);
    const sid = (await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).cookies.find((x) => x.name === 'ff_sid')!.value;
    const sess = JSON.parse((await env.kv.get(`sess:${sid}`))!);
    expect(sess).toMatchObject({ ttl: 30 * 86400, idle: 7 * 86400, deviceApproved: true });
  });

  it('rejects a wrong poll token and unknown/expired codes; cannot claim for somebody else', async () => {
    const c = (await post('/api/tv/code')).json();
    await post('/api/tv/pair', { code: c.code }, me);
    expect((await post('/api/tv/claim', { code: c.code, pollToken: 'x'.repeat(40) })).statusCode).toBe(403);
    expect((await post('/api/tv/claim', { code: 'ABCD-EFGH', pollToken: c.pollToken })).statusCode).toBe(404);
    expect((await post('/api/tv/pair', { code: 'ZZZZ-ZZZZ' }, me)).statusCode).toBe(404);
    expect((await post('/api/tv/pair', { code: 'x' }, me)).statusCode).toBe(400);
    await env.kv.del(`tvpair:${c.code.replace('-', '')}`);
    expect((await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).statusCode).toBe(404);
  });

  it('a disabled user cannot get a TV session', async () => {
    const c = (await post('/api/tv/code')).json();
    await post('/api/tv/pair', { code: c.code }, me);
    await env.pool.query('update users set disabled = true');
    expect((await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).statusCode).toBe(403);
    await env.pool.query('update users set disabled = false');
  });

  it('removing the TV device ends its session', async () => {
    const c = (await post('/api/tv/code')).json();
    await post('/api/tv/pair', { code: c.code }, me);
    const sid = (await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).cookies.find((x) => x.name === 'ff_sid')!.value;
    const dev = (await env.pool.query("select device_id from devices where label like 'Fernseher%' order by created_at desc limit 1")).rows[0].device_id;
    expect((await env.app.inject({ method: 'DELETE', url: `/api/devices/${dev}`, cookies: me.cookies, headers: { 'x-csrf-token': me.csrf } })).statusCode).toBe(200);
    expect((await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).statusCode).toBe(401);
  });
});

describe('remote control hub', () => {
  const open = (cookie: string, role: 'tv' | 'remote', origin = ORIGIN) =>
    new Promise<{ ws: WebSocket; msgs: any[]; closed: Promise<number> }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/remote?role=${role}`, { headers: { cookie: `ff_sid=${cookie}`, origin } });
      const msgs: any[] = [];
      const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve({ ws, msgs, closed }));
      ws.on('error', () => resolve({ ws, msgs, closed }));
    });
  // only sessions of a paired television may register as the TV
  const tvSid = async () => { const c = (await post('/api/tv/code')).json(); await post('/api/tv/pair', { code: c.code }, me); return (await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).cookies.find((q) => q.name === 'ff_sid')!.value; };
  const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const ITEM = 'a'.repeat(32);

  it('forwards cast and control from the phone to the TV of the same user and status back', async () => {
    const tv = await open(await tvSid(), 'tv');
    const phone = await open(me.cookies.ff_sid!, 'remote');
    await vi.waitFor(() => expect(phone.msgs.find((m) => m.t === 'hello')).toBeTruthy());
    expect(phone.msgs.find((m) => m.t === 'hello')).toMatchObject({ role: 'remote', tvOnline: true });
    expect((await env.app.inject({ url: '/api/tv/status', cookies: me.cookies })).json()).toEqual({ tvOnline: true });

    phone.ws.send(JSON.stringify({ t: 'cast', itemId: ITEM, startSec: 90 }));
    phone.ws.send(JSON.stringify({ t: 'ctl', action: 'seekBy', value: -10 }));
    phone.ws.send(JSON.stringify({ t: 'ctl', action: 'next' }));
    phone.ws.send(JSON.stringify({ t: 'ctl', action: 'format-disk' })); // not in the whitelist
    phone.ws.send(JSON.stringify({ t: 'cast', itemId: '../../etc/passwd' })); // invalid id
    phone.ws.send('garbage');
    tv.ws.send(JSON.stringify({ t: 'status', itemId: ITEM, title: 'Film', position: 12.5, duration: 5400, paused: false }));
    await vi.waitFor(() => { expect(tv.msgs.filter((m) => m.t === 'cast' || m.t === 'ctl')).toHaveLength(3); expect(phone.msgs.find((m) => m.t === 'status')).toBeTruthy(); });
    expect(tv.msgs.filter((m) => m.t === 'cast' || m.t === 'ctl')).toEqual([{ t: 'cast', itemId: ITEM, startSec: 90 }, { t: 'ctl', action: 'seekBy', value: -10 }, { t: 'ctl', action: 'next' }]);
    expect(phone.msgs.find((m) => m.t === 'status')).toMatchObject({ title: 'Film', position: 12.5, paused: false });

    tv.ws.close(); await tv.closed;
    await vi.waitFor(() => expect(phone.msgs.at(-1)).toMatchObject({ t: 'peers', tvOnline: false }));
    phone.ws.close();
  });

  it('track lists travel TV -> phone and audio/sub commands phone -> TV, oversize lists are dropped', async () => {
    const tv = await open(await tvSid(), 'tv'); const phone = await open(me.cookies.ff_sid!, 'remote');
    await vi.waitFor(() => expect(phone.msgs.find((m) => m.t === 'hello')).toBeTruthy());
    tv.ws.send(JSON.stringify({ t: 'status', itemId: ITEM, audio: [{ i: 1, t: 'Deutsch' }, { i: 2, t: 'English' }], audioSel: 1, subs: [{ i: 3, t: 'Deutsch' }], subSel: -1 }));
    tv.ws.send(JSON.stringify({ t: 'status', itemId: ITEM, audio: Array.from({ length: 11 }, (_, i) => ({ i, t: 'x' })) })); // too many: rejected
    phone.ws.send(JSON.stringify({ t: 'ctl', action: 'audio', value: 2 }));
    phone.ws.send(JSON.stringify({ t: 'ctl', action: 'sub', value: -1 }));
    await wait(200);
    const st = phone.msgs.filter((m) => m.t === 'status');
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ audioSel: 1, subs: [{ i: 3, t: 'Deutsch' }] });
    expect(tv.msgs.filter((m) => m.t === 'ctl')).toEqual([{ t: 'ctl', action: 'audio', value: 2 }, { t: 'ctl', action: 'sub', value: -1 }]);
    tv.ws.close(); phone.ws.close();
  });

  it('a laptop or phone cannot register as the TV (and so cannot evict the real one)', async () => {
    const tv = await open(await tvSid(), 'tv');
    const fake = await open(me.cookies.ff_sid!, 'tv');
    expect(await fake.closed).toBe(4403);
    await wait();
    expect((await env.app.inject({ url: '/api/tv/status', cookies: me.cookies })).json()).toEqual({ tvOnline: true });
    tv.ws.close();
  });

  it('a revoked TV is disconnected immediately (device removed in the UI)', async () => {
    const c = (await post('/api/tv/code')).json();
    await post('/api/tv/pair', { code: c.code }, me);
    const tvSid = (await post('/api/tv/claim', { code: c.code, pollToken: c.pollToken })).cookies.find((x) => x.name === 'ff_sid')!.value;
    const tv = await open(tvSid, 'tv');
    await wait();
    expect((await env.app.inject({ url: '/api/tv/status', cookies: me.cookies })).json()).toEqual({ tvOnline: true });
    const dev = (await env.pool.query("select device_id from devices where label like 'Fernseher%' order by created_at desc limit 1")).rows[0].device_id;
    await env.app.inject({ method: 'DELETE', url: `/api/devices/${dev}`, cookies: me.cookies, headers: { 'x-csrf-token': me.csrf } });
    expect(await tv.closed).toBe(4401);
    expect((await env.app.inject({ url: '/api/tv/status', cookies: me.cookies })).json()).toEqual({ tvOnline: false });
  });

  it('a TV cannot send commands to phones and never reaches another user\'s devices', async () => {
    const lea = await makeLea();
    const tvMe = await open(await tvSid(), 'tv');
    const phoneLea = await open(lea, 'remote');
    const phoneMe = await open(me.cookies.ff_sid!, 'remote');
    await wait();
    phoneLea.ws.send(JSON.stringify({ t: 'cast', itemId: ITEM }));
    tvMe.ws.send(JSON.stringify({ t: 'cast', itemId: ITEM })); // TVs may only send status
    await wait(200);
    expect(tvMe.msgs.some((m) => m.t === 'cast')).toBe(false); // Lea's cast did not cross over
    expect(phoneMe.msgs.some((m) => m.t === 'cast')).toBe(false);
    expect(phoneLea.msgs.find((m) => m.t === 'hello')).toMatchObject({ tvOnline: false });
    for (const x of [tvMe, phoneLea, phoneMe]) x.ws.close();
  });

  it('requires session and matching Origin; a second TV replaces the first', async () => {
    expect(await (await open('x'.repeat(30), 'remote')).closed).toBe(4401);
    expect(await (await open(me.cookies.ff_sid!, 'remote', 'https://evil.example')).closed).toBe(4401);
    const a = await open(await tvSid(), 'tv');
    const b = await open(await tvSid(), 'tv');
    expect(await a.closed).toBe(4000);
    b.ws.close();
  });
});

async function makeLea() {
  const id = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'lea2', 'l@x.de', 'Lea', 'friend', $1, 'lea2', $2) returning id`,
    ['2'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id;
  const sid = 'lea-session-' + 'y'.repeat(30);
  await env.kv.set(`sess:${sid}`, JSON.stringify({ userId: id, csrf: 'c', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
  return sid;
}
