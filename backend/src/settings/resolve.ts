// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { configSchema, withOriginPublicUrl, type Config } from '../config.js';
import { decrypt } from '../crypto.js';
import { BOOTSTRAP_KEYS, parseSettingValue, settingDef, type SettingDef } from './registry.js';
import type { StoredRow } from './repo.js';

/** Where a key's effective value comes from (Admin -> Settings shows it; 'env' locks the key). */
export type Source = 'env' | 'db' | 'bootstrap' | 'default' | 'unset';

const KEYS = Object.keys(configSchema.shape) as Array<keyof Config>;
const BOOTSTRAP = new Set(BOOTSTRAP_KEYS);
/** new name -> old names, from the registry (legacyEnv is derived from config.ts RENAMED_ENV) */
const legacyNames = (key: string) => settingDef(key)?.legacyEnv ?? [];

/**
 * The env layer as raw strings, in loadConfig's order: a set VAR_FILE (Docker secrets) replaces VAR (an empty file is unset, even with
 * VAR set), and a legacy name only counts while the new name is unset in both forms (new_FILE, new, old_FILE, old). An empty value counts
 * as unset (compose passes `${VAR:-}`), so '' never reaches a schema. An env PUBLIC_URL with a path keeps working with its origin.
 */
export function envLayer(env: NodeJS.ProcessEnv): Record<string, string> {
  // { set } = the name is given in either form (it then hides the legacy names, as in withRenamedEnv); a set VAR_FILE decides alone,
  // so an empty file with a set VAR is unset, as in withFileSecrets
  const pick = (name: string): { set: boolean; value?: string } => {
    const file = env[`${name}_FILE`];
    // a missing file fails like loadConfig does (the error names the path, never a value)
    if (file) return { set: true, value: readFileSync(file, 'utf8').trim() || undefined };
    return { set: Boolean(env[name]), value: env[name] || undefined };
  };
  const out: Record<string, string> = {};
  for (const key of KEYS) {
    for (const name of [key, ...legacyNames(key)]) {
      const { set, value } = pick(name);
      if (!set) continue;
      if (value) out[key] = value;
      break;
    }
  }
  return withOriginPublicUrl(out) as Record<string, string>;
}

/** Stored JSON -> the schema's input: settings are stored typed (booleans, numbers, CIDR arrays), the config schema parses env strings. */
export function toSchemaInput(def: SettingDef, v: unknown): unknown {
  if (def.kind === 'bool' && typeof v === 'boolean') return String(v);
  if (def.kind === 'cidrList' && Array.isArray(v)) return v.join(',');
  return v;
}

/** A parsed (Config-typed) value -> its stored JSON form. */
export function toStored(def: SettingDef, parsed: unknown): unknown {
  return def.kind === 'bool' ? parsed === 'true' : parsed;
}

/** Decrypts and validates a stored row; undefined when it is unreadable (wrong APP_ENC_KEY) or fails its schema. */
function rowValue(def: SettingDef, row: StoredRow, encKey: Buffer): { value: unknown } | undefined {
  let input: unknown;
  if (def.secret) {
    if (row.enc === null) return undefined;
    try {
      input = decrypt(encKey, row.enc);
    } catch {
      return undefined;
    }
  } else {
    if (row.value === null) return undefined;
    input = toSchemaInput(def, row.value);
  }
  const r = parseSettingValue(def, input);
  return r.ok && r.value !== undefined && r.value !== '' ? { value: r.value } : undefined;
}

let warnedDiskLevels = false;

/**
 * Merges env > database > default for settings, env > bootstrap volume > default for bootstrap keys and env > default for everything
 * else (pure). Rows that cannot be decrypted or fail their schema are ignored and listed in `invalid` (the caller logs the key names).
 * An invalid env value fails like loadConfig, naming the key and the error code only.
 */
export function resolveConfig(input: { env: NodeJS.ProcessEnv; rows: StoredRow[]; encKey: Buffer; bootstrap?: Partial<Record<string, string>> }):
  { cfg: Config; sources: Record<string, Source>; invalid: string[] } {
  const env = envLayer(input.env);
  const rows = new Map(input.rows.map((r) => [r.key, r]));
  const cfg: Record<string, unknown> = {};
  const sources: Record<string, Source> = {};
  const invalid: string[] = [];

  for (const key of KEYS) {
    const def = settingDef(key);
    const schema = configSchema.shape[key] as z.ZodType;
    const row = def && rows.get(key);
    const stored = def && row ? rowValue(def, row, input.encKey) : undefined;
    if (row && !stored) invalid.push(key);

    const raw = env[key];
    if (raw !== undefined) {
      const r = schema.safeParse(raw);
      if (!r.success) {
        const code = def ? (parseSettingValue(def, raw) as { code: string }).code : r.error.issues[0]?.code ?? 'invalid';
        throw new Error(`${key} is invalid (${code})`);
      }
      cfg[key] = r.data;
      sources[key] = 'env';
      continue;
    }
    if (stored) {
      cfg[key] = stored.value;
      sources[key] = 'db';
      continue;
    }
    const boot = BOOTSTRAP.has(key) ? input.bootstrap?.[key] : undefined;
    if (boot) {
      const r = schema.safeParse(boot);
      if (!r.success) throw new Error(`${key} from the bootstrap volume is invalid (${r.error.issues[0]?.code ?? 'invalid'})`);
      cfg[key] = r.data;
      sources[key] = 'bootstrap';
      continue;
    }
    const d = schema.safeParse(undefined);
    if (!d.success) throw new Error(`${key} is not set`);
    cfg[key] = d.data;
    // registry defaults that the readers apply themselves (e.g. AUTHENTIK_RECOVERY_FLOW) count as defaults too
    sources[key] = (d.data !== undefined && d.data !== '') || def?.default !== undefined ? 'default' : 'unset';
  }

  // yellow must come before red (as loadConfig): a warn level at or above the critical one would never show
  if ((cfg.HEALTH_DISK_WARN_PCT as number) >= (cfg.HEALTH_DISK_CRIT_PCT as number)) {
    if (!warnedDiskLevels) {
      warnedDiskLevels = true;
      console.warn(`HEALTH_DISK_WARN_PCT (${cfg.HEALTH_DISK_WARN_PCT}) must be below HEALTH_DISK_CRIT_PCT (${cfg.HEALTH_DISK_CRIT_PCT}); using 85 / 95`);
    }
    cfg.HEALTH_DISK_WARN_PCT = 85;
    cfg.HEALTH_DISK_CRIT_PCT = 95;
  }
  return { cfg: cfg as Config, sources, invalid };
}
