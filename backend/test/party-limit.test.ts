import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parties } from '../src/routes/party.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { ADMIN, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const ITEM = 'c'.repeat(32);
const USER = { sub: 'sub-friend', email: 'f@example.com', name: 'Friend', groups: [] };
let env: TestEnv;
let user: { cookies: Record<string, string>; csrf: string };
let admin: { cookies: Record<string, string>; csrf: string };

beforeAll(async () => {
  env = await makeEnv({ 'GET /Items/[^/]+': () => ({ json: { Id: ITEM, Name: 'Film', Type: 'Movie' } }) });
  admin = await env.login(ADMIN);
  // friends need an invite to sign up; a pre-existing row lets the friend log in directly
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-friend', 'f@example.com', 'Friend', 'friend', $1, 'friend', $2)`,
    ['2'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
  );
  user = await env.login(USER);
});
afterAll(() => env.close());

const call = (who: typeof user, body: unknown) =>
  env.app.inject({ method: 'POST', url: '/api/party', cookies: who.cookies, headers: { 'x-csrf-token': who.csrf }, payload: body as object });

describe('party creation limit', () => {
  it('a non-admin may hold at most 3 scheduled rooms; the 4th gets 429', async () => {
    for (let i = 0; i < 3; i++) expect((await call(user, { itemId: ITEM, startInMinutes: 60 })).statusCode).toBe(200);
    const res = await call(user, { itemId: ITEM, startInMinutes: 60 });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'too_many_parties', max: 3 });
  });

  it('an admin can create a 4th scheduled room', async () => {
    for (let i = 0; i < 4; i++) expect((await call(admin, { itemId: ITEM, startInMinutes: 60 })).statusCode).toBe(200);
  });

  it('after one scheduled room has started, a new one can be created again', async () => {
    const userId = (await env.pool.query("select id from users where authentik_sub = 'sub-friend'")).rows[0].id;
    const room = [...parties.rooms.values()].find((r) => r.hostId === userId && !r.started)!;
    expect(room).toBeDefined();
    (room as { started: boolean }).started = true; // as if its start time had passed
    expect((await call(user, { itemId: ITEM, startInMinutes: 60 })).statusCode).toBe(200);
  });
});
