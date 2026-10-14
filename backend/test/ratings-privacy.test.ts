// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const OK = 'a'.repeat(32), HIDDEN = 'b'.repeat(32);
let env: TestEnv;
let alice: { cookies: Record<string, string>; csrf: string };
let aliceId = '', beaId = '', cidId = '';

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => { const id = u.pathname.split('/')[2]; return id === OK ? { json: { Id: OK, Name: 'Film', Type: 'Movie' } } : { status: 404 }; },
  });
  alice = await env.login();
  for (const [sub, name, jf] of [['sub-b', 'Bea', 'jfbea'], ['sub-c', 'Cid', 'jfcid']]) {
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),$1,$2,$3,'friend',$4,$3,$5)", [sub, `${sub}@example.com`, name, jf, encrypt(env.ctx.encKey, 'pw')]);
  }
  const id = async (sub: string) => (await env.pool.query<{ id: string }>('select id from users where authentik_sub=$1', [sub])).rows[0]!.id;
  aliceId = await id('sub-admin'); beaId = await id('sub-b'); cidId = await id('sub-c');
  await env.pool.query("insert into ratings(user_id,item_id,item_name,stars) values ($1,$4,'Film',5),($2,$4,'Film',3),($3,$4,'Film',1),($1,$5,'Versteckt',4)", [aliceId, beaId, cidId, OK, HIDDEN]);
});
afterAll(() => env.close());
const get = (url: string) => env.app.inject({ url, cookies: alice.cookies });

describe('GET /api/items/:id/ratings', () => {
  it('404 when the item is not visible to the viewer', async () => {
    expect((await get(`/api/items/${HIDDEN}/ratings`)).statusCode).toBe(404);
  });
  it('lists everyone while all share', async () => {
    const b = (await get(`/api/items/${OK}/ratings`)).json();
    expect(b.ratings).toHaveLength(3);
    expect(b.average).toBe(3);
  });
  it('excludes users with shareRatings=false (average follows), keeps own row', async () => {
    await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareRatings": false}')`, [cidId]);
    let b = (await get(`/api/items/${OK}/ratings`)).json();
    expect(b.ratings.map((r: any) => r.name).sort()).toEqual(['Admin', 'Bea']);
    expect(b.average).toBe(4);
    await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareRatings": false}')`, [aliceId]);
    b = (await get(`/api/items/${OK}/ratings`)).json();
    expect(b.ratings.find((r: any) => r.mine)?.stars).toBe(5); // own rating stays visible to its author
    expect(b.ratings).toHaveLength(2);
  });
});
