// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

const OTHER = 'dev-other-0000000000001';
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const sessOf = async (s: Sess) => JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as { userId: string; deviceId: string };

/** two sessions of the test account; the second one moved to a second, approved device */
async function twoDevices() {
  env = await makeEnv();
  const here = await env.login();
  const there = await env.login();
  const s = await sessOf(there);
  await env.kv.set(`sess:${there.cookies.ff_sid}`, JSON.stringify({ ...s, deviceId: OTHER }), 300);
  await env.pool.query('insert into devices (user_id, device_id, label, approved) values ($1, $2, $3, true)', [s.userId, OTHER, 'Telefon']);
  return { here, there, userId: s.userId };
}

describe('POST /api/devices/:id/sign-out (own device)', () => {
  it('signs out only that device and keeps its approval; audited without values', async () => {
    const { here, there, userId } = await twoDevices();
    const r = await call(here, 'POST', `/api/devices/${OTHER}/sign-out`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ revoked: 1 });
    expect((await call(there, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await call(here, 'GET', '/api/me')).statusCode).toBe(200);
    const d = await env.pool.query('select approved from devices where user_id=$1 and device_id=$2', [userId, OTHER]);
    expect(d.rows).toEqual([{ approved: true }]);
    const a = await env.pool.query("select actor, target, meta from audit_log where action='session.revoke_device'");
    expect(a.rows).toEqual([{ actor: userId, target: userId, meta: { sessions: 1 } }]);
  });

  it('refuses the current device with 409', async () => {
    const { here } = await twoDevices();
    const cur = (await sessOf(here)).deviceId;
    const r = await call(here, 'POST', `/api/devices/${cur}/sign-out`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'current_device' });
    expect((await call(here, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('404 for an unknown device or one of another account', async () => {
    const { here, there } = await twoDevices();
    const other = (await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-x', 'x@example.com', 'Xaver', 'friend', $1, 'xaver', 'x') returning id", ['x'.repeat(32)])).rows[0].id;
    await env.pool.query('insert into devices (user_id, device_id, label, approved) values ($1, $2, $3, true)', [other, 'dev-foreign-000000000001', 'Fremd']);
    for (const id of ['dev-unknown-00000000001', 'dev-foreign-000000000001']) {
      const r = await call(here, 'POST', `/api/devices/${id}/sign-out`);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'not_found' });
    }
    expect((await call(there, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('a non-owner profile gets 403', async () => {
    const { here, there } = await twoDevices();
    const p = (await call(here, 'POST', '/api/profiles', { name: 'Kind' })).json().profile as { id: string };
    const sel = await call(here, 'POST', `/api/profiles/${p.id}/select`, {});
    const kid = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: here.csrf };
    const r = await call(kid, 'POST', `/api/devices/${OTHER}/sign-out`);
    expect(r.statusCode).toBe(403);
    expect((await call(there, 'GET', '/api/me')).statusCode).toBe(200);
  });
});
