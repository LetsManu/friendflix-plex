import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPreviewAudio, previews } from '../src/previews.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const A = 'a'.repeat(32); // ok clip
const B = 'b'.repeat(32); // failed clip
const C = 'c'.repeat(32); // no row
const D = 'd'.repeat(32); // row ok but file gone
const LIB = [[A, 'Alpha', 'Movie'], [B, 'Beta', 'Series'], [C, 'Gamma', 'Movie'], [D, 'Delta', 'Movie']];

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let dir: string;
const post = (url: string, payload?: unknown) => env.app.inject({ method: 'POST', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: payload as object });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-adminprev-'));
  env = await makeEnv({
    'GET /Items': () => ({ json: { Items: LIB.map(([Id, Name, Type]) => ({ Id, Name, Type, UserData: {} })), TotalRecordCount: LIB.length } }),
    'GET /Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/').pop(), Name: 'T', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} } }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/').pop(), Name: 'T', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} } }),
    'GET /Items/[^/]+/LocalTrailers': () => ({ json: [] }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ status: 500 }), // regeneration just fails again
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  }, { ctxPatch: (c) => { c.cfg = { ...c.cfg, PREVIEW_DIR: dir }; } });
  admin = await env.login();
  writeFileSync(join(dir, `${A}.mp4`), Buffer.alloc(100));
  await env.pool.query("insert into preview_clips(item_id, status, bytes) values ($1,'ok',100), ($2,'ok',50)", [A, D]);
  await env.pool.query("insert into preview_clips(item_id, status, error) values ($1,'failed','Jellyfin x -> 500'), ('e'||repeat('0',31),'failed','not in library')", [B]);
});
afterAll(() => env.close());

describe('admin previews', () => {
  it('merges library items with clip rows', async () => {
    const r = await env.app.inject({ url: '/api/admin/previews', cookies: admin.cookies });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.summary).toEqual({ total: 4, ok: 1, failed: 1, missing: 2, preparing: 0, totalBytes: 100 });
    const by = Object.fromEntries(j.items.map((i: any) => [i.itemId, i]));
    expect(by[A]).toMatchObject({ name: 'Alpha', type: 'Movie', status: 'ok', bytes: 100, error: null });
    expect(by[B]).toMatchObject({ type: 'Series', status: 'failed', error: 'Jellyfin x -> 500' });
    expect(by[C]).toMatchObject({ status: 'missing', createdAt: null });
    expect(by[D].status).toBe('missing');
  });

  it('is admin only', async () => {
    const id = (await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'bob', 'b@x.de', 'Bob', 'guest', $1, 'bob', $2) returning id`,
      ['1'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
    )).rows[0].id;
    await env.kv.set(`sess:bob-session-${'x'.repeat(30)}`, JSON.stringify({ userId: id, csrf: 'bobcsrf', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
    const bob = { cookies: { ff_sid: `bob-session-${'x'.repeat(30)}` }, csrf: 'bobcsrf' };
    expect((await env.app.inject({ url: '/api/admin/previews', cookies: bob.cookies })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'POST', url: '/api/admin/previews/regenerate-failed', cookies: bob.cookies, headers: { 'x-csrf-token': bob.csrf } })).statusCode).toBe(403);
  });

  it('regenerate-failed re-queues failed items', async () => {
    const r = await post('/api/admin/previews/regenerate-failed');
    expect(r.json()).toEqual({ ok: true, count: 2 });
    await previews(env.ctx).whenIdle();
    const row = (await env.pool.query('select status, created_at > now() - interval \'1 minute\' as fresh from preview_clips where item_id = $1', [B])).rows[0];
    expect(row).toEqual({ status: 'failed', fresh: true }); // regenerated (and failed again: PlaybackInfo mock answers 500)
    expect(env.jfCalls.filter((c) => c.method === 'POST' && c.path.endsWith('/PlaybackInfo')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('pickPreviewAudio', () => {
  const t = (language: string | undefined, isDefault = false) => ({ language, isDefault });
  it('prefers German, then English, then default, then first', () => {
    expect(pickPreviewAudio([t('eng'), t('GER')])).toEqual(t('GER'));
    expect(pickPreviewAudio([t('spa', true), t('en')])).toEqual(t('en'));
    expect(pickPreviewAudio([t('jpn'), t('kor', true)])).toEqual(t('kor', true));
    expect(pickPreviewAudio([t('jpn')])).toEqual(t('jpn'));
    expect(pickPreviewAudio([t('fra'), t(undefined)])).toEqual(t('fra'));
    expect(pickPreviewAudio([])).toBeUndefined();
  });
});
