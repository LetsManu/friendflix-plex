// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { announceSetupCode, issueSetupCode, newSetupCode, normalizeCode, setupCodeLogLine, verifySetupCode } from '../src/setup/code.js';
import { isSetupComplete } from '../src/setup/state.js';
import { readMeta, updateMeta } from '../src/settings/repo.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Block 25 Task 11 (spec Part E2): the one-time setup code from the log, its limits, and the setup session it opens.
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
let ipN = 0;
const freshIp = () => `10.11.${Math.floor(++ipN / 250)}.${ipN % 250}`;

describe('setup code format', () => {
  it('newSetupCode: 12 Crockford characters in groups of 4; the hash is sha256 of the normalised code', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newSetupCode();
      expect(c.display).toMatch(CROCKFORD);
      expect(c.hash).toBe(createHash('sha256').update(normalizeCode(c.display)).digest('hex'));
      expect(c.hash).not.toContain(normalizeCode(c.display));
      seen.add(c.display);
    }
    expect(seen.size).toBe(200);
  });

  it('normalizeCode: upper case, no spaces or dashes, O -> 0, I / L -> 1', () => {
    expect(normalizeCode(' k7qm-3xa9 pt2o ')).toBe('K7QM3XA9PT20');
    expect(normalizeCode('IL')).toBe('11');
    expect(normalizeCode('il-o')).toBe('110');
  });

  it('the log line is exact', () => {
    expect(setupCodeLogLine('K7QM-3XA9-PT2D', new Date('2026-10-15T14:03:59Z'))).toBe(
      'FriendFlix setup: open the portal in your browser and enter the setup code K7QM-3XA9-PT2D (valid until 2026-10-15 14:03 UTC). Restart the backend for a new code.');
  });
});

