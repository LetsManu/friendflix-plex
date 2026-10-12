import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { audit } from '../src/audit.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let seerrUp = true;
let bobId = '';

beforeAll(async () => {
  env = await makeEnv({}, {
    seerr: { 'GET /api/v1/request/count': () => (seerrUp ? { json: { total: 9, movie: 5, tv: 4, pending: 2, approved: 3, declined: 1, processing: 1, available: 2 } } : { status: 503 }) },
  });
  admin = await env.login();
  bobId = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, disabled, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'bob', 'b@x.de', 'Bob', 'guest', true, $1, 'bob', $2) returning id`,
    ['1'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id;
  await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1, 'dev-pending-00000000001', 'TV', false)", [bobId]);
  await env.pool.query("insert into preview_clips(item_id, status, bytes) values ($1,'ok',1000), ($2,'ok',500), ($3,'failed',null)", ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]);
  await audit(env.ctx, null, 'user.disable', bobId);
});
afterAll(() => env.close());

describe('GET /api/admin/summary', () => {
  it('returns counts for the shell badges and the overview', async () => {
    const r = await env.app.inject({ url: '/api/admin/summary', cookies: admin.cookies });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.users).toEqual({ total: 2, active: 1, locked: 1 });
    expect(j.pending).toEqual({ requests: 2, devices: 1, polls: 0, invites: 0, previewsFailed: 1 });
    expect(j.requests).toEqual({ pending: 2, approved: 3, processing: 1, available: 2, declined: 1, total: 9 });
    expect(j.storage).toMatchObject({ downloadsBytes: 0, previewBytes: 1500, previewClips: 2 });
    expect(typeof j.storage.downloadsMaxBytes).toBe('number');
    expect(j.services).toEqual({ jellyfin: true, seerr: true });
    expect(j.playbackCheck).toBeNull();
    expect(j.live).toEqual({ streams: 0, partyRooms: 0 });
  });

  it('survives an unreachable Seerr (requests unknown, not an error)', async () => {
    seerrUp = false;
    const j = (await env.app.inject({ url: '/api/admin/summary', cookies: admin.cookies })).json();
    seerrUp = true;
    expect(j.pending.requests).toBeNull();
    expect(j.requests).toBeNull();
    expect(j.services.seerr).toBe(false);
    expect(j.pending.devices).toBe(1);
  });

  it('is admin only', async () => {
    await env.kv.set(`sess:bob-session-${'x'.repeat(30)}`, JSON.stringify({ userId: bobId, csrf: 'c', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
    await env.pool.query('update users set disabled=false where id=$1', [bobId]);
    const r = await env.app.inject({ url: '/api/admin/summary', cookies: { ff_sid: `bob-session-${'x'.repeat(30)}` } });
    expect(r.statusCode).toBe(403);
    await env.pool.query('update users set disabled=true where id=$1', [bobId]);
  });
});

describe('GET /api/admin/audit', () => {
  it('names the target user', async () => {
    const j = (await env.app.inject({ url: '/api/admin/audit', cookies: admin.cookies })).json();
    const e = j.entries.find((x: any) => x.action === 'user.disable');
    expect(e).toMatchObject({ target: bobId, target_name: 'Bob', actor: null });
  });
});
