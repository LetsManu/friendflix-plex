import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { setLive, type Live } from '../src/live.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const MINE = hex(1), SHARED = hex(2), PRIVATE = hex(3), HIDDEN = hex(4), OFF = hex(5);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const uid: Record<string, string> = {};

async function mk(name: string, n: number, opts: { share?: boolean; disabled?: boolean } = {}) {
  uid[name] = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, disabled) values (gen_random_uuid(), $1, $2, $1, 'friend', $3, $1, $4, $5) returning id`,
    [name, `${name}@x.de`, hex(100 + n), encrypt(env.ctx.encKey, 'pw'), opts.disabled ?? false],
  )).rows[0].id;
  if (opts.share !== undefined) await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [uid[name], JSON.stringify({ shareHistory: opts.share })]);
}
const live = (name: string, itemId: string, title: string): Live => ({
  userId: uid[name]!, userName: name, itemId, title, positionTicks: 10, runtimeTicks: 100, isPaused: false, playSessionId: `ps-${name}-${itemId}`, updatedAt: Date.now(), source: 'portal',
});

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter((i) => i && i !== HIDDEN);
      return { json: { Items: ids.map((id) => ({ Id: id, Name: id, Type: 'Movie' })) } };
    },
  });
  s = await env.login();
  uid.me = (await env.pool.query('select id from users limit 1')).rows[0].id;
  await env.pool.query('update users set name = $1 where id = $2', ['Me', uid.me]);
  await mk('Lea', 1, { share: true });
  await mk('Nia', 2, { share: false });
  await mk('Kai', 3); // no prefs row at all
  await mk('Gone', 4, { share: true, disabled: true });
  await setLive(env.ctx, live('me', MINE, 'Mein Film'));
  await setLive(env.ctx, live('Lea', SHARED, 'Geteilt'));
  await setLive(env.ctx, { ...live('Lea', HIDDEN, 'Unsichtbar'), playSessionId: 'ps-hidden' });
  await setLive(env.ctx, live('Nia', PRIVATE, 'Privat'));
  await setLive(env.ctx, live('Kai', PRIVATE, 'Auch privat'));
  await setLive(env.ctx, live('Gone', OFF, 'Deaktiviert'));
});
afterAll(() => env.close());

describe('GET /api/nowplaying', () => {
  it('shows own sessions and opted-in friends only, never invisible titles, disabled users or non-sharers', async () => {
    const r = await env.app.inject({ url: '/api/nowplaying', cookies: s.cookies });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<{ user: string; title: string }>;
    expect(items.map((i) => i.title).sort()).toEqual(['Geteilt', 'Mein Film']);
    expect(items.find((i) => i.title === 'Geteilt')).toMatchObject({ user: 'Lea', itemId: SHARED, positionTicks: 10, runtimeTicks: 100, isPaused: false });
    for (const hidden of ['Privat', 'Auch privat', 'Unsichtbar', 'Deaktiviert', 'Nia', 'Kai', 'Gone']) expect(r.body).not.toContain(hidden);
  });
  it('turning sharing off removes the friend again', async () => {
    await env.pool.query(`update user_prefs set data = '{"shareHistory": false}' where user_id = $1`, [uid.Lea]);
    const r = await env.app.inject({ url: '/api/nowplaying', cookies: s.cookies });
    expect(r.json().items.map((i: any) => i.title)).toEqual(['Mein Film']);
  });
});
