import WebSocket from 'ws';
import { encrypt } from '../src/crypto.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parties } from '../src/routes/party.js';
import { makeEnv, type TestEnv } from './helpers.js';

const OPEN = 'a'.repeat(32), SECRET = 'b'.repeat(32);
const U2 = { sub: 'sub-u2', email: 'u2@example.com', name: 'Zweite', groups: [] as string[] };
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let u2: { cookies: Record<string, string>; csrf: string };
let port: number;
const hdr = (s: { csrf: string }) => ({ 'x-csrf-token': s.csrf });

beforeAll(async () => {
  env = await makeEnv({
    // the admin sees everything, the second user (jellyfin id jfu2) does not see SECRET in item lists
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/').pop()!;
      return { json: { Id: id, Name: id === SECRET ? 'Geheimfilm' : 'Offenfilm', Type: 'Movie' } };
    },
    'GET /Items': (u) => {
      const uid = u.searchParams.get('userId');
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const hide = uid === hiddenFor.uid;
      return { json: { Items: ids.filter((x) => !(hide && x === SECRET)).map((Id) => ({ Id, Name: Id === SECRET ? 'Geheimfilm' : 'Offenfilm', Type: 'Movie' })), TotalRecordCount: ids.length } };
    },
  });
  admin = await env.login();
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),$1,$2,'Zweite','friend','jfu2','Zweite',$3)", [U2.sub, U2.email, encrypt(env.ctx.encKey, 'pw')]);
  await env.pool.query("insert into profiles(id, user_id, name, is_owner) select id, id, 'Zweite', true from users where authentik_sub=$1", [U2.sub]);
  u2 = await env.login(U2);
  hiddenFor.uid = 'jfu2';
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(() => env.close());
const hiddenFor: { uid?: string } = {};
const as = (s: typeof admin, method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: hdr(s), payload: body as object });

