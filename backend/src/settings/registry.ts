// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from 'zod';
import { configSchema, publicUrlSchema, RENAMED_ENV, type Config } from '../config.js';
import { mediaSettings } from '../media/index.js';

export { publicUrlSchema };

/**
 * The settings registry: every key of config.ts has exactly one class (docs/superpowers/specs/2026-10-14-block25-setup-wizard-design.md,
 * Part A). Settings live in the database (env still wins), env-only keys are per container, bootstrap keys are needed before the database
 * can be read, build keys are baked into the image. A setting parses with the config.ts field of the same key, so Config keeps its types.
 */
export type SettingKind = 'string' | 'url' | 'secret' | 'int' | 'number' | 'bool' | 'enum' | 'cidrList' | 'json';
export type SettingGroup = 'general' | 'signin' | 'media' | 'requests' | 'notifications' | 'push' | 'sources'
  | 'downloads' | 'playback' | 'updates' | 'health' | 'sessions';
export type ProbeId = 'publicUrl' | 'media' | 'oidc' | 'authentik' | 'requests' | 'tmdb' | 'omdb' | 'portainer' | 'github';

export interface SettingDef {
  /** the env name, e.g. 'JELLYFIN_URL' */
  key: string;
  kind: SettingKind;
  group: SettingGroup;
  /** parses the raw string (env) and the stored JSON value (db) */
  schema: z.ZodType;
  /** static default; undefined = unset */
  default?: unknown;
  /** encrypted at rest, write-only in the UI */
  secret?: boolean;
  /** secrets that may show their last 4 chars (API keys only, never passwords/client secrets) */
  hint?: 'last4';
  apply: 'live' | 'restart';
  /** the group probe run on save and on "Test" */
  probe?: ProbeId;
  /** old env names, e.g. ['SEERR_URL'] for REQUESTS_URL */
  legacyEnv?: string[];
  generate?: 'webhookSecret' | 'vapidPair';
  /** must be set once setup is complete */
  runRequired?: boolean | ((cfg: Config) => boolean);
  /** default true; false for keys pre-registered for Block 23 phase 3 */
  visible?: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
}

type Key = keyof typeof configSchema.shape;
type Meta = Pick<SettingDef, 'kind' | 'group'> & Partial<Omit<SettingDef, 'key' | 'schema' | 'kind' | 'group'>>;

/** Default, enum options and number bounds as the config schema field states them (unwrapping default/optional/preprocess/transform). */
function fromSchema(schema: z.ZodType): Pick<SettingDef, 'default' | 'options' | 'min' | 'max'> {
  const out: Pick<SettingDef, 'default' | 'options' | 'min' | 'max'> = {};
  const d = schema.safeParse(undefined);
  if (d.success && d.data !== undefined && d.data !== '') out.default = d.data;
  // zod's own definition objects; only the shapes used in config.ts are walked
  type Check = { _zod: { def: { check: string; value?: number; inclusive?: boolean; format?: string } } };
  let s = schema as unknown as { def: { type: string; innerType?: unknown; in?: { def: { type: string } }; out?: unknown; checks?: Check[] }; options?: string[] };
  for (let i = 0; i < 8; i++) {
    const { type } = s.def;
    if (type === 'default' || type === 'optional') s = s.def.innerType as typeof s;
    else if (type === 'pipe') s = (s.def.in!.def.type === 'transform' ? s.def.out : s.def.in) as typeof s;
    else break;
  }
  if (s.def.type === 'enum') out.options = s.options;
  if (s.def.type === 'number') {
    // explicit bounds only (not .int()'s safe-integer range); an exclusive bound counts for integers only (positive() -> min 1)
    const checks = (s.def.checks ?? []).map((c) => c._zod.def);
    const int = checks.some((c) => c.format === 'safeint');
    for (const c of checks) {
      if (c.value === undefined || (!c.inclusive && !int)) continue;
      if (c.check === 'greater_than') out.min = Math.max(out.min ?? -Infinity, c.inclusive ? c.value : c.value + 1);
      if (c.check === 'less_than') out.max = Math.min(out.max ?? Infinity, c.inclusive ? c.value : c.value - 1);
    }
  }
  return out;
}

function setting(key: Key, meta: Meta): SettingDef {
  const schema = configSchema.shape[key] as z.ZodType;
  const derived = fromSchema(schema);
  if (meta.kind === 'bool') delete derived.options;
  const legacy = RENAMED_ENV[key];
  return {
    key, schema, ...derived, apply: 'live',
    ...(meta.kind === 'secret' ? { secret: true } : {}),
    ...(legacy ? { legacyEnv: [legacy] } : {}),
    ...meta,
  };
}

