// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { resetDb } from './helpers.js';

// Block 23 Task 1: migration 37 (user management schema). The backfill is tested against the real migration: rewind to 36,
// seed an already-used invite, migrate again.
let pool: pg.Pool;
beforeAll(async () => { pool = await resetDb(); });
afterAll(async () => { await pool.end(); });

const cols = async (table: string) =>
  Object.fromEntries((await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name=$1", [table])).rows.map((r) => [r.column_name, r]));

describe('block23 migration', () => {
  it('block23 migration adds columns and backfills invite uses', async () => {
    // rewind to 36
    await pool.query(`
      drop table invite_uses, approval_requests, user_limits;
      alter table users drop column access_until, drop column expiry_notified_at, drop column locked_reason, drop column deletion_at, drop column avatar;
      alter table invites drop column max_uses, drop column uses, drop column access_days;
      delete from schema_migrations where version = 37;`);
    const used = (await pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-used','Used','user','j','j','x') returning id", [randomUUID()])).rows[0].id;
    const usedInvite = randomUUID();
    const freshInvite = randomUUID();
    await pool.query("insert into invites(id, token_hash, role, expires_at, used_at, used_by) values ($1,'h1','user', now() + interval '1 day', now(), $2)", [usedInvite, used]);
    await pool.query("insert into invites(id, token_hash, role, expires_at) values ($1,'h2','user', now() + interval '1 day')", [freshInvite]);

    await migrate(pool);

    const u = await cols('users');
    for (const c of ['access_until', 'expiry_notified_at', 'deletion_at']) expect(u[c]?.data_type).toBe('timestamp with time zone');
    expect(u.locked_reason?.data_type).toBe('text');
    expect(u.avatar?.data_type).toBe('text');
    const l = await cols('user_limits');
    for (const c of ['max_streams', 'remote_bitrate', 'max_downloads', 'download_max_height', 'requests_per_month']) expect(l[c]?.data_type).toBe('integer');
    expect(l.updated_at?.data_type).toBe('timestamp with time zone');
    const a = await cols('approval_requests');
    expect(Object.keys(a).sort()).toEqual(['authentik_sub', 'email', 'id', 'name', 'notified_at', 'reject_message', 'rejected_at', 'requested_at']);
    expect(a.authentik_sub?.is_nullable).toBe('NO');
    expect(a.name?.is_nullable).toBe('NO');
    const i = await cols('invites');
    expect(i.max_uses?.is_nullable).toBe('NO');
    expect(i.uses?.is_nullable).toBe('NO');
    expect(i.access_days?.data_type).toBe('integer');
    expect(Object.keys(await cols('invite_uses')).sort()).toEqual(['at', 'invite_id', 'user_id']);

    const inv = (await pool.query('select id, max_uses, uses from invites')).rows;
    expect(inv.find((r) => r.id === usedInvite)).toMatchObject({ max_uses: 1, uses: 1 });
    expect(inv.find((r) => r.id === freshInvite)).toMatchObject({ max_uses: 1, uses: 0 });
    expect((await pool.query('select invite_id, user_id from invite_uses')).rows).toEqual([{ invite_id: usedInvite, user_id: used }]);
    expect((await pool.query('select max(version) v from schema_migrations')).rows[0].v).toBeGreaterThanOrEqual(37);
  });

  it('enforces uniqueness and cascades', async () => {
    await pool.query("insert into approval_requests(id, authentik_sub, name) values ($1,'s1','A')", [randomUUID()]);
    await expect(pool.query("insert into approval_requests(id, authentik_sub, name) values ($1,'s1','B')", [randomUUID()])).rejects.toThrow(/duplicate key/);
    const uid = (await pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-c','C','user','j2','j2','x') returning id", [randomUUID()])).rows[0].id;
    await pool.query('insert into user_limits(user_id, max_streams) values ($1, 2)', [uid]);
    await pool.query('delete from users where id = $1', [uid]);
    expect((await pool.query('select 1 from user_limits where user_id = $1', [uid])).rowCount).toBe(0);
  });
});
