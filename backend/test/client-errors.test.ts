// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOnly, scrub, toLogEntry } from '../src/clientErrors.js';
import { registry } from '../src/metrics.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
const logged: Array<{ obj: any; msg: string }> = [];

beforeAll(async () => {
  env = await makeEnv();
  // the test logger is off (noop); capture what the route would log
  env.app.addHook('onRequest', async (req) => {
    (req as any).log = { warn: (obj: any, msg: string) => logged.push({ obj, msg }), info() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } };
  });
});
afterAll(() => env.close());

let ipSeq = 0;
const fresh = () => `10.8.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`;
const body = (over: Record<string, unknown> = {}) => ({ message: 'x is not a function', url: '/item/abc', userAgent: 'UA/1', kind: 'error', ...over });
const beacon = (payload: unknown, opts: { ip?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {}) =>
  env.app.inject({ method: 'POST', url: '/api/client-errors', payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { 'content-type': 'text/plain;charset=UTF-8', ...opts.headers }, cookies: opts.cookies, remoteAddress: opts.ip ?? fresh() });

describe('scrub / pathOnly', () => {
  it('keeps only the path of a url', () => {
    expect(pathOnly('https://portal.example.com/search?q=secret&token=abc#frag')).toBe('/search');
    expect(pathOnly('/item/0123456789abcdef0123456789abcdef?x=1')).toBe('/item/0123456789abcdef0123456789abcdef');
    expect(pathOnly('not a url?x=1')).toBe('/not%20a%20url');
  });
  it('removes query strings, tokens, e-mail addresses and long opaque values', () => {
    expect(scrub('GET https://p.example.com/api/x?token=abc123&u=1 failed')).toBe('GET https://p.example.com/api/x?[query] failed');
    expect(scrub('bad token=abcdef012345 here')).toBe('bad token=[redacted] here');
    expect(scrub('user max@example.com crashed')).toBe('user [email] crashed');
    expect(scrub('Authorization: Bearer abc.def-ghi_jkl')).toBe('Authorization: Bearer [redacted]');
    expect(scrub('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig end')).toBe('jwt [jwt] end');
    expect(scrub(`sid ${'A'.repeat(43)} end`)).toBe('sid [token] end');
  });
  it('keeps 32-hex ids, optional chaining and ordinary questions', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(scrub(`failed for item ${id}`)).toBe(`failed for item ${id}`);
    expect(scrub("Cannot read properties of undefined (reading 'x') at a?.b")).toBe("Cannot read properties of undefined (reading 'x') at a?.b");
    expect(scrub('What? No way')).toBe('What? No way');
  });
  it('builds a log entry without query strings anywhere', () => {
    const e = toLogEntry({ message: 'boom\n at /x?token=1', stack: 'Error: boom\n    at https://p/x.js?v=abc:1:2', url: 'https://p/watch/1?t=300', userAgent: 'UA', kind: 'error' });
    expect(e.url).toBe('/watch/1');
    expect(e.message).toBe('boom at /x?[query]');
    expect(JSON.stringify(e)).not.toMatch(/token=1|v=abc|t=300/);
  });
});

