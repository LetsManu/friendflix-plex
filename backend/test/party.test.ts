// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PartyRegistry, Room, type ServerMsg } from '../src/party.js';
import { makeEnv, type TestEnv } from './helpers.js';

function clock() {
  const c = { t: 1_000_000 };
  return { c, now: () => c.t };
}
const inbox = () => {
  const msgs: ServerMsg[] = [];
  return { msgs, send: (m: ServerMsg) => void msgs.push(m), last: <T extends ServerMsg['t']>(t: T) => msgs.filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }> | undefined };
};

describe('party engine', () => {
  it('only the host controls playback; position advances with the server clock', () => {
    const { c, now } = clock();
    const room = new Room('r', 'item', 'T', 'host', undefined, now);
    const h = inbox(), g = inbox();
    room.join('host', 'Host', h.send);
    room.join('guest', 'Gast', g.send);
    room.handle('host', { t: 'buffering', value: false });
    room.handle('guest', { t: 'buffering', value: false });
    room.handle('guest', { t: 'state', playing: true, position: 99 }); // ignored
    expect(room.state.playing).toBe(false);
    room.handle('host', { t: 'state', playing: true, position: 10 });
    expect(g.last('state')!.state).toMatchObject({ playing: true, position: 10, hold: false });
    c.t += 5000;
    expect(room.positionNow()).toBeCloseTo(15, 3);
    room.handle('host', { t: 'state', playing: false, position: 15 });
    c.t += 5000;
    expect(room.positionNow()).toBe(15);
  });

  it('host can allow everybody to control playback and switch back', () => {
    const { now } = clock();
    const room = new Room('r', 'item', 'T', 'host', undefined, now);
    const h = inbox(), g = inbox();
    room.join('host', 'Host', h.send);
    room.join('guest', 'Gast', g.send);
    room.handle('host', { t: 'buffering', value: false });
    room.handle('guest', { t: 'buffering', value: false });
    expect(g.last('welcome')!.mode).toBe('host');
    room.handle('guest', { t: 'mode', value: 'everyone' }); // guests cannot change the mode
    expect(room.mode).toBe('host');
    room.handle('host', { t: 'mode', value: 'everyone' });
    expect(g.last('members')!.mode).toBe('everyone');
    room.handle('guest', { t: 'state', playing: true, position: 42 });
    expect(h.last('state')!.state).toMatchObject({ playing: true, position: 42 });
    room.handle('host', { t: 'mode', value: 'host' });
    room.handle('guest', { t: 'state', playing: false, position: 7 });
    expect(room.state.position).toBe(42); // ignored again
  });

  it('waits for the buffer of all participants (hold) and resumes without losing time', () => {
    const { c, now } = clock();
    const room = new Room('r', 'item', 'T', 'host', undefined, now);
    const h = inbox(), g = inbox();
    room.join('host', 'Host', h.send);
    room.handle('host', { t: 'buffering', value: false });
    room.handle('host', { t: 'state', playing: true, position: 0 });
    c.t += 2000; // 2 s played
    room.join('guest', 'Gast', g.send); // joiner starts buffering -> hold
    expect(room.state.hold).toBe(true);
    expect(room.state.position).toBeCloseTo(2, 3);
    c.t += 10_000; // guest buffers for 10 s: position must stay frozen
    expect(room.positionNow()).toBeCloseTo(2, 3);
    room.handle('guest', { t: 'buffering', value: false });
    expect(room.state.hold).toBe(false);
    expect(h.last('state')!.state).toMatchObject({ hold: false, playing: true });
    c.t += 1000;
    expect(room.positionNow()).toBeCloseTo(3, 3);
  });

  it('a leaving buffering member releases the hold; host is handed over', () => {
    const { now } = clock();
    const room = new Room('r', 'item', 'T', 'host', undefined, now);
    const h = inbox(), g = inbox();
    room.join('host', 'Host', h.send);
    room.join('guest', 'Gast', g.send);
    room.handle('host', { t: 'buffering', value: false });
    expect(room.state.hold).toBe(true);
    room.leave('guest');
    expect(room.state.hold).toBe(false);
    room.join('g2', 'G2', g.send);
    room.handle('g2', { t: 'buffering', value: false });
    room.leave('host');
    expect(room.hostId).toBe('g2');
  });

  it('chat is flood-limited, reactions are whitelisted, ping returns server time', () => {
    const { c, now } = clock();
    const room = new Room('r', 'item', 'T', 'host', undefined, now);
    const h = inbox();
    room.join('host', 'Host', h.send);
    for (let i = 0; i < 8; i++) room.handle('host', { t: 'chat', text: `m${i}` });
    expect(h.msgs.filter((m) => m.t === 'chat')).toHaveLength(5);
    c.t += 6000;
    room.handle('host', { t: 'chat', text: 'again' });
    expect(h.msgs.filter((m) => m.t === 'chat')).toHaveLength(6);
    room.handle('host', { t: 'ping', c: 42 });
    expect(h.last('pong')).toEqual({ t: 'pong', c: 42, s: c.t });
  });

  it('live reactions are throttled per member (burst of 5, then one per 700 ms) and reach everybody', () => {
    const { c, now } = clock();
    const room = new Room('r', 'item', 'T', 'host', undefined, now);
    const h = inbox(), g = inbox();
    room.join('host', 'Host', h.send);
    room.join('g2', 'G2', g.send);
    const reacts = (b: ReturnType<typeof inbox>) => b.msgs.filter((m) => m.t === 'react');
    for (let i = 0; i < 9; i++) room.handle('host', { t: 'react', emoji: '😂' });
    expect(reacts(h)).toHaveLength(5);
    expect(reacts(g)).toHaveLength(5); // the sender sees it too, so does everyone else
    expect(g.last('react')).toEqual({ t: 'react', from: 'host', name: 'Host', emoji: '😂' });
    room.handle('g2', { t: 'react', emoji: '🔥' }); // another member has its own bucket
    expect(reacts(h)).toHaveLength(6);
    c.t += 700;
    room.handle('host', { t: 'react', emoji: '😮' });
    room.handle('host', { t: 'react', emoji: '😮' });
    expect(reacts(h)).toHaveLength(7); // only one token refilled
    c.t += 10_000;
    for (let i = 0; i < 9; i++) room.handle('host', { t: 'react', emoji: '❤️' });
    expect(reacts(h)).toHaveLength(12); // refill is capped at the burst size
  });

  it('scheduled rooms auto-start at the countdown end and expire when empty', () => {
    const { c, now } = clock();
    const reg = new PartyRegistry(now);
    const room = reg.create({ id: 'x', itemId: 'i', title: 'T', hostId: 'h', startAt: c.t + 60_000 });
    const m = inbox();
    room.join('h', 'H', m.send);
    room.handle('h', { t: 'buffering', value: false });
    c.t += 30_000; reg.tick();
    expect(room.state.playing).toBe(false);
    c.t += 31_000; reg.tick();
    expect(room.state.playing).toBe(true);
    expect(room.state.position).toBe(0);
    room.leave('h');
    c.t += 11 * 60_000; reg.tick();
    expect(reg.get('x')).toBeUndefined();
  });
});

