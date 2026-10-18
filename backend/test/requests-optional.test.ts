// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot } from '../src/health.js';
import { approvePoll, createPoll, resolveRequestedPolls } from '../src/polls.js';
import { requestsEnabled, SeerrClient } from '../src/seerr/client.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let adminId = '';

beforeAll(async () => {
  env = await makeEnv({}, { seerr: { 'GET /api/v1/request/count': () => ({ json: { pending: 1, approved: 0, processing: 0, available: 0, declined: 0, total: 1 } }) } });
  admin = await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where role='admin' limit 1")).rows[0]!.id;
});
afterAll(() => env.close());

const call = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });
const features = async () => (await call('GET', '/api/me')).json().features;
const disable = (keys: Record<string, null> = { REQUESTS_URL: null }) => env.ctx.settings.save(keys, null);
const restore = () => env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL, REQUESTS_API_KEY: cfg.REQUESTS_API_KEY }, null);
const calls = () => env.seerrCalls.length + env.jfCalls.length;

describe('request service optional', () => {
  it('/api/me features.requests is true with URL and key', async () => {
    expect(env.ctx.seerr).toBeInstanceOf(SeerrClient);
    expect(requestsEnabled(env.ctx)).toBe(true);
    expect(await features()).toEqual({ requests: true, postplay: true });
  });

  it('either key empty: ctx.seerr is null and /api/me features.requests is false; saving both again brings it back', async () => {
    try {
      await disable();
      expect(env.ctx.seerr).toBeNull();
      expect(requestsEnabled(env.ctx)).toBe(false);
      expect(await features()).toEqual({ requests: false, postplay: true });
      await restore();
      expect(requestsEnabled(env.ctx)).toBe(true);
      await disable({ REQUESTS_API_KEY: null });
      expect(env.ctx.seerr).toBeNull();
    } finally {
      await restore();
    }
    expect(env.ctx.seerr).toBeInstanceOf(SeerrClient);
  });

  it('no REQUESTS_URL: request routes answer 404 requests_disabled without calling anything', async () => {
    try {
      await disable();
      const before = env.seerrCalls.length;
      for (const [method, url, body] of [
        ['GET', '/api/requests/mine'], ['GET', '/api/requests/quota'], ['POST', '/api/requests', { mediaType: 'movie', tmdbId: 1 }],
        ['GET', '/api/seerr/search?q=dune'], ['GET', '/api/seerr/movie/1/status'], ['GET', '/api/seerr/movie/1/trailer'], ['GET', '/api/seerr/upcoming?type=movie'],
        ['GET', '/api/admin/requests'], ['POST', '/api/admin/requests/1/approve'], ['POST', '/api/reminders', { mediaType: 'movie', tmdbId: 1 }],
      ] as const) {
        const r = await call(method, url, body);
        expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([404, { error: 'requests_disabled' }]);
      }
      expect(env.seerrCalls.length).toBe(before);
    } finally {
      await restore();
    }
  });

  it('admin summary and the user detail page work without the request service', async () => {
    try {
      await disable();
      const s = await call('GET', '/api/admin/summary');
      expect(s.statusCode).toBe(200);
      expect(s.json()).toMatchObject({ pending: { requests: null }, requests: null });
      await env.pool.query('update users set seerr_user_id=7 where id=$1', [adminId]);
      const before = env.seerrCalls.length;
      const d = await call('GET', `/api/admin/users/${adminId}`);
      expect(d.statusCode).toBe(200);
      expect(d.json().linked.requests).toEqual({ ok: null, id: 7 }); // unknown, nothing to repair
      const r = await call('POST', `/api/admin/users/${adminId}/repair`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, requests: { ok: null } }); // no partial failure because of the missing service
      expect(env.seerrCalls.length).toBe(before);
    } finally {
      await env.pool.query('update users set seerr_user_id=null where id=$1', [adminId]);
      await restore();
    }
  });

  it('the health light reads "off / not set up", never "down"', async () => {
    const http = (async () => new Response('{}')) as unknown as typeof fetch;
    try {
      await disable();
      const s = await buildSnapshot(env.ctx, { fetchImpl: http });
      expect(s.services.find((x) => x.id === 'requests')).toEqual({ id: 'requests', level: 'off', reason: 'not_set' });
    } finally {
      await restore();
    }
  });

  it('resolveRequestedPolls with requests disabled makes no HTTP call', async () => {
    const id = randomUUID();
    await env.pool.query("insert into polls(id,title,created_by,closes_at,starts_at,status) values ($1,'p',$2,now(),now(),'requested')", [id, adminId]);
    await env.pool.query("insert into poll_options(poll_id,tmdb_id,media_type,title) values ($1,5,'movie','x')", [id]);
    await env.pool.query('update polls set winner_option_id=(select id from poll_options where poll_id=$1) where id=$1', [id]);
    try {
      await disable();
      const before = calls();
      await resolveRequestedPolls(env.ctx);
      expect(calls()).toBe(before);
      expect((await env.pool.query('select status from polls where id=$1', [id])).rows[0].status).toBe('requested');
    } finally {
      await restore();
      await env.pool.query('delete from polls where id=$1', [id]);
    }
  });

  it('polls: a wish option is refused and an approval answers requests_disabled without touching the poll', async () => {
    const id = randomUUID();
    await env.pool.query("insert into polls(id,title,created_by,closes_at,starts_at,status) values ($1,'p',$2,now(),now(),'needs_approval')", [id, adminId]);
    await env.pool.query("insert into poll_options(poll_id,tmdb_id,media_type,title) values ($1,5,'movie','x')", [id]);
    await env.pool.query('update polls set winner_option_id=(select id from poll_options where poll_id=$1) where id=$1', [id]);
    try {
      await disable();
      await expect(createPoll(env.ctx, adminId, { title: 'Wish', options: [{ tmdbId: 1, mediaType: 'movie' }, { tmdbId: 2, mediaType: 'movie' }], closesInMinutes: 60, startsAfterMinutes: 0 }))
        .rejects.toThrow('wish options need the request service');
      const r = await call('POST', `/api/admin/polls/${id}/approve`);
      expect([r.statusCode, r.json()]).toEqual([404, { error: 'requests_disabled' }]);
      expect((await env.pool.query('select status from polls where id=$1', [id])).rows[0].status).toBe('needs_approval');
      expect(await approvePoll(env.ctx, id, adminId, false)).toBe(true); // rejecting still works
    } finally {
      await restore();
      await env.pool.query('delete from polls where id=$1', [id]);
    }
  });

  it('webhooks without WEBHOOK_SECRET still answer 403 when the request service is off', async () => {
    try {
      await disable();
      env.ctx.cfg = { ...env.ctx.cfg, WEBHOOK_SECRET: '' };
      expect((await env.app.inject({ method: 'POST', url: '/internal/webhook/requests', payload: {} })).statusCode).toBe(403);
    } finally {
      env.ctx.cfg = { ...env.ctx.cfg, WEBHOOK_SECRET: cfg.WEBHOOK_SECRET };
      await restore();
    }
  });
});
