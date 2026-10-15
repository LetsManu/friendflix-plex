// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { encrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { settingDef } from './registry.js';

/**
 * Storage of the settings table (migration 39). Plain values are stored as JSON, secrets as an AES-256-GCM blob (crypto.encrypt with
 * APP_ENC_KEY) plus, for `hint: 'last4'` keys only, their last 4 characters. Rows are returned as stored: decrypting and validating is
 * the resolver's job, and nothing here logs or returns a secret in clear. Every write bumps settings_meta.rev in the same statement.
 */
export interface StoredRow {
  key: string;
  value: unknown | null;
  enc: string | null;
  last4: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SettingsMeta {
  rev: number;
  setupCompletedAt: Date | null;
  setupCodeHash: string | null;
  setupCodeExpiresAt: Date | null;
  setupCodeFailures: number;
}

type RawRow = { key: string; value: unknown | null; enc: string | null; last4: string | null; updated_at: Date; updated_by: string | null };

/** All rows and the rev they belong to, read in one statement (one snapshot). */
export async function readRows(db: Db): Promise<{ rev: number; rows: StoredRow[] }> {
  const r = await db.query<RawRow & { rev: string }>(
    'select m.rev, s.key, s.value, s.enc, s.last4, s.updated_at, s.updated_by from settings_meta m left join settings s on true order by s.key');
  const rows = r.rows.filter((x) => x.key !== null).map((x): StoredRow => ({
    key: x.key, value: x.value, enc: x.enc, last4: x.last4, updatedAt: x.updated_at.toISOString(), updatedBy: x.updated_by,
  }));
  return { rev: Number(r.rows[0]?.rev ?? 0), rows };
}

export async function readRev(db: Db): Promise<number> {
  const r = await db.query<{ rev: string }>('select rev from settings_meta where id = 1');
  return Number(r.rows[0]?.rev ?? 0);
}

/**
 * Writes the changes (null deletes) and bumps the rev, all in one statement, so it is atomic without a pool client. Only registry
 * settings are accepted (never bootstrap, env-only or unknown keys); the error names the key, never the value. Returns the new rev.
 */
export async function writeRows(db: Db, encKey: Buffer, changes: Record<string, unknown | null>, actor: string | null): Promise<number> {
  const input = Object.entries(changes).filter(([, v]) => v !== undefined).map(([key, v]) => {
    const def = settingDef(key);
    if (!def) throw new Error(`not a setting: ${key}`);
    if (v === null) return { key, del: true, value: null, enc: null, last4: null };
    if (!def.secret) return { key, del: false, value: v, enc: null, last4: null };
    const plain = String(v);
    return { key, del: false, value: null, enc: encrypt(encKey, plain), last4: def.hint === 'last4' ? plain.slice(-4) : null };
  });
  const r = await db.query<{ rev: string }>(`
    with input as (select * from jsonb_to_recordset($1::jsonb) as x(key text, del boolean, value jsonb, enc text, last4 text)),
    removed as (delete from settings s using input i where i.del and s.key = i.key),
    written as (
      insert into settings(key, value, enc, last4, updated_at, updated_by)
        select key, value, enc, last4, now(), $2::uuid from input where not del
      on conflict (key) do update set value = excluded.value, enc = excluded.enc, last4 = excluded.last4,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by)
    update settings_meta set rev = rev + 1 where id = 1 returning rev`, [JSON.stringify(input), actor]);
  return Number(r.rows[0]!.rev);
}

type MetaRow = { rev: string; setup_completed_at: Date | null; setup_code_hash: string | null; setup_code_expires_at: Date | null; setup_code_failures: number };
const META_COLS = 'rev, setup_completed_at, setup_code_hash, setup_code_expires_at, setup_code_failures';
const toMeta = (r: MetaRow): SettingsMeta => ({
  rev: Number(r.rev), setupCompletedAt: r.setup_completed_at, setupCodeHash: r.setup_code_hash,
  setupCodeExpiresAt: r.setup_code_expires_at, setupCodeFailures: r.setup_code_failures,
});

export async function readMeta(db: Db): Promise<SettingsMeta> {
  return toMeta((await db.query<MetaRow>(`select ${META_COLS} from settings_meta where id = 1`)).rows[0]!);
}

const META_FIELDS = {
  setupCompletedAt: 'setup_completed_at', setupCodeHash: 'setup_code_hash', setupCodeExpiresAt: 'setup_code_expires_at',
  setupCodeFailures: 'setup_code_failures',
} as const satisfies Record<keyof Omit<SettingsMeta, 'rev'>, string>;

/**
 * Updates the setup columns. A change of setup_completed_at bumps the rev in the same statement, so other instances drop their
 * cached "setup complete?" answer on reload (ruling D10); the setup code columns do not. Returns the meta after the update.
 */
export async function updateMeta(db: Db, patch: Partial<Omit<SettingsMeta, 'rev'>>): Promise<SettingsMeta> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of Object.entries(META_FIELDS)) {
    const v = patch[k as keyof typeof META_FIELDS];
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
    // the right-hand side sees the old row
    if (k === 'setupCompletedAt') sets.push(`rev = rev + case when setup_completed_at is distinct from $${params.length}::timestamptz then 1 else 0 end`);
  }
  if (!sets.length) return readMeta(db);
  return toMeta((await db.query<MetaRow>(`update settings_meta set ${sets.join(', ')} where id = 1 returning ${META_COLS}`, params)).rows[0]!);
}