describe('party websocket', () => {
  let env: TestEnv;
  let port: number;
  let cookie: string;
  const ITEM = 'b'.repeat(32);
  beforeAll(async () => {
    env = await makeEnv({ 'GET /Items/[^/]+': () => ({ json: { Id: ITEM, Name: 'Film', Type: 'Movie' } }) });
    const s = await env.login();
    cookie = `ff_sid=${s.cookies.ff_sid}`;
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    port = (env.app.server.address() as { port: number }).port;
    (env as unknown as { s: typeof s }).s = s;
  });
  afterAll(() => env.close());

  const connect = (id: string, headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket; msgs: any[]; closed: Promise<number> }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/party/${id}`, { headers });
      const msgs: any[] = [];
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve({ ws, msgs, closed }));
      ws.on('error', () => resolve({ ws, msgs, closed }));
      ws.on('unexpected-response', () => resolve({ ws, msgs, closed }));
    });

  it('creates a room via REST, joins with auth + origin check, syncs and chats', async () => {
    const s = (env as unknown as { s: { csrf: string } }).s;
    const created = await env.app.inject({ method: 'POST', url: '/api/party', cookies: { ff_sid: cookie.split('=')[1]! }, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: ITEM } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const bad = await connect(id, { cookie, origin: 'https://evil.example' });
    expect(await bad.closed).toBe(4401);
    const anon = await connect(id, { origin: 'https://portal.example.com' });
    expect(await anon.closed).toBe(4401);

    const ok = await connect(id, { cookie, origin: 'https://portal.example.com' });
    await vi.waitFor(() => expect(ok.msgs[0]).toMatchObject({ t: 'welcome' }));
    expect(ok.msgs[0]).toMatchObject({ t: 'welcome', itemId: ITEM, title: 'Film' });
    ok.ws.send(JSON.stringify({ t: 'buffering', value: false }));
    ok.ws.send(JSON.stringify({ t: 'state', playing: true, position: 5 }));
    ok.ws.send(JSON.stringify({ t: 'chat', text: 'Hallo <b>Welt</b>' }));
    ok.ws.send(JSON.stringify({ t: 'react', emoji: '🔥' }));
    ok.ws.send(JSON.stringify({ t: 'react', emoji: '<script>' })); // rejected by whitelist
    ok.ws.send('not json');
    await vi.waitFor(() => expect(ok.msgs.filter((m) => m.t === 'react')).toHaveLength(1));
    expect(ok.msgs.find((m) => m.t === 'state' && m.state.playing)).toBeTruthy();
    expect(ok.msgs.find((m) => m.t === 'chat').text).toBe('Hallo <b>Welt</b>'); // raw text; UI renders it as text only
    expect(ok.msgs.filter((m) => m.t === 'react')).toHaveLength(1);
    ok.ws.close();
    await ok.closed;
    expect((await connect('nope', { cookie, origin: 'https://portal.example.com' }).then((c) => c.closed))).toBe(4404);
  });
});
