// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const SER_A = hex(10), EP_A1 = hex(11), EP_A2 = hex(12), MOV_B = hex(20), MOV_C = hex(30), MOV_D = hex(40), MOV_OLD = hex(50), MOV_SHORT = hex(60), HID = hex(70), MOV_ME = hex(80);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const uid: Record<string, string> = {};

async function mk(name: string, n: number, disabled = false, share = true) {
  uid[name] = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, disabled) values (gen_random_uuid(), $1, $2, $1, 'friend', $3, $1, $4, $5) returning id`,
    [name, `${name}@x.de`, hex(100 + n), encrypt(env.ctx.encKey, 'pw'), disabled],
  )).rows[0].id;
  if (share) await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareHistory": true}')`, [uid[name]]);
}
const play = (name: string, item: string, seconds: number, daysAgo = 0) =>
  env.pool.query("insert into play_seconds(user_id,item_id,day,seconds,item_name) values ($1,$2,current_date - $3::int,$4,'x')", [uid[name], item, daysAgo, seconds]);

const TYPES: Record<string, string> = { [SER_A]: 'Series', [EP_A1]: 'Episode', [EP_A2]: 'Episode' };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter((i) => i && i !== HID);
      return { json: { Items: ids.map((id) => ({ Id: id, Name: id, Type: TYPES[id] ?? 'Movie', SeriesId: id === EP_A1 || id === EP_A2 ? SER_A : undefined })) } };
    },
  });
  s = await env.login();
  uid.me = (await env.pool.query('select id from users limit 1')).rows[0].id;
  await mk('Lea', 1);
  await mk('Tom', 2);
  await mk('Ida', 3);
  await mk('Gone', 4, true);
  await mk('Nia', 5, false, false); // did not opt in to sharing her history
  // Series A: two episodes, three viewers (Lea twice, only counted once)
  await play('Lea', EP_A1, 600); await play('Lea', EP_A2, 600); await play('Tom', EP_A1, 400); await play('Ida', EP_A2, 400);
  // Movie B: two viewers, more seconds than A's single ones
  await play('Lea', MOV_B, 5000); await play('Tom', MOV_B, 5000);
  // Movie C: single viewer (not me) -> hidden
  await play('Lea', MOV_C, 9000);
  await play('Nia', MOV_C, 9000); // Nia does not share -> still a single counted viewer
  // Movie D: Lea + disabled user -> single counted viewer -> hidden
  await play('Lea', MOV_D, 900); await play('Gone', MOV_D, 900);
  // too old / too short
  await play('Lea', MOV_OLD, 900, 7); await play('Tom', MOV_OLD, 900, 7);
  await play('Lea', MOV_SHORT, 299); await play('Tom', MOV_SHORT, 299);
  // invisible
  await play('Lea', HID, 900); await play('Tom', HID, 900);
  // single viewer = me -> shown
  await play('me', MOV_ME, 700);
});
afterAll(() => env.close());

describe('GET /api/library/trending', () => {
  it('groups episodes by series, applies k-anonymity and order', async () => {
    const r = await env.app.inject({ url: '/api/library/trending', cookies: s.cookies });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<{ id: string; viewers: number }>;
    expect(items.map((i) => [i.id, i.viewers])).toEqual([[SER_A, 3], [MOV_B, 2], [MOV_ME, 1]]);
  });
  it('never exposes names and caches per jellyfin user', async () => {
    const r = await env.app.inject({ url: '/api/library/trending', cookies: s.cookies });
    expect(r.body).not.toMatch(/Lea|Tom|Ida/);
    const keys = await env.kv.keys('trend:');
    expect(keys.length).toBe(1);
    await env.pool.query('delete from play_seconds');
    expect((await env.app.inject({ url: '/api/library/trending', cookies: s.cookies })).json().items.length).toBe(3);
  });
  it('empty when nothing qualifies', async () => {
    await env.kv.del((await env.kv.keys('trend:'))[0]!);
    expect((await env.app.inject({ url: '/api/library/trending', cookies: s.cookies })).json()).toEqual({ items: [] });
  });
});
