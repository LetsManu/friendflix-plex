// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { migrate, MIGRATIONS } from '../src/db.js';
import { ENC_KEY, resetDb } from './helpers.js';

// Block 25 Task 2: migration 39 (settings + settings_meta). Rewind to 38, seed, migrate again.
let pool: pg.Pool;
beforeAll(async () => { pool = await resetDb(); });
afterAll(async () => { await pool.end(); });

const rewind = () => pool.query('drop table settings, settings_meta; delete from schema_migrations where version in (39, 40);');

describe('block25 migration', () => {
  it('is migration 39, followed by 40 (setup completed for installs with users)', () => {
    expect(MIGRATIONS.length).toBe(40);
    expect(MIGRATIONS[38]).toContain('create table settings (');
    expect(MIGRATIONS[39]).toContain('setup_completed_at = now()');
  });

  it('an empty database: setup not completed, rev 0, no settings', async () => {
    const m = (await pool.query('select id, rev, setup_completed_at, setup_code_hash, setup_code_expires_at, setup_code_failures from settings_meta')).rows;
    expect(m).toEqual([{ id: 1, rev: '0', setup_completed_at: null, setup_code_hash: null, setup_code_expires_at: null, setup_code_failures: 0 }]);
    expect((await pool.query('select 1 from settings')).rowCount).toBe(0);
  });

  it('an existing install: setup completed, data-source keys move over unchanged, other app_settings stay', async () => {
    await rewind();
    await pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-a','A','admin','j','j','x')", [randomUUID()]);
    const tmdbEnc = encrypt(keyFromBase64(ENC_KEY), 'tmdb-key-abcd');
    const omdbEnc = encrypt(keyFromBase64(ENC_KEY), 'omdb-key-wxyz');
    await pool.query(`insert into app_settings(key, value, updated_at) values
      ('source.tmdb', $1, '2026-01-02T03:04:05Z'), ('source.omdb', $2, now()), ('digest', '{"enabled":false,"day":0,"hour":18}', now())`,
    [JSON.stringify({ enc: tmdbEnc, last4: 'abcd', updatedAt: 'x' }), JSON.stringify({ enc: omdbEnc, last4: 'wxyz', updatedAt: 'x' })]);

    await migrate(pool);

    const rows = (await pool.query('select key, value, enc, last4, updated_at, updated_by from settings order by key')).rows;
    expect(rows).toEqual([
      { key: 'OMDB_API_KEY', value: null, enc: omdbEnc, last4: 'wxyz', updated_at: expect.any(Date), updated_by: null },
      { key: 'TMDB_API_KEY', value: null, enc: tmdbEnc, last4: 'abcd', updated_at: new Date('2026-01-02T03:04:05Z'), updated_by: null },
    ]);
    expect((await pool.query('select key, value from app_settings')).rows).toEqual([{ key: 'digest', value: { enabled: false, day: 0, hour: 18 } }]);
    const m = (await pool.query('select rev, setup_completed_at from settings_meta')).rows[0];
    expect(m.rev).toBe('0');
    expect(m.setup_completed_at).toBeInstanceOf(Date);
  });

  it('a source row without an encrypted key is dropped, not moved (and does not fail the migration)', async () => {
    await rewind();
    await pool.query(`insert into app_settings(key, value) values ('source.tmdb', '{"last4":"abcd"}'), ('source.omdb', '{"enc":null}')`);
    await migrate(pool);
    expect((await pool.query('select 1 from settings')).rowCount).toBe(0);
    expect((await pool.query("select 1 from app_settings where key like 'source.%'")).rowCount).toBe(0);
  });

  it('constraints: exactly one of value / enc, one meta row, updated_by is nulled when the user goes', async () => {
    await expect(pool.query(`insert into settings(key, value, enc) values ('X', '"a"', 'b')`)).rejects.toThrow(/check constraint/);
    await expect(pool.query(`insert into settings(key) values ('X')`)).rejects.toThrow(/check constraint/);
    await expect(pool.query('insert into settings_meta(id) values (2)')).rejects.toThrow(/check constraint/);
    const uid = (await pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-b','B','user','j2','j2','x') returning id", [randomUUID()])).rows[0].id;
    await pool.query(`insert into settings(key, value, updated_by) values ('Y', '"v"', $1)`, [uid]);
    await pool.query('delete from users where id = $1', [uid]);
    expect((await pool.query("select updated_by from settings where key = 'Y'")).rows[0].updated_by).toBeNull();
  });

  it('migration 40: a database with users but no setup_completed_at counts as set up; one without users stays in setup', async () => {
    const at40 = () => pool.query('delete from schema_migrations where version = 40');
    await pool.query('delete from users; update settings_meta set setup_completed_at = null');
    await at40();
    await migrate(pool);
    expect((await pool.query('select setup_completed_at from settings_meta')).rows[0].setup_completed_at).toBeNull();
    await pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-c','C','admin','j3','j3','x')", [randomUUID()]);
    await at40();
    await migrate(pool);
    expect((await pool.query('select setup_completed_at from settings_meta')).rows[0].setup_completed_at).toBeInstanceOf(Date);
    // an earlier completion is kept as it is
    const done = new Date('2026-01-01T00:00:00Z');
    await pool.query('update settings_meta set setup_completed_at = $1', [done]);
    await at40();
    await migrate(pool);
    expect((await pool.query('select setup_completed_at from settings_meta')).rows[0].setup_completed_at).toEqual(done);
  });
});
