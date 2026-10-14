// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const [A, B, C, D, E, F, G] = [1, 2, 3, 4, 5, 6, 7].map(hex) as [string, string, string, string, string, string, string];
const rating: Record<string, number> = { [A]: 5, [B]: 9, [C]: 7, [D]: 8, [E]: 6, [F]: 9.9, [G]: 4 };
let env: TestEnv;
let lea = '', tom = '', me = '';

const detail = (id: string) => ({ Id: id, Name: `T${id.slice(-2)}`, Type: 'Movie', CommunityRating: rating[id], RunTimeTicks: 100 * 600_000_000, Genres: ['Drama'], UserData: {} });

async function mk(name: string, n: number) {
  const id = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $1, $1, 'friend', $2, $1, $3) returning id`,
    [name, hex(900 + n), encrypt(env.ctx.encKey, 'pw')],
  )).rows[0].id as string;
  await env.pool.query('insert into profiles(id,user_id,name,is_owner) values ($1,$1,$2,true)', [id, name]);
  await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareHistory": true}')`, [id]);
  return id;
}
const wl = (user: string, item: string, profile = user) => env.pool.query('insert into watchlist(user_id,profile_id,item_id) values ($1,$2,$3) on conflict do nothing', [user, profile, item]);
const match = async (payload: object = {}) => {
  const { csrf, cookies } = await env.login();
  const r = await env.app.inject({ method: 'POST', url: '/api/match', cookies, headers: { 'x-csrf-token': csrf }, payload: { userIds: [lea, tom], ...payload } });
  expect(r.statusCode).toBe(200);
  return r.json();
};

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const q = u.searchParams;
      if (q.get('filters') === 'IsUnplayed') return { json: { Items: [A, B, C, D, E, F, G].map((Id) => ({ Id })) } };
      if (q.get('ids')) return { json: { Items: q.get('ids')!.split(',').map(detail) } };
      return { json: { Items: [] } };
    },
  });
  await env.login();
  me = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  lea = await mk('Lea', 1);
  tom = await mk('Tom', 2);
});
afterAll(() => env.close());

describe('group matcher weighting', () => {
  it('orders by number of participants who planned it, then rating, and never says who', async () => {
    await wl(me, C); await wl(lea, C); // 2x
    await wl(tom, D); // 1x
    await wl(me, E); // 1x
    const prof = (await env.pool.query(
      `insert into profiles(id,user_id,name,is_owner,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values (gen_random_uuid(),$1,'Kind',false,$2,'kid',$3) returning id`,
      [lea, hex(950), encrypt(env.ctx.encKey, 'pw')])).rows[0].id;
    await wl(lea, A, prof); // another profile of the account counts
    await wl(me, A); // ...and counts once per account
    await wl(lea, A);
    const b = await match();
    expect(b.items.map((i: any) => [i.id, i.planned])).toEqual([[C, 2], [A, 2], [D, 1], [E, 1], [F, 0], [B, 0], [G, 0]]);
    expect(Object.keys(b.items[0]).filter((k) => /planned|who|by/i.test(k))).toEqual(['planned']);
    expect(b.total).toBe(7);
  });
  it('excludes titles dropped (any profile) or thumbed down by a participant', async () => {
    await env.pool.query('insert into dropped(profile_id,item_id) values ($1,$2)', [tom, F]);
    await env.pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$1,$2,-1,'x')", [lea, B]);
    const b = await match();
    expect(b.items.map((i: any) => i.id)).toEqual([C, A, D, E, G]);
    expect(b.total).toBe(7);
  });
  it('a non-participant\'s drop or thumb-down does not matter; planned items beyond others still sort first', async () => {
    const other = await mk('Ben', 3);
    await env.pool.query('insert into dropped(profile_id,item_id) values ($1,$2)', [other, G]);
    const b = await match();
    expect(b.items.map((i: any) => i.id)).toEqual([C, A, D, E, G]);
  });
});

describe('group matcher on a non-owner profile', () => {
  it('still applies the requester\'s own account drops (profile id differs from account id)', async () => {
    const prof = (await env.pool.query(
      `insert into profiles(id,user_id,name,is_owner,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values (gen_random_uuid(),$1,'Teen',false,$2,'teen',$3) returning id`,
      [me, hex(951), encrypt(env.ctx.encKey, 'pw')])).rows[0].id;
    await env.pool.query('insert into dropped(profile_id,item_id) values ($1,$2)', [me, E]); // dropped on the owner profile
    const { csrf, cookies } = await env.login();
    const sel = await env.app.inject({ method: 'POST', url: `/api/profiles/${prof}/select`, cookies, headers: { 'x-csrf-token': csrf }, payload: {} });
    expect(sel.statusCode).toBe(200);
    const r = await env.app.inject({ method: 'POST', url: '/api/match', cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, headers: { 'x-csrf-token': sel.json().csrfToken }, payload: { userIds: [lea, tom] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((i: any) => i.id)).toEqual([C, A, D, G]); // E gone
  });
});
