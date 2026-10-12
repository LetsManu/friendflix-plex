import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { parties } from '../src/routes/party.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const ITEM = 'a'.repeat(32);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let leaId: string, meId: string;

beforeAll(async () => {
  env = await makeEnv({ 'GET /Items': () => ({ json: { Items: [{ Id: ITEM, Name: 'Alpha', Type: 'Movie' }], TotalRecordCount: 1 } }), 'GET /Items/[^/]+': () => ({ json: { Id: ITEM, Name: 'Alpha', Type: 'Movie' } }), 'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ITEM, Name: 'Alpha', Type: 'Movie' } }) });
  s = await env.login();
  meId = (await env.pool.query("select id from users order by created_at limit 1")).rows[0].id;
  leaId = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'lea', 'l@x.de', 'Lea', 'friend', $1, 'lea', $2) returning id`,
    ['1'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  )).rows[0].id;
});
afterAll(() => env.close());
const call = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });

describe('one tap party invitation', () => {
  it('only people in the room can invite; invited friends get a notification with the room link, once', async () => {
    const id = (await call('POST', '/api/party', { itemId: ITEM })).json().id;
    expect((await call('POST', `/api/party/${id}/invite`, { userIds: [leaId] })).statusCode).toBe(403); // not in the room yet
    parties.get(id)!.join(meId, 'Admin', () => undefined);
    expect((await call('POST', `/api/party/${id}/invite`, { userIds: [leaId, meId] })).json()).toEqual({ sent: 1 }); // not oneself
    expect((await call('POST', `/api/party/${id}/invite`, { userIds: [leaId] })).json()).toEqual({ sent: 0 }); // deduplicated
    const n = (await env.pool.query("select title, link from notifications where user_id=$1 and kind='party_invite'", [leaId])).rows;
    expect(n).toEqual([{ title: expect.stringContaining('Alpha'), link: `/party/${id}` }]);
    expect((await call('POST', '/api/party/nope/invite', { userIds: [leaId] })).statusCode).toBe(404);
    expect((await call('POST', `/api/party/${id}/invite`, { userIds: ['x'] })).statusCode).toBe(400);
  });
});
