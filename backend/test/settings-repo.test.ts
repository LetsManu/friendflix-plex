// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt, keyFromBase64 } from '../src/crypto.js';
import { readMeta, readRev, readRows, updateMeta, writeRows } from '../src/settings/repo.js';
import { ENC_KEY, resetDb } from './helpers.js';

let pool: pg.Pool;
const encKey = keyFromBase64(ENC_KEY);
const JF_KEY = 'k'.repeat(32);
beforeAll(async () => { pool = await resetDb(); });
afterAll(async () => { await pool.end(); });

const row = async (key: string) => (await pool.query('select * from settings where key = $1', [key])).rows[0];

describe('settings repo', () => {
  it('starts at rev 0 with no rows', async () => {
    expect(await readRev(pool)).toBe(0);
    expect(await readRows(pool)).toEqual({ rev: 0, rows: [] });
  });

  it('writeRows stores plain values as JSON and secrets encrypted, in one revision', async () => {
    expect(await writeRows(pool, encKey, { JELLYFIN_URL: 'http://jf:8096', JELLYFIN_ADMIN_API_KEY: JF_KEY }, null)).toBe(1);
    expect(await readRev(pool)).toBe(1);
    const url = await row('JELLYFIN_URL');
    expect(url).toMatchObject({ value: 'http://jf:8096', enc: null, last4: null, updated_by: null });
    const key = await row('JELLYFIN_ADMIN_API_KEY');
    expect(key.value).toBeNull();
    expect(key.enc).toBeTruthy();
    expect(decrypt(encKey, key.enc)).toBe(JF_KEY);
    expect(key.last4).toBeNull(); // no hint: 'last4'
    expect(JSON.stringify(key)).not.toContain(JF_KEY);
  });

  it('null deletes the row and bumps the rev', async () => {
    expect(await writeRows(pool, encKey, { JELLYFIN_URL: null }, null)).toBe(2);
    expect(await row('JELLYFIN_URL')).toBeUndefined();
    expect(await row('JELLYFIN_ADMIN_API_KEY')).toBeTruthy();
  });

  it('keeps typed values, last4 only for hint last4, records the actor and replaces on update', async () => {
    const uid = (await pool.query("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-a','A','admin','j','j','x') returning id", [randomUUID()])).rows[0].id;
    const rev = await writeRows(pool, encKey, { TMDB_API_KEY: 'tmdb-secret-9876', CAST_ENABLED: false, SESSION_TTL_SECONDS: 3600, HOME_NETWORKS: ['10.0.0.0/8'] }, uid);
    expect(rev).toBe(3);
    expect((await row('TMDB_API_KEY')).last4).toBe('9876');
    const { rev: r, rows } = await readRows(pool);
    expect(r).toBe(3);
    const by = Object.fromEntries(rows.map((x) => [x.key, x]));
    expect(by.CAST_ENABLED).toMatchObject({ value: false, enc: null, last4: null, updatedBy: uid });
    expect(by.SESSION_TTL_SECONDS!.value).toBe(3600);
    expect(by.HOME_NETWORKS!.value).toEqual(['10.0.0.0/8']);
    expect(by.TMDB_API_KEY).toMatchObject({ value: null, last4: '9876', updatedBy: uid });
    expect(typeof by.TMDB_API_KEY!.updatedAt).toBe('string');
    expect(new Date(by.TMDB_API_KEY!.updatedAt).getTime()).not.toBeNaN();
    expect(JSON.stringify(rows)).not.toContain('tmdb-secret-9876');

    await writeRows(pool, encKey, { TMDB_API_KEY: 'tmdb-other-1111', CAST_ENABLED: true }, null);
    const t = await row('TMDB_API_KEY');
    expect(decrypt(encKey, t.enc)).toBe('tmdb-other-1111');
    expect(t.last4).toBe('1111');
    expect(t.updated_by).toBeNull();
    expect((await row('CAST_ENABLED')).value).toBe(true);
  });

  it('refuses keys that are not settings, without echoing the value, and changes nothing', async () => {
    const before = await readRows(pool);
    for (const key of ['DATABASE_URL', 'APP_ENC_KEY', 'PORT', 'NOT_A_KEY']) {
      const err = await writeRows(pool, encKey, { CAST_ENABLED: false, [key]: 'leak-me-123' }, null).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(key);
      expect((err as Error).message).not.toContain('leak-me-123');
    }
    expect(await readRows(pool)).toEqual(before);
  });

  it('a failing write rolls back every row and the rev', async () => {
    const before = await readRows(pool);
    await expect(writeRows(pool, encKey, { CAST_ENABLED: false, OMDB_API_KEY: 'omdb-1234' }, randomUUID())).rejects.toThrow(/foreign key/);
    expect(await readRows(pool)).toEqual(before);
  });

  it('an empty change set still bumps the rev (a publish point for the store)', async () => {
    const r = await readRev(pool);
    expect(await writeRows(pool, encKey, {}, null)).toBe(r + 1);
  });

  it('meta: setup columns read and update; only a change of setup_completed_at bumps the rev', async () => {
    expect(await readMeta(pool)).toEqual({ rev: await readRev(pool), setupCompletedAt: null, setupCodeHash: null, setupCodeExpiresAt: null, setupCodeFailures: 0 });
    const r0 = await readRev(pool);
    const exp = new Date(Date.now() + 600_000);
    const m1 = await updateMeta(pool, { setupCodeHash: 'h', setupCodeExpiresAt: exp, setupCodeFailures: 2 });
    expect(m1).toEqual({ rev: r0, setupCompletedAt: null, setupCodeHash: 'h', setupCodeExpiresAt: exp, setupCodeFailures: 2 });
    const done = new Date('2026-10-14T10:00:00Z');
    const m2 = await updateMeta(pool, { setupCompletedAt: done, setupCodeHash: null, setupCodeExpiresAt: null, setupCodeFailures: 0 });
    expect(m2).toEqual({ rev: r0 + 1, setupCompletedAt: done, setupCodeHash: null, setupCodeExpiresAt: null, setupCodeFailures: 0 });
    expect((await updateMeta(pool, { setupCompletedAt: done })).rev).toBe(r0 + 1); // unchanged: no bump
    expect((await updateMeta(pool, {})).rev).toBe(r0 + 1);
    expect(await readMeta(pool)).toEqual(m2);
  });
});