describe('unlock', () => {
  let env: TestEnv;
  const logs: string[] = [];
  let code = '';
  const unlock = (c: string, ip = freshIp()) => env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code: c }, remoteAddress: ip });
  beforeAll(async () => {
    env = await makeEnv({}, { setupComplete: false, logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' } });
  });
  afterAll(() => env.close());
  beforeEach(async () => { code = await issueSetupCode(env.ctx); });

  it('the right code -> 200, ff_setup httpOnly + SameSite=Lax, ff_setup_csrf readable; the session lives in kv by hash', async () => {
    const r = await unlock(code.toLowerCase().replace(/-/g, ' '));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const s = r.cookies.find((c) => c.name === 'ff_setup')!;
    const c = r.cookies.find((x) => x.name === 'ff_setup_csrf')!;
    // Lax: the IdP's cross-site redirect to /auth/callback must carry it (spec E2, review I1); the csrf cookie stays Strict
    expect(s).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(s.secure).toBeFalsy(); // plain http request
    expect(c.httpOnly).toBeFalsy();
    expect(c).toMatchObject({ sameSite: 'Strict', path: '/' });
    expect(c.value).not.toBe(s.value);
    const key = `setup:sess:${createHash('sha256').update(s.value).digest('hex')}`;
    expect(await env.kv.get(key)).not.toBeNull();
    expect(await env.kv.get(`setup:sess:${s.value}`)).toBeNull();
    // the body never carries the code or the token
    expect(r.body).not.toContain(normalizeCode(code));
    expect(r.body).not.toContain(s.value);
  });

  it('cookies are Secure when the request came over https (x-forwarded-proto)', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: freshIp(), headers: { 'x-forwarded-proto': 'https' } });
    expect(r.statusCode).toBe(200);
    expect(r.cookies.find((c) => c.name === 'ff_setup')!.secure).toBe(true);
    expect(r.cookies.find((c) => c.name === 'ff_setup_csrf')!.secure).toBe(true);
  });

  it('a wrong code -> 401 wrong_code and the failure is counted', async () => {
    const r = await unlock('AAAA-BBBB-CCCC');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'wrong_code' });
    expect(r.cookies.find((c) => c.name === 'ff_setup')).toBeUndefined();
    expect((await readMeta(env.pool)).setupCodeFailures).toBe(1);
  });

  it('a malformed or oversized body -> 400 / 401, never 500', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code: 'x'.repeat(500) }, remoteAddress: freshIp() })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: {}, remoteAddress: freshIp() })).statusCode).toBe(400);
    expect((await unlock('')).statusCode).toBe(401);
  });

  it('after 24 h + 1 s -> 410 code_expired', async () => {
    const c = await issueSetupCode(env.ctx, new Date(Date.now() - 24 * 3600_000 - 1000));
    const r = await unlock(c);
    expect(r.statusCode).toBe(410);
    expect(r.json()).toEqual({ error: 'code_expired' });
  });

  it('the 6th attempt from one IP within 15 min -> 429 (even with the right code)', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await unlock('AAAA-BBBB-CCCC', ip)).statusCode).toBe(401);
    expect((await unlock(code, ip)).statusCode).toBe(429);
    expect((await unlock(code)).statusCode).toBe(200); // another IP
  });

  it('10 wrong codes from 10 IPs -> the code is invalidated (logged); the right code then -> 410 code_locked', async () => {
    for (let i = 0; i < 9; i++) expect((await unlock('AAAA-BBBB-CCCC')).statusCode).toBe(401);
    const tenth = await unlock('AAAA-BBBB-CCCC');
    expect(tenth.statusCode).toBe(410);
    expect(tenth.json()).toEqual({ error: 'code_locked' });
    expect((await readMeta(env.pool)).setupCodeHash).toBeNull();
    const r = await unlock(code);
    expect(r.statusCode).toBe(410);
    expect(r.json()).toEqual({ error: 'code_locked' });
    expect(logs.some((l) => l.includes('Too many wrong setup codes; restart the backend for a new code'))).toBe(true);
  });

  it('failures count atomically: concurrent wrong codes all count, the code is cleared exactly at 10', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => verifySetupCode(env.ctx, 'AAAA-BBBB-CCCC', '10.0.0.1')));
    expect(results.filter((r) => r === 'wrong')).toHaveLength(9);
    expect(results.filter((r) => r === 'locked')).toHaveLength(3);
    const m = await readMeta(env.pool);
    expect(m.setupCodeFailures).toBe(10);
    expect(m.setupCodeHash).toBeNull();
  });

  it('issueSetupCode twice -> only the second code works; a session opened with the first stays valid', async () => {
    const first = code;
    const s1 = await unlock(first);
    expect(s1.statusCode).toBe(200);
    const second = await issueSetupCode(env.ctx);
    expect((await unlock(first)).statusCode).toBe(401);
    expect((await unlock(second)).statusCode).toBe(200);
    const cookies = { ff_setup: s1.cookies.find((c) => c.name === 'ff_setup')!.value };
    const state = await env.app.inject({ url: '/api/setup/state', cookies });
    expect(state.json().unlocked).toBe(true);
  });

  it('the setup session slides: a request refreshes its TTL', async () => {
    const r = await unlock(code);
    const token = r.cookies.find((c) => c.name === 'ff_setup')!.value;
    const key = `setup:sess:${createHash('sha256').update(token).digest('hex')}`;
    await env.kv.set(key, (await env.kv.get(key))!, 5);
    await env.app.inject({ url: '/api/setup/state', cookies: { ff_setup: token } });
    // MemoryKV keeps the expiry privately: a 5 s TTL would be gone after 6 s, a refreshed 7200 s one is not
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6000;
      expect(await env.kv.get(key)).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('no code issued yet (no instance with BACKGROUND_JOBS=true) -> 410 no_code, distinct from a lockout', async () => {
    await updateMeta(env.pool, { setupCodeHash: null, setupCodeFailures: 0 });
    const r = await unlock('AAAA-BBBB-CCCC');
    expect(r.statusCode).toBe(410);
    expect(r.json()).toEqual({ error: 'no_code' });
    await updateMeta(env.pool, { setupCodeFailures: 10 });
    expect((await unlock('AAAA-BBBB-CCCC')).json()).toEqual({ error: 'code_locked' });
  });

  it('once setup is complete: unlock -> 409 setup_complete, and verifySetupCode says complete', async () => {
    await updateMeta(env.pool, { setupCompletedAt: new Date() });
    await env.ctx.settings.reload();
    expect(await isSetupComplete(env.ctx)).toBe(true);
    const r = await unlock(code);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'setup_complete' });
    expect(await verifySetupCode(env.ctx, code, '10.0.0.2')).toBe('complete');
    await updateMeta(env.pool, { setupCompletedAt: null });
    await env.ctx.settings.reload();
  });

  it('the code reaches the log once, in the exact line; no other line (requests, failures) contains it', async () => {
    logs.length = 0;
    const before = env.ctx.cfg;
    env.ctx.cfg = { ...before, BACKGROUND_JOBS: 'true' };
    const shown = await announceSetupCode(env.ctx, env.app.log).finally(() => { env.ctx.cfg = before; });
    expect(shown).toMatch(CROCKFORD);
    const expires = (await readMeta(env.pool)).setupCodeExpiresAt!;
    await unlock('AAAA-BBBB-CCCC');
    await unlock(shown!);
    await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: `{"code":"${shown}"`, headers: { 'content-type': 'application/json' }, remoteAddress: freshIp() });
    const norm = normalizeCode(shown!);
    const withCode = logs.filter((l) => l.includes(shown!) || l.includes(norm));
    expect(withCode).toHaveLength(1);
    const line = JSON.parse(withCode[0]!) as { msg: string; level: number };
    expect(line.level).toBe(40); // warn
    expect(line.msg).toBe(setupCodeLogLine(shown!, expires));
    expect(line.msg).toContain(expires.toISOString().slice(0, 16).replace('T', ' '));
  });
});

describe('announceSetupCode', () => {
  let env: TestEnv;
  const warns: string[] = [];
  const log = { warn: (m: string) => { warns.push(m); } };
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  it('only with BACKGROUND_JOBS=true and setup incomplete; every start replaces the code', async () => {
    expect(await announceSetupCode(env.ctx, log)).toBeNull(); // test config: BACKGROUND_JOBS=false
    expect((await readMeta(env.pool)).setupCodeHash).toBeNull();
    env.ctx.cfg = { ...env.ctx.cfg, BACKGROUND_JOBS: 'true' };
    const a = await announceSetupCode(env.ctx, log, new Date('2026-10-15T12:00:00Z'));
    const m = await readMeta(env.pool);
    expect(m.setupCodeExpiresAt).toEqual(new Date('2026-10-16T12:00:00Z'));
    expect(m.setupCodeFailures).toBe(0);
    expect(warns).toEqual([setupCodeLogLine(a!, new Date('2026-10-16T12:00:00Z'))]);
    const b = await announceSetupCode(env.ctx, log);
    expect(b).not.toBe(a);
    expect((await readMeta(env.pool)).setupCodeHash).toBe(newHash(b!));
    await updateMeta(env.pool, { setupCompletedAt: new Date() });
    await env.ctx.settings.reload();
    expect(await announceSetupCode(env.ctx, log)).toBeNull();
    expect(warns).toHaveLength(2);
  });
});

const newHash = (display: string) => createHash('sha256').update(normalizeCode(display)).digest('hex');
