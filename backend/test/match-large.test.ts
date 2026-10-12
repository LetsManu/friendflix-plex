import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const LEA_JF = '1'.repeat(32);
const hex = (n: number) => n.toString(16).padStart(32, '0');
const IDS = Array.from({ length: 1000 }, (_, n) => hex(n + 1));
const TARGET = IDS[899]!; // far beyond the old 400 cut-off
const detail = (id: string) => ({ Id: id, Name: `T${id.slice(-4)}`, Type: 'Movie', CommunityRating: id === TARGET ? 9.9 : 5, RunTimeTicks: 100 * 600_000_000, Genres: id === TARGET ? ['Nische'] : ['Drama'], UserData: {} });
let env: TestEnv;
let leaId = '';
const idCalls: string[] = [];

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const q = u.searchParams;
      if (q.get('filters') === 'IsUnplayed') return { json: { Items: IDS.map((Id) => ({ Id })) } };
      if (q.get('ids')) {
        idCalls.push(u.search);
        const g = q.get('genres');
        return { json: { Items: q.get('ids')!.split(',').map(detail).filter((i) => !g || i.Genres.includes(g)) } };
      }
      return { json: { Items: [] } };
    },
  });
  await env.login();
  leaId = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'lea', 'l@x.de', 'Lea', 'friend', $1, 'lea', $2) returning id`,
    [LEA_JF, encrypt(env.ctx.encKey, 'pw')],
  )).rows[0].id;
  await env.pool.query(`insert into user_prefs(user_id, data) values ($1, '{"shareHistory": true}')`, [leaId]);
});
afterAll(() => env.close());

describe('group matcher on large libraries', () => {
  it('applies genre/runtime filters to the whole common set, not just the first 400', async () => {
    const { csrf, cookies } = await env.login();
    const r = await env.app.inject({ method: 'POST', url: '/api/match', cookies, headers: { 'x-csrf-token': csrf }, payload: { userIds: [leaId], genre: 'Nische' } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.total).toBe(1000);
    expect(b.items.map((i: any) => i.id)).toEqual([TARGET]);
    expect(idCalls.length).toBe(13); // 1000 ids in chunks of 80
    expect(idCalls.every((s) => s.includes('genres=Nische'))).toBe(true);
  });
  it('without a genre, the best rated title anywhere comes first', async () => {
    const { csrf, cookies } = await env.login();
    const b = (await env.app.inject({ method: 'POST', url: '/api/match', cookies, headers: { 'x-csrf-token': csrf }, payload: { userIds: [leaId], maxMinutes: 120 } })).json();
    expect(b.items[0].id).toBe(TARGET);
    expect(b.items).toHaveLength(40);
  });
});