describe('POST /api/client-errors', () => {
  it('accepts a sendBeacon style text/plain JSON body, answers 204 and logs a scrubbed structured warning', async () => {
    logged.length = 0;
    const r = await beacon(body({ message: 'fail for a@b.de', url: 'https://portal.example.com/search?q=hallo', stack: 'Error\n at x (https://portal.example.com/a.js?token=zz:1:1)', release: 'abc1234' }));
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.obj.clientError).toEqual({
      kind: 'error', message: 'fail for [email]', url: '/search', userAgent: 'UA/1', release: 'abc1234',
      stack: 'Error\n at x (https://portal.example.com/a.js?[query])',
    });
  });

  it('accepts kind playback with itemId and code and logs them (scrubbed like the rest)', async () => {
    logged.length = 0;
    const id = '0123456789abcdef0123456789abcdef';
    const r = await beacon(body({ kind: 'playback', itemId: id, code: 'MEDIA_ERR_DECODE', message: 'fatal' }));
    expect(r.statusCode).toBe(204);
    expect(logged[0]!.obj.clientError).toMatchObject({ kind: 'playback', itemId: id, code: 'MEDIA_ERR_DECODE' });
    expect((await beacon(body({ kind: 'playback', itemId: id.toUpperCase(), code: 'x' }))).statusCode).toBe(400);
  });

  it('also accepts application/json', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/client-errors', payload: body({ kind: 'resource' }), remoteAddress: fresh() });
    expect(r.statusCode).toBe(204);
  });

  it('needs no session and no csrf token, even when a (stale) session cookie is sent', async () => {
    const me = await env.login();
    expect((await beacon(body())).statusCode).toBe(204);
    expect((await beacon(body(), { cookies: me.cookies })).statusCode).toBe(204);
  });

  it('counts reports per kind in the prometheus registry', async () => {
    await beacon(body({ kind: 'unhandledrejection' }));
    const text = await registry.metrics();
    expect(text).toMatch(/friendflix_client_errors_total\{kind="unhandledrejection"\} [1-9]/);
  });

  it.each([
    ['no body', ''],
    ['not json', '{nope'],
    ['missing message', JSON.stringify({ url: '/', userAgent: 'u', kind: 'error' })],
    ['unknown kind', JSON.stringify(body({ kind: 'warning' }))],
    ['message too long', JSON.stringify(body({ message: 'x'.repeat(501) }))],
    ['stack too long', JSON.stringify(body({ stack: 'x'.repeat(4001) }))],
    ['url too long', JSON.stringify(body({ url: '/' + 'x'.repeat(500) }))],
    ['user agent too long', JSON.stringify(body({ userAgent: 'x'.repeat(301) }))],
    ['release too long', JSON.stringify(body({ release: 'x'.repeat(41) }))],
  ])('rejects %s with 400 and logs nothing', async (_n, payload) => {
    logged.length = 0;
    expect((await beacon(payload)).statusCode).toBe(400);
    expect(logged).toHaveLength(0);
  });

  it('accepts the maximum sizes', async () => {
    const r = await beacon(body({ message: 'm'.repeat(500), stack: 's'.repeat(4000), url: '/' + 'u'.repeat(499), userAgent: 'a'.repeat(300), release: 'r'.repeat(40) }));
    expect(r.statusCode).toBe(204);
  });

  it('refuses a foreign Origin', async () => {
    expect((await beacon(body(), { headers: { origin: 'https://evil.example.org' } })).statusCode).toBe(403);
    expect((await beacon(body(), { headers: { origin: 'https://portal.example.com' } })).statusCode).toBe(204);
  });

  it('rate limits to 20 per minute per IP', async () => {
    const ip = fresh();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await beacon(body(), { ip })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 204)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    // another address is unaffected
    expect((await beacon(body())).statusCode).toBe(204);
  });

  it('caps a single address at 200 reports per hour', async () => {
    const ip = fresh();
    await env.ctx.kv.set(`clienterr:h:ip:${ip}`, '200', 3600);
    expect((await beacon(body(), { ip })).statusCode).toBe(429);
    expect((await beacon(body())).statusCode).toBe(204);
  });

  it('counts the hourly budget per user, not per address, for signed-in browsers', async () => {
    const me = await env.login();
    const uid = JSON.parse((await env.kv.get(`sess:${me.cookies.ff_sid}`))!).userId as string;
    await env.ctx.kv.set(`clienterr:h:u:${uid}`, '200', 3600);
    expect((await beacon(body(), { cookies: me.cookies })).statusCode).toBe(429);
    expect((await beacon(body())).statusCode).toBe(204); // anonymous visitor from elsewhere
  });
});
