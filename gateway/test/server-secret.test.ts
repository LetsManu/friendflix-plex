// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalSecret, need, optional } from '../src/env.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ff-gw-secret-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gateway INTERNAL_SECRET', () => {
  it('falls back to the bootstrap volume file when neither INTERNAL_SECRET nor INTERNAL_SECRET_FILE is set', () => {
    writeFileSync(join(dir, 'internal_secret'), `${'b'.repeat(64)}\n`);
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toBe('b'.repeat(64));
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: '' })).toBe('b'.repeat(64)); // compose passes ${VAR:-}
  });

  it('strips only the trailing newlines from the volume file (the writer\'s contract), not other whitespace', () => {
    writeFileSync(join(dir, 'internal_secret'), ` ${'b'.repeat(32)} \r\n`);
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toBe(` ${'b'.repeat(32)} `);
    writeFileSync(join(dir, 'internal_secret'), `${'b'.repeat(32)}\n\r\n\n`);
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toBe('b'.repeat(32));
  });

  it('env and VAR_FILE win over the volume file', () => {
    writeFileSync(join(dir, 'internal_secret'), 'b'.repeat(64));
    writeFileSync(join(dir, 'secret_file'), 'f'.repeat(32));
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: 'e'.repeat(32) })).toBe('e'.repeat(32));
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: 'e'.repeat(32), INTERNAL_SECRET_FILE: join(dir, 'secret_file') }))
      .toBe('f'.repeat(32));
  });

  it('without env and file it fails naming the file and the fix', () => {
    expect(() => internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toThrow(
      `missing env INTERNAL_SECRET and bootstrap file ${join(dir, 'internal_secret')}: start the stack with docker compose up (the bootstrap service creates it)`);
  });

  it('an unreadable volume file is an error naming the file', () => {
    mkdirSync(join(dir, 'internal_secret')); // EISDIR stands in for EACCES (the tests may run as root)
    expect(() => internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toThrow(`bootstrap file ${join(dir, 'internal_secret')} is not readable (EISDIR)`);
  });

  it('need reads VAR or VAR_FILE and refuses an unset value', () => {
    writeFileSync(join(dir, 'u'), ' http://jf:8096 \n');
    expect(need({ JELLYFIN_URL_FILE: join(dir, 'u') }, 'JELLYFIN_URL')).toBe('http://jf:8096');
    expect(need({ BACKEND_URL: 'http://backend:3000' }, 'BACKEND_URL')).toBe('http://backend:3000');
    expect(() => need({}, 'JELLYFIN_URL')).toThrow('missing env JELLYFIN_URL');
  });

  it('optional reads VAR or VAR_FILE; unset or empty is undefined (the URL then comes from the backend)', () => {
    writeFileSync(join(dir, 'u'), 'http://jf:8096\n');
    expect(optional({ JELLYFIN_URL_FILE: join(dir, 'u') }, 'JELLYFIN_URL')).toBe('http://jf:8096');
    expect(optional({ JELLYFIN_URL: 'http://jf:8096' }, 'JELLYFIN_URL')).toBe('http://jf:8096');
    expect(optional({ JELLYFIN_URL: '' }, 'JELLYFIN_URL')).toBeUndefined();
    expect(optional({}, 'JELLYFIN_URL')).toBeUndefined();
  });
});

/**
 * fork: server.ts itself on a no-.env Plex install (MEDIA_SERVER=plex, no PLEX_URL / PLEX_TOKEN / INTERNAL_SECRET in env): it starts,
 * reads the secret from the bootstrap volume, answers /health 200 and /media 503 until the backend has the setup, then sends the
 * backend's token to Plex. Nothing it logs or answers contains the token.
 */