describe('party visibility', () => {
  let secretRoom = '', openRoom = '';
  it('hidden rooms are not listed and 404 for non-members; open rooms stay visible', async () => {
    secretRoom = (await as(admin, 'POST', '/api/party', { itemId: SECRET })).json().id;
    openRoom = (await as(admin, 'POST', '/api/party', { itemId: OPEN })).json().id;
    expect(hiddenFor.uid).toBeTruthy();
    expect((await as(admin, 'GET', '/api/party')).json().rooms.map((r: any) => r.id).sort()).toEqual([secretRoom, openRoom].sort());
    const list = (await as(u2, 'GET', '/api/party')).json().rooms;
    expect(list.map((r: any) => r.id)).toEqual([openRoom]);
    expect(JSON.stringify(list)).not.toContain('Geheimfilm');
    expect((await as(u2, 'GET', `/api/party/${secretRoom}`)).statusCode).toBe(404);
    expect((await as(u2, 'GET', `/api/party/${openRoom}`)).statusCode).toBe(200);
    expect((await as(admin, 'GET', `/api/party/${secretRoom}`)).statusCode).toBe(200);
  });

  it('an existing member keeps seeing the room', async () => {
    const uid = (await env.pool.query('select id from users where email=$1', [U2.email])).rows[0].id;
    parties.get(secretRoom)!.join(uid, 'Zweite', () => undefined);
    expect((await as(u2, 'GET', '/api/party')).json().rooms.map((r: any) => r.id)).toContain(secretRoom);
    expect((await as(u2, 'GET', `/api/party/${secretRoom}`)).statusCode).toBe(200);
    parties.get(secretRoom)!.leave(uid);
  });

  it('websocket join is rejected when the item is not visible, allowed otherwise', async () => {
    const join = (id: string, s: typeof admin) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/party/${id}`, { headers: { cookie: `ff_sid=${s.cookies.ff_sid}`, origin: 'https://portal.example.com' } });
        ws.on('close', (c) => resolve(c));
        ws.on('open', () => setTimeout(() => { ws.close(); }, 150));
        ws.on('error', () => undefined);
      });
    expect(await join(secretRoom, u2)).toBe(4404);
    expect(await join(openRoom, u2)).not.toBe(4404);
  });
});

describe('party invite visibility', () => {
  it('only notifies invitees who can see the item', async () => {
    const uid = (await env.pool.query('select id from users where email=$1', [U2.email])).rows[0].id;
    const notes = async () => (await env.pool.query("select * from notifications where kind='party_invite' and user_id=$1", [uid])).rows;
    await env.pool.query('delete from notifications');
    const secret = (await as(admin, 'POST', '/api/party', { itemId: SECRET })).json().id;
    const open = (await as(admin, 'POST', '/api/party', { itemId: OPEN })).json().id;
    const adminId = (await env.pool.query("select id from users where email='admin@example.com'")).rows[0].id;
    for (const id of [secret, open]) parties.get(id)!.join(adminId, 'Admin', () => undefined);
    const r1 = await as(admin, 'POST', `/api/party/${secret}/invite`, { userIds: [uid] });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().sent).toBe(0);
    expect(await notes()).toHaveLength(0);
    const r2 = await as(admin, 'POST', `/api/party/${open}/invite`, { userIds: [uid] });
    expect(r2.json().sent).toBe(1);
    expect(await notes()).toHaveLength(1);
  });
});

describe('poll visibility', () => {
  let pollId = '', hiddenOpt = 0, openOpt = 0;
  it('masks options the viewer cannot see but keeps vote counts', async () => {
    await env.pool.query("update polls set status='cancelled'");
    const r = await as(admin, 'POST', '/api/polls', { title: 'Abend', options: [{ jfItemId: OPEN }, { jfItemId: SECRET }] });
    expect(r.statusCode).toBe(200);
    pollId = r.json().id;
    const a = (await as(admin, 'GET', `/api/polls/${pollId}`)).json();
    openOpt = a.options[0].id; hiddenOpt = a.options[1].id;
    expect(a.options[1].title).toBe('Geheimfilm');
    expect((await as(admin, 'POST', `/api/polls/${pollId}/vote`, { optionId: hiddenOpt })).statusCode).toBe(200);
    for (const url of [`/api/polls/${pollId}`, '/api/polls']) {
      const res = (await as(u2, 'GET', url)).json();
      const p = res.polls ? res.polls.find((x: any) => x.id === pollId) : res;
      expect(p.options[0].title).toBe('Offenfilm');
      expect(p.options[1]).toEqual({ id: hiddenOpt, title: null, hidden: true, votes: 1 });
      expect(JSON.stringify(res)).not.toContain('Geheimfilm');
      expect(JSON.stringify(res)).not.toContain(SECRET);
    }
  });
  it('viewer cannot vote for a hidden option but can for a visible one', async () => {
    const v = await as(u2, 'POST', `/api/polls/${pollId}/vote`, { optionId: hiddenOpt });
    expect(v.statusCode).toBe(403);
    expect(v.json().error).toBe('option_hidden');
    expect((await as(u2, 'POST', `/api/polls/${pollId}/vote`, { optionId: openOpt })).statusCode).toBe(200);
  });
});

describe('recommendations seen', () => {
  it('with ids only marks those own rows; without body marks all', async () => {
    const uid = (await env.pool.query('select id from users where email=$1', [U2.email])).rows[0].id;
    const adminId = (await env.pool.query("select id from users where email='admin@example.com'")).rows[0].id;
    const ins = async (to: string, item: string) => (await env.pool.query("insert into recommendations(from_user,to_user,item_id,item_name) values ($1,$2,$3,'x') returning id", [adminId, to, item])).rows[0].id as string;
    const r1 = await ins(uid, OPEN), r2 = await ins(uid, SECRET), foreign = await ins(adminId, OPEN);
    expect((await as(u2, 'POST', '/api/recommendations/seen', { ids: [Number(r1), String(foreign)] })).statusCode).toBe(200);
    const seen = async () => (await env.pool.query('select id, seen from recommendations order by id')).rows.filter((x) => x.seen).map((x) => x.id);
    expect(await seen()).toEqual([r1]);
    expect((await as(u2, 'POST', '/api/recommendations/seen', { ids: ['abc'] })).statusCode).toBe(400);
    expect((await as(u2, 'POST', '/api/recommendations/seen')).statusCode).toBe(200);
    expect(await seen()).toEqual([r1, r2]);
    expect(foreign).toBeTruthy();
  });
});
