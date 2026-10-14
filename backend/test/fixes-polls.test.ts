// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvePoll, closeDuePolls, resolveRequestedPolls } from '../src/polls.js';
import { parties } from '../src/routes/party.js';
import { makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32), MISSING = '9'.repeat(32);
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let userId = '';
let failRequest = false;
let jfId = '';

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => { const id = u.pathname.split('/').pop()!; return id === MISSING ? { status: 404 } : { json: { Id: id, Name: 'Ashfall', Type: 'Movie' } }; },
    'GET /Items': (u) => ({ json: { Items: u.search.includes('tmdb.1') ? [{ Id: 'd'.repeat(32), Name: 'Dunmoor' }] : [] } }),
  }, {
    seerr: {
      'GET /api/v1/user': () => ({ json: { results: [{ id: 9, jellyfinUserId: jfId }] } }),
      'POST /api/v1/user/import-from-jellyfin': () => ({ json: [{ id: 9 }] }),
      'POST /api/v1/request': () => (failRequest ? { status: 500, json: {} } : { json: { id: 77 } }),
      'POST /api/v1/request/77/approve': () => ({ json: {} }),
    },
  });
  admin = await env.login();
  const u = (await env.pool.query('select id, jellyfin_user_id from users limit 1')).rows[0];
  userId = u.id;
  jfId = u.jellyfin_user_id;
});
afterAll(() => env.close());
const call = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

async function mkPoll(status: string, opts: { jf?: string; tmdb?: number } = {}) {
  const id = randomUUID();
  await env.pool.query("insert into polls(id,title,created_by,closes_at,starts_at,status) values ($1,'T',$2, now() - interval '1 minute', now() + interval '1 hour', $3)", [id, userId, status]);
  const o = (await env.pool.query('insert into poll_options(poll_id,jf_item_id,tmdb_id,media_type,title) values ($1,$2,$3,$4,$5) returning id', [id, opts.jf ?? null, opts.tmdb ?? null, opts.tmdb ? 'movie' : null, 'Film'])).rows[0].id;
  return { id, option: o as number };
}

describe('atomic poll transitions', () => {
  it('concurrent closeDuePolls create one room', async () => {
    const { id, option } = await mkPoll('open', { jf: A });
    await env.pool.query('insert into poll_votes(poll_id,user_id,option_id) values ($1,$2,$3)', [id, userId, option]);
    const before = parties.rooms.size;
    await Promise.all([closeDuePolls(env.ctx), closeDuePolls(env.ctx), closeDuePolls(env.ctx)]);
    expect(parties.rooms.size).toBe(before + 1);
    const p = (await env.pool.query('select * from polls where id=$1', [id])).rows[0];
    expect(p.status).toBe('scheduled');
    expect(parties.get(p.room_id)).toBeTruthy();
  });

  it('concurrent resolveRequestedPolls create one room', async () => {
    const { id } = await mkPoll('requested', { tmdb: 1 });
    await env.pool.query('update polls set winner_option_id=(select id from poll_options where poll_id=$1) where id=$1', [id]);
    const before = parties.rooms.size;
    await Promise.all([resolveRequestedPolls(env.ctx), resolveRequestedPolls(env.ctx)]);
    expect(parties.rooms.size).toBe(before + 1);
    expect((await env.pool.query('select status from polls where id=$1', [id])).rows[0].status).toBe('scheduled');
  });

  it('concurrent approvals make one seerr request; failure reverts claim and maps to 502', async () => {
    const { id, option } = await mkPoll('needs_approval', { tmdb: 2 });
    await env.pool.query('update polls set winner_option_id=$1 where id=$2', [option, id]);
    const n = () => env.seerrCalls.filter((c) => c.method === 'POST' && c.path === '/api/v1/request').length;
    failRequest = true;
    expect((await call('POST', `/api/admin/polls/${id}/approve`)).statusCode).toBe(502);
    expect((await env.pool.query('select status from polls where id=$1', [id])).rows[0].status).toBe('needs_approval');
    failRequest = false;
    const base = n();
    const res = await Promise.all([approvePoll(env.ctx, id, userId, true), approvePoll(env.ctx, id, userId, true)]);
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(n() - base).toBe(1);
    expect((await call('POST', `/api/admin/polls/${id}/approve`)).statusCode).toBe(409);
  });
});

describe('item lookups and options', () => {
  it('rating / follow on unknown item -> 404', async () => {
    expect((await call('PUT', `/api/items/${MISSING}/rating`, { stars: 3 })).statusCode).toBe(404);
    expect((await call('POST', `/api/series/${MISSING}/follow`)).statusCode).toBe(404);
  });
  it('duplicate options are deduped; unknown option -> 400', async () => {
    await env.pool.query("update polls set status='started'");
    const r = await call('POST', '/api/polls', { title: 'Dupes', options: [{ jfItemId: A }, { jfItemId: A }, { jfItemId: 'b'.repeat(32) }] });
    expect(r.statusCode).toBe(200);
    expect((await call('GET', `/api/polls/${r.json().id}`)).json().options).toHaveLength(2);
    await env.pool.query("update polls set status='started'");
    expect((await call('POST', '/api/polls', { title: 'Bad', options: [{ jfItemId: MISSING }, { jfItemId: A }] })).statusCode).toBe(400);
    const one = await call('POST', '/api/polls', { title: 'Same', options: [{ jfItemId: A }, { jfItemId: A }] });
    expect(one.statusCode).toBe(400);
    expect(one.json().error).toBe('invalid_options');
  });
});