const oidc = { group: 'signin', probe: 'oidc', runRequired: true } as const;
const authentik = { group: 'signin', probe: 'authentik' } as const;
const portainer = { group: 'updates', probe: 'portainer' } as const;
const hidden = { group: 'signin', visible: false } as const;

export const SETTINGS: readonly SettingDef[] = [
  // general
  setting('PUBLIC_URL', { kind: 'url', group: 'general', probe: 'publicUrl', runRequired: true }),
  setting('WEBHOOK_SECRET', { kind: 'secret', group: 'general', generate: 'webhookSecret' }),
  setting('API_COMPRESSION', { kind: 'bool', group: 'general' }), // read per response (app.ts onSend): applies at once
  // sign-in
  setting('OIDC_ISSUER', { kind: 'url', ...oidc }),
  setting('OIDC_CLIENT_ID', { kind: 'string', ...oidc }),
  setting('OIDC_CLIENT_SECRET', { kind: 'secret', ...oidc }),
  setting('ADMIN_GROUP', { kind: 'string', group: 'signin' }),
  setting('AUTHENTIK_URL', { kind: 'url', ...authentik }),
  setting('AUTHENTIK_API_TOKEN', { kind: 'secret', ...authentik }),
  setting('AUTHENTIK_ENROLL_FLOW', { kind: 'string', ...authentik }),
  // the readers fall back to the same slugs (authentik.ts)
  setting('AUTHENTIK_RECOVERY_FLOW', { kind: 'string', ...authentik, default: 'default-recovery-flow' }),
  setting('AUTHENTIK_TOTP_SETUP_FLOW', { kind: 'string', ...authentik, default: 'default-authenticator-totp-setup' }),
  // media (contributed by the media module)
  ...mediaSettings(),
  // request service
  setting('REQUESTS_URL', { kind: 'url', group: 'requests', probe: 'requests' }),
  setting('REQUESTS_API_KEY', { kind: 'secret', group: 'requests', probe: 'requests' }),
  // notifications
  setting('NTFY_URL', { kind: 'url', group: 'notifications' }),
  setting('NTFY_BASE_URL', { kind: 'url', group: 'notifications' }),
  setting('DISCORD_WEBHOOK_URL', { kind: 'secret', group: 'notifications' }), // the URL carries a token
  // push
  setting('VAPID_PUBLIC_KEY', { kind: 'string', group: 'push', generate: 'vapidPair' }),
  setting('VAPID_PRIVATE_KEY', { kind: 'secret', group: 'push', generate: 'vapidPair' }),
  setting('VAPID_SUBJECT', { kind: 'string', group: 'push' }),
  // data sources
  setting('TMDB_API_KEY', { kind: 'secret', group: 'sources', hint: 'last4', probe: 'tmdb' }),
  setting('OMDB_API_KEY', { kind: 'secret', group: 'sources', hint: 'last4', probe: 'omdb' }),
  // downloads
  setting('DOWNLOADS_ENABLED', { kind: 'bool', group: 'downloads' }),
  setting('DIRECT_PLAY_REQUIRES_DOWNLOAD', { kind: 'bool', group: 'downloads' }),
  setting('DOWNLOAD_CACHE_MAX_GB', { kind: 'number', group: 'downloads' }),
  setting('DOWNLOAD_MIN_FREE_GB', { kind: 'number', group: 'downloads' }),
  setting('DOWNLOAD_PREP_CONCURRENCY', { kind: 'int', group: 'downloads' }),
  setting('DOWNLOAD_PAUSE_STREAMS', { kind: 'int', group: 'downloads' }),
  setting('DOWNLOAD_FILE_TTL_HOURS', { kind: 'number', group: 'downloads' }),
  setting('DOWNLOAD_OFFLINE_GRACE_DAYS', { kind: 'number', group: 'downloads' }),
  setting('DOWNLOAD_CREATE_PER_HOUR', { kind: 'int', group: 'downloads', apply: 'restart' }), // route rate-limit option, read at registration
  // playback
  setting('CAST_ENABLED', { kind: 'bool', group: 'playback' }),
  setting('PREVIEW_WARM', { kind: 'bool', group: 'playback' }),
  setting('HOME_NETWORKS', { kind: 'cidrList', group: 'playback' }),
  // updates
  setting('GITHUB_TOKEN', { kind: 'secret', group: 'updates', probe: 'github' }),
  setting('PORTAINER_WEBHOOK_URL', { kind: 'secret', ...portainer }), // the URL is the credential
  setting('PORTAINER_URL', { kind: 'url', ...portainer }),
  setting('PORTAINER_API_KEY', { kind: 'secret', ...portainer }),
  setting('PORTAINER_STACK_ID', { kind: 'string', ...portainer }),
  setting('PORTAINER_ENDPOINT_ID', { kind: 'int', ...portainer }),
  // health
  setting('PLAYBACK_CHECK_HOUR', { kind: 'int', group: 'health' }),
  setting('HEALTH_DISK_WARN_PCT', { kind: 'int', group: 'health' }),
  setting('HEALTH_DISK_CRIT_PCT', { kind: 'int', group: 'health' }),
  setting('HEALTH_DB_WARN_GB', { kind: 'number', group: 'health' }),
  // sessions
  setting('SESSION_TTL_SECONDS', { kind: 'int', group: 'sessions' }),
  setting('SESSION_IDLE_SECONDS', { kind: 'int', group: 'sessions' }),
  // Block 23 phase 3 (hidden until phase 3 sets visible: true)
  setting('LOGIN_UI', { kind: 'enum', ...hidden }),
  setting('AUTHENTIK_LOGIN_FLOW', { kind: 'string', ...hidden }),
  setting('AUTHENTIK_STATIC_SETUP_FLOW', { kind: 'string', ...hidden }),
  setting('AUTHENTIK_WEBAUTHN_SETUP_FLOW', { kind: 'string', ...hidden }),
  setting('AUTHENTIK_PASSWORD_CHANGE_FLOW', { kind: 'string', ...hidden }),
  setting('AUTHENTIK_INVALIDATION_FLOW', { kind: 'string', ...hidden }),
  setting('AUTHENTIK_EMAIL_CHANGE_FLOW', { kind: 'string', ...hidden }),
  setting('PASSKEYS_IN_APP', { kind: 'enum', ...hidden }),
  setting('LOGIN_COVER_WALL', { kind: 'bool', ...hidden }),
];

