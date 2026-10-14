// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const SEED = hex(1), SER = hex(2), MOV = hex(3), OLD = hex(4);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const calls: string[] = [];

// every title is similar to everything; id 20..29 are candidates, 24 is already finished, 25 is a duplicate across seeds
const cand = (n: number, extra: object = {}) => ({ Id: hex(n), Name: `T${n}`, Type: 'Movie', UserData: {}, ...extra });
const similarOf = (id: string) => {
  const base = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map((n) => (n === 24 ? cand(n, { UserData: { Played: true } }) : cand(n)));
  if (id === MOV) return [cand(25), cand(26), cand(30), cand(31), cand(32), cand(33)]; // 25/26 are already in the main row
  if (id === OLD) return [30, 31, 40, 41, 42, 43, 44].map((n) => cand(n)); // 30/31 already in the previous extra row
  if (id === SEED) return base;
  return [...base, { Id: id, Name: 'self', Type: 'Movie' }];
};

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+/Similar': (u) => { calls.push(u.pathname); return { json: { Items: similarOf(u.pathname.split('/')[2]!) } }; },
    'GET /Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/')[2], Name: 'Seed', Type: 'Movie', UserData: {} } }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/')[4], Name: 'Seed', Type: 'Movie', UserData: {} } }),
    'GET /UserItems/Resume': () => ({ json: { Items: [] } }),
    'GET /Users/[^/]+/Items/Resume': () => ({ json: { Items: [] } }),
    'GET /Items': (u) => {
      if (u.search.includes('DatePlayed')) {
        const D = (d: number) => ({ PlayCount: 1, Played: true, LastPlayedDate: new Date(Date.now() - d * 864e5).toISOString() });
        return { json: { Items: [
          { Id: hex(10), Name: 'Folge 2', Type: 'Episode', SeriesId: SER, SeriesName: 'Serie', UserData: D(0) },
          { Id: hex(11), Name: 'Folge 1', Type: 'Episode', SeriesId: SER, SeriesName: 'Serie', UserData: D(1) }, // same series: one seed only
          { Id: MOV, Name: 'Film', Type: 'Movie', UserData: D(2) },
          { Id: OLD, Name: 'Alt', Type: 'Movie', UserData: D(3) },
        ] } };
      }
      return { json: { Items: [] } };
    },
  });
  s = await env.login();
});
afterAll(() => env.close());
const get = (url: string, auth = true) => env.app.inject({ url, cookies: auth ? s.cookies : undefined });

describe('GET /api/library/because-more', () => {
  it('requires a session', async () => {
    expect((await get('/api/library/because-more', false)).statusCode).toBe(401);
  });
  it('builds rows from distinct recent titles, without finished or repeated titles', async () => {
    const r = (await get('/api/library/because-more')).json();
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
    expect(r.rows.length).toBeLessThanOrEqual(3);
    expect(r.rows.map((x: any) => x.because.id)).toEqual([MOV, OLD]); // the series is the seed of the main row; its two episodes count once
    const all = r.rows.flatMap((x: any) => x.items.map((i: any) => i.id));
    expect(new Set(all).size).toBe(all.length); // no title twice
    expect(all).not.toContain(hex(24)); // finished
    expect(all).not.toContain(hex(25)); // already in the main row
    expect(all).not.toContain(SER); // seeds are never recommended
    expect(r.rows.every((x: any) => x.items.length >= 4 && x.items.length <= 20)).toBe(true);
  });
  it('drops titles the profile thumbed down', async () => {
    const prof = (await env.pool.query('select id, user_id from profiles limit 1')).rows[0];
    await env.pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$2,$3,-1,'x')", [prof.id, prof.user_id, hex(21)]);
    const all = (await get('/api/library/because-more')).json().rows.flatMap((x: any) => x.items.map((i: any) => i.id));
    expect(all).not.toContain(hex(21));
  });
});
