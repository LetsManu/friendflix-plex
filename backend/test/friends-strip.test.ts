import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const ITEM = hex(1), SER = hex(2), HID = hex(3);
const jfId = (n: number) => hex(100 + n);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const uid: Record<string, string> = {};
const played = new Set<string>(); // jellyfin user ids that have watched ITEM
const fail = new Set<string>();
const queried: string[] = [];

async function mk(name: string, n: number, prefs?: object, disabled = false) {
  uid[name] = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, disabled) values (gen_random_uuid(), $1, $2, $1, 'friend', $3, $1, $4, $5) returning id`,
    [name, `${name}@x.de`, jfId(n), encrypt(env.ctx.encKey, 'pw'), disabled],
  )).rows[0].id;
  if (prefs) await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [uid[name], JSON.stringify(prefs)]);
}
const rate = (name: string, item: string, stars: number) => env.pool.query("insert into ratings(user_id,item_id,item_name,stars) values ($1,$2,'x',$3)", [uid[name], item, stars]);

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/')[2]!;
      return id === HID ? { status: 404 } : { json: { Id: id, Name: 'T', Type: id === SER ? 'Series' : 'Movie' } };
    },
    'GET /Items': (u) => {
      const f = u.searchParams.get('userId')!;
      queried.push(f);
      if (fail.has(f)) return { status: 500 };
      const id = u.searchParams.get('ids')!;
      const it = { Id: id, Name: 'T', Type: id === SER ? 'Series' : 'Movie', UserData: id === SER ? { PlayedPercentage: played.has(f) ? 30 : 0 } : { Played: id === ITEM && played.has(f) } };
      return { json: { Items: [it] } };
    },
  });
  s = await env.login();
  uid.me = (await env.pool.query('select id from users limit 1')).rows[0].id;
  await mk('Lea', 1, { shareHistory: true });
  await mk('Tom', 2, { shareHistory: true, shareRatings: false });
  await mk('Ida', 3);
  await mk('Max', 4, { shareHistory: false });
  await mk('Gone', 5, { shareHistory: true }, true);
  await mk('Zoe', 6, { shareHistory: true });
  await rate('Lea', ITEM, 4);
  await rate('Tom', ITEM, 5); // hidden: shareRatings=false
  await rate('Ida', ITEM, 3);
  await rate('Gone', ITEM, 5);
  await rate('Max', SER, 5);
  await env.pool.query("insert into ratings(user_id,item_id,item_name,stars) values ($1,$2,'x',2)", [uid.me, ITEM]);
  await env.pool.query("insert into recommendations(from_user,to_user,item_id,item_name) values ($1,$2,$3,'x')", [uid.Zoe, uid.me, ITEM]);
  await env.pool.query("insert into recommendations(from_user,to_user,item_id,item_name) values ($1,$2,$3,'x')", [uid.Lea, uid.Ida, ITEM]); // not to me
  played.add(jfId(2)); played.add(jfId(4)); played.add(jfId(6));
});
afterAll(() => env.close());
const get = (id: string) => env.app.inject({ url: `/api/items/${id}/friends`, cookies: s.cookies });

describe('GET /api/items/:id/friends', () => {
  it('combines stars, watched and recommended; respects privacy; sorted recommended > stars > watched', async () => {
    const r = await get(ITEM);
    expect(r.statusCode).toBe(200);
    expect(r.json().friends).toEqual([
      { id: uid.Zoe, name: 'Zoe', watched: true, recommended: true },
      { id: uid.Lea, name: 'Lea', stars: 4 },
      { id: uid.Ida, name: 'Ida', stars: 3 },
      { id: uid.Tom, name: 'Tom', watched: true }, // ratings hidden, history shared
    ]);
  });
  it('only asks Jellyfin for friends who share their history', async () => {
    expect(new Set(queried)).toEqual(new Set([jfId(1), jfId(2), jfId(6)])); // not Ida (no prefs), Max (off), Gone (disabled)
  });
  it('caches watched lookups for 5 minutes', async () => {
    const n = queried.length;
    await get(ITEM);
    expect(queried.length).toBe(n);
    expect(await env.kv.get(`fw:${uid.Tom}:${ITEM}`)).toBe('1');
  });
  it('a failing lookup only omits the watched flag', async () => {
    await env.kv.del(`fw:${uid.Tom}:${ITEM}`);
    fail.add(jfId(2));
    const f = (await get(ITEM)).json().friends;
    expect(f.map((x: any) => x.name)).toEqual(['Zoe', 'Lea', 'Ida']);
    fail.clear();
  });
  it('series: watched when started; an item without any signal gives an empty list', async () => {
    await rate('Lea', SER, 5);
    expect((await get(SER)).json().friends).toEqual([
      { id: uid.Lea, name: 'Lea', stars: 5 },
      { id: uid.Max, name: 'Max', stars: 5 }, // history not shared -> never queried, no flag
      { id: uid.Tom, name: 'Tom', watched: true },
      { id: uid.Zoe, name: 'Zoe', watched: true },
    ]);
    expect((await get(hex(50))).json()).toEqual({ friends: [] });
  });
  it('404 when the viewer cannot see the item', async () => {
    expect((await get(HID)).statusCode).toBe(404);
  });
});