/** Per container or per deployment, or shared with a container that reads env only: env > default, read-only in Admin -> Settings. */
export const ENV_ONLY_KEYS: readonly string[] = ['PORT', 'DIGEST_DAY', 'DIGEST_HOUR', 'MEDIA_SERVER', 'METRICS_TOKEN', 'ROLE_TEMPLATES',
  'OIDC_ALLOW_INSECURE', 'PREVIEW_DIR', 'UPDATE_REPO', 'DOWNLOAD_DIR', 'BACKGROUND_JOBS', 'GATEWAY_URL'];
/** Needed before the database can be read: env (incl. _FILE) > bootstrap volume file > default; never stored in the database. */
export const BOOTSTRAP_KEYS: readonly string[] = ['DATABASE_URL', 'REDIS_URL', 'APP_ENC_KEY', 'INTERNAL_SECRET'];
/** Baked into the image at build time. */
export const BUILD_KEYS: readonly string[] = ['GIT_SHA', 'BUILD_TIME', 'APP_VERSION', 'APP_CODENAME'];

const byKey = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key: string): SettingDef | undefined {
  return byKey.get(key);
}

/** An error code per kind when the schema has none of its own (a custom issue's params.code wins, then too_small / too_big). */
const KIND_CODE: Record<SettingKind, string> = {
  string: 'invalid', url: 'invalid_url', secret: 'invalid', int: 'invalid_number', number: 'invalid_number', bool: 'invalid_option',
  enum: 'invalid_option', cidrList: 'invalid_cidr', json: 'invalid_json',
};

/** Parses an env string into the typed value (the same type as in Config); the error is a code, never the value. */
export function parseEnvValue(def: SettingDef, raw: string): { ok: true; value: unknown } | { ok: false; code: string } {
  return parseSettingValue(def, raw);
}

/** parseEnvValue for any schema input (the settings store also passes numbers from stored or submitted JSON). */
export function parseSettingValue(def: SettingDef, input: unknown): { ok: true; value: unknown } | { ok: false; code: string } {
  const r = def.schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0] as { code: string; params?: { code?: unknown } } | undefined;
  const own = issue?.params?.code;
  if (typeof own === 'string') return { ok: false, code: own };
  if (issue?.code === 'too_small' || issue?.code === 'too_big') return { ok: false, code: issue.code };
  return { ok: false, code: KIND_CODE[def.kind] };
}