describe('server.ts on Plex with settings in the database', () => {
  const TOKEN = 'server-remote-plex-token-POIUYT-246810';
  const SECRET = 'bootstrap-internal-secret-0123456789abcdef';
  const KEYS = ['MEDIA_SERVER', 'PLEX_URL', 'PLEX_URL_FILE', 'PLEX_TOKEN', 'PLEX_TOKEN_FILE', 'INTERNAL_SECRET', 'INTERNAL_SECRET_FILE', 'FF_GATEWAY_BOOTSTRAP_DIR', 'BACKEND_URL', 'PORT', 'DOWNLOAD_DIR', 'METRICS_TOKEN'];
  const saved: Record<string, string | undefined> = {};
  const servers: Server[] = [];
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(async () => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  });

  async function boot(backendToken: () => string | null) {
    const plexSeen: Array<{ url: string; token: unknown }> = [];
    const plex = createServer((req, res) => {
      plexSeen.push({ url: req.url!, token: req.headers['x-plex-token'] });
      // trickplay: an error page that quotes the token (server.ts must wire plexOpaqueErrors)
      if (req.url!.includes('/indexes/sd/')) return void res.writeHead(401, { 'content-type': 'text/html', 'x-plex-token': String(req.headers['x-plex-token']) }).end(`<html>401 ${String(req.headers['x-plex-token'])}</html>`);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'x-plex-token': String(req.headers['x-plex-token']) }).end('JPEG');
    });
    const plexPort = await listen(plex);
    const secrets: unknown[] = [];
    const be = createServer((req, res) => {
      secrets.push(req.headers['x-internal-secret']);
      const json = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json', 'x-ff-config-rev': '1' }).end(JSON.stringify(o));
      if (req.headers['x-internal-secret'] !== SECRET) return json({ error: 'forbidden' }, 403);
      if (req.url === '/internal/gateway-config') {
        const t = backendToken();
        return t ? json({ rev: 1, upstreamUrl: `http://127.0.0.1:${plexPort}`, upstreamAuth: { PLEX_TOKEN: t } }) : json({ error: 'setup_required' }, 503);
      }
      req.resume();
      req.on('end', () => (req.url === '/internal/authz/item' ? json({ allow: true }) : json({ userId: 'u1', token: 'p-identity', deviceId: 'ff-u1', maxBitrate: 8_000_000, canDownload: true })));
    });
    const bePort = await listen(be);
    servers.push(plex, be);
    const boot = mkdtempSync(join(tmpdir(), 'ff-gw-boot-'));
    writeFileSync(join(boot, 'internal_secret'), `${SECRET}\n`);
    Object.assign(process.env, { MEDIA_SERVER: 'plex', BACKEND_URL: `http://127.0.0.1:${bePort}`, FF_GATEWAY_BOOTSTRAP_DIR: boot, PORT: '0' });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    // server.ts listens on PORT (0) on all interfaces: capture its server to learn the port and close it afterwards
    const started: Server[] = [];
    const listenOrig = Server.prototype.listen;
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
      started.push(this);
      return (listenOrig as (...a: unknown[]) => Server).apply(this, args);
    });
    vi.resetModules();
    await import('../src/server.js');
    expect(started).toHaveLength(1);
    const gw = started[0]!;
    servers.push(gw);
    await new Promise<void>((r) => (gw.listening ? r() : gw.once('listening', () => r())));
    const port = (gw.address() as AddressInfo).port;
    const responses: string[] = [];
    const get = async (p: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie: 'ff_sid=goodsid-goodsid-goodsid-1' } });
      responses.push(`${r.status}\n${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await r.clone().text()}`);
      return r;
    };
    return { get, plexSeen, secrets, logs, responses };
  }
  const IMG = `/media/Items/9f1e0000000000000000000000000001/Images/Primary`;
  /** a trickplay frame signed with SECRET (same HMAC as backend/src/plex/mediapaths.ts) */
  const ITEM = '9f1e0000000000000000000000000001';
  const PART = '9f1e3000000000000000000000000001';
  const TRICK = `/media/Videos/${ITEM}/${PART}/Trickplay/2000/1.jpg?sig=${createHmac('sha256', SECRET).update(`friendflix-plex|tp|${ITEM}|${PART}`).digest('hex').slice(0, 32)}`;

  it('before setup: starts (validatePlexEnv accepts remote mode), /health 200, /media 503, the bootstrap secret is used', async () => {
    const g = await boot(() => null);
    expect((await g.get('/health')).status).toBe(200);
    for (let i = 0; i < 50 && !g.secrets.length; i++) await new Promise((d) => setTimeout(d, 10));
    expect(g.secrets[0]).toBe(SECRET);
    const r = await g.get(IMG);
    expect([r.status, r.headers.get('retry-after')]).toEqual([503, '5']);
    expect(g.plexSeen).toEqual([]);
    expect(g.logs.join('\n')).toContain('/media answers 503 until the media server is set up');
  });

  it('after setup: the backend\'s token is sent to Plex as a header only; never in a response or a log line', async () => {
    const g = await boot(() => TOKEN);
    let r = await g.get(IMG);
    for (let i = 0; i < 100 && r.status === 503; i++) {
      await new Promise((d) => setTimeout(d, 10));
      r = await g.get(IMG);
    }
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('JPEG');
    expect(g.plexSeen.length).toBeGreaterThan(0);
    expect(g.plexSeen.every((x) => x.token === TOKEN && !x.url.includes(TOKEN))).toBe(true);
    for (const p of ['/health', '/metrics', `${IMG}?X-Plex-Token=${TOKEN}`, '/media/nope']) await g.get(p);
    const trick = await g.get(TRICK);
    expect([trick.status, await trick.text()]).toEqual([401, 'upstream error']);
    expect(g.plexSeen.at(-1)!.url).toContain('/indexes/sd/'); // it did reach Plex
    const logs = g.logs.join('\n');
    expect(logs).toContain('gateway listening on :0');
    expect(logs).toContain('PLEX_TOKEN received');
    for (const text of [...g.responses, logs]) expect(text).not.toContain(TOKEN);
  });
});
