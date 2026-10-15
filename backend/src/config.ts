// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { MEDIA_FIELDS, MEDIA_SERVERS } from './media/index.js';
import { isValidCidr } from './netaddr.js';

/**
 * Renamed settings: new name -> old name. The old name (and its _FILE variant) still works, but only while the new
 * name is unset in both forms; using it logs a deprecation warning at startup (see deprecatedEnvNames).
 */
export const RENAMED_ENV: Readonly<Record<string, string>> = {
  REQUESTS_URL: 'SEERR_URL',
  REQUESTS_API_KEY: 'SEERR_API_KEY',
};

/** Copies old setting names onto their new names when the new name is not set (neither VAR nor VAR_FILE). */
function withRenamedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const [now, old] of Object.entries(RENAMED_ENV)) {
    if (env[now] || env[`${now}_FILE`]) continue; // the new name wins
    if (env[old]) out[now] = env[old];
    if (env[`${old}_FILE`]) out[`${now}_FILE`] = env[`${old}_FILE`];
  }
  return out;
}

/**
 * Old setting names that are still set, as "OLD is deprecated, use NEW" messages (names only, never values).
 * Compose passes the old name through next to the new one (which falls back to the old value), so an old name is
 * reported whenever it is set.
 */
export function deprecatedEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [now, old] of Object.entries(RENAMED_ENV)) {
    for (const suffix of ['', '_FILE']) {
      if (env[`${old}${suffix}`]) out.push(`${old}${suffix} is deprecated, use ${now}${suffix}`);
    }
  }
  return out;
}

/** Reads VAR, or the file referenced by VAR_FILE (Docker secrets). */
function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  // Only known settings: unrelated *_FILE variables of the host environment must never be read.
  for (const key of Object.keys(configSchema.shape)) {
    const path = env[`${key}_FILE`];
    if (path) out[key] = readFileSync(path, 'utf8').trim();
  }
  return out;
}

let warnedPublicUrlPath = false;

/**
 * Env layer only: an existing install whose PUBLIC_URL carries a path, query, fragment or credentials keeps starting with its origin
 * (FriendFlix only runs at the root), with one warning that never echoes the raw value. Saved values (DB, wizard) stay strict
 * (publicUrlSchema rejects them with origin_only). The settings resolver's env layer uses the same step.
 */
export function withOriginPublicUrl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = env.PUBLIC_URL;
  if (!raw) return env;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return env; // the schema reports it
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return env;
  if (u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password) return env;
  if (!warnedPublicUrlPath) {
    warnedPublicUrlPath = true;
    console.warn(`PUBLIC_URL has a path, query or credentials; using its origin ${u.origin} (FriendFlix only runs at the root)`);
  }
  return { ...env, PUBLIC_URL: u.origin };
}

const opt = z.string().optional().transform((v) => (v ? v : undefined));
/** compose passes '' for an unset variable */
const emptyAsUnset = (v: unknown) => (v === '' ? undefined : v);
/**
 * Settings that must be set once setup is complete (registry `runRequired`) but may be missing before: validated when set,
 * '' when unset (the type stays string). Routes that need them only run once setup is complete.
 */
const setupRequired = (s: z.ZodType<string, string>) => z.preprocess(emptyAsUnset, s.optional()).transform((v) => v ?? '');
/** a setting first registered for a later block (phase 3 of Block 23): optional, with its default */
const later = (fallback: string) => z.preprocess(emptyAsUnset, z.string().default(fallback));

/** The public app URL is an origin: a trailing slash is dropped; a path, query or fragment is rejected (redirect URIs are built from it). */
export const publicUrlSchema = z.string().transform((v, ctx) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid URL', params: { code: 'invalid_url' } });
    return z.NEVER;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'expected an http(s) URL', params: { code: 'invalid_url' } });
    return z.NEVER;
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    ctx.addIssue({ code: 'custom', message: 'expected an origin without path, e.g. https://tv.example.com', params: { code: 'origin_only' } });
    return z.NEVER;
  }
  return u.origin;
});

/**
 * Every key FriendFlix reads from its environment. This literal object is the type source of Config; settings/registry.ts classifies
 * each key (setting / env-only / bootstrap / build) and uses the field schemas below for settings as well.
 */
export const configSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: setupRequired(publicUrlSchema),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** absolute session lifetime */
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),
  /** sessions without any authenticated request for this long expire (sliding) */
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(2 * 3600),
  /** base64 of 32 random bytes: encrypts Jellyfin passwords/tokens at rest. */
  APP_ENC_KEY: z.string().min(43),
  /** Shared secret between backend and gateway (never reaches browsers). */
  INTERNAL_SECRET: z.string().min(16),
  /** Shared secret for Jellyfin/request service webhooks. */
  WEBHOOK_SECRET: setupRequired(z.string().min(16)),
  ADMIN_GROUP: z.string().default('friendflix-admins'),
  OIDC_ISSUER: setupRequired(z.string().url()),
  OIDC_CLIENT_ID: setupRequired(z.string()),
  OIDC_CLIENT_SECRET: setupRequired(z.string()),
  /** which media server implementation backs this instance (one per instance), see docs/architecture.md "Media server seam" */
  MEDIA_SERVER: z.enum(MEDIA_SERVERS).default('jellyfin'),
  /** the media server kinds' own fields (Jellyfin: JELLYFIN_URL, JELLYFIN_ADMIN_API_KEY), owned by media/index.ts; see mediaSettings() */
  ...MEDIA_FIELDS,
  /** the request service, optional: without URL and key ctx.seerr is null and the request UI is hidden (old names SEERR_URL / SEERR_API_KEY still work, see RENAMED_ENV) */
  REQUESTS_URL: setupRequired(z.string().url()),
  REQUESTS_API_KEY: setupRequired(z.string()),
  NTFY_URL: opt, // e.g. https://ntfy.example.com/friendflix
  DISCORD_WEBHOOK_URL: opt,
  /** personal push (ntfy topics per user): base URL of the ntfy server; default = origin of NTFY_URL */
  NTFY_BASE_URL: opt,
  /** weekly digest: day of week (0 = Sunday, Date.getDay) and local server hour 0-23, -1 = off. Admins can override both in the UI. */
  DIGEST_DAY: z.coerce.number().int().min(0).max(6).default(0),
  DIGEST_HOUR: z.coerce.number().int().min(-1).max(23).default(18),
  /** Web Push (VAPID): enabled only when both keys are set. Generate with scripts/gen-vapid.mjs */
  VAPID_PUBLIC_KEY: opt,
  VAPID_PRIVATE_KEY: opt,
  /** mailto: or https: contact for push services, default PUBLIC_URL */
  VAPID_SUBJECT: opt,
  /** Chromecast sender support (needs a PUBLIC_URL with a valid https certificate) */
  CAST_ENABLED: z.enum(['true', 'false']).default('true'),
  METRICS_TOKEN: opt,
  /** optional external data sources for the detail page (an admin can also save the keys in the UI; a key from env/file wins) */
  TMDB_API_KEY: opt,
  OMDB_API_KEY: opt,
  AUTHENTIK_URL: opt,
  AUTHENTIK_API_TOKEN: opt,
  AUTHENTIK_ENROLL_FLOW: opt,
  /** slug of the recovery flow whose first e-mail stage sends the admin's "password reset" mail (default default-recovery-flow) */
  AUTHENTIK_RECOVERY_FLOW: opt,
  /** slug of the TOTP setup flow (default default-authenticator-totp-setup); reserved for a "send 2FA setup" link */
  AUTHENTIK_TOTP_SETUP_FLOW: opt,
  /** JSON overriding role templates, see roles.ts */
  ROLE_TEMPLATES: opt,
  /** DEV ONLY: allow an http:// OIDC issuer (openid-client requires https otherwise). */
  OIDC_ALLOW_INSECURE: z.enum(['true', 'false']).default('false'),
  /** where the cached hover/billboard preview clips (<itemId>.mp4) are stored */
  PREVIEW_DIR: z.string().default('/data/previews'),
  /** background warmer: pre-generates one missing clip per minute while idle */
  PREVIEW_WARM: z.enum(['true', 'false']).default('true'),
  /** baked into the images at build time (Dockerfile ARG), 'dev' when built locally */
  GIT_SHA: z.string().default('dev').transform((v) => v || 'dev'),
  BUILD_TIME: opt,
  /** release version + codename from version.json, baked into the images at build time; unset = read version.json */
  APP_VERSION: opt,
  APP_CODENAME: opt,
  /** GitHub repo checked for newer versions (Admin -> Update) */
  UPDATE_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('LetsManu/friendflix'),
  GITHUB_TOKEN: opt,
  /** one-click update: Portainer stack webhook, or API (URL + key + stack id) */
  PORTAINER_WEBHOOK_URL: opt,
  PORTAINER_URL: opt,
  PORTAINER_API_KEY: opt,
  PORTAINER_STACK_ID: opt,
  PORTAINER_ENDPOINT_ID: z.coerce.number().int().default(1),
  /** nightly playback check: local server hour 0-23, -1 = off */
  PLAYBACK_CHECK_HOUR: z.coerce.number().int().min(-1).max(23).default(4),
  /** offline downloads ("Herunterladen"); false = off (Plan B) */
  DOWNLOADS_ENABLED: z.enum(['true', 'false']).default('true'),
  // 'true': roles without download permission also lose Direct Play (the original file could be saved); costs transcoding
  DIRECT_PLAY_REQUIRES_DOWNLOAD: z.enum(['true', 'false']).default('false'),
  DOWNLOAD_DIR: z.string().default('/data/downloads'),
  DOWNLOAD_CACHE_MAX_GB: z.coerce.number().positive().default(50),
  /** a preparation only starts while the download volume keeps at least this much free (GB) */
  DOWNLOAD_MIN_FREE_GB: z.coerce.number().min(0).default(2),
  DOWNLOAD_PREP_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** preparation pauses between segments while at least this many live streams run (0 = never pause) */
  DOWNLOAD_PAUSE_STREAMS: z.coerce.number().int().min(0).default(2),
  DOWNLOAD_FILE_TTL_HOURS: z.coerce.number().positive().default(48),
  DOWNLOAD_OFFLINE_GRACE_DAYS: z.coerce.number().positive().default(7),
  /** POST /api/downloads: license creations per hour and session (rate limit) */
  DOWNLOAD_CREATE_PER_HOUR: z.coerce.number().int().positive().default(20),
  /** comma-separated CIDRs counted as the home network (no remote bitrate cap); unknown/ambiguous addresses count as remote */
  HOME_NETWORKS: z.string().default('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7,fe80::/10').transform((v, ctx) => {
    const list = v.split(',').map((c) => c.trim()).filter(Boolean);
    const bad = list.filter((c) => !isValidCidr(c));
    if (bad.length) ctx.addIssue({ code: 'custom', params: { code: 'invalid_cidr' }, message: `HOME_NETWORKS: invalid CIDR ${bad.map((b) => `'${b}'`).join(', ')} (expected e.g. 192.168.0.0/16 or fd00::/8)` });
    return list;
  }),
  BACKGROUND_JOBS: z.enum(['true', 'false']).default('true'),
  /** gzip/brotli for JSON API responses >= 1 KB (off when a reverse proxy already compresses) */
  API_COMPRESSION: z.enum(['true', 'false']).default('true'),
  /** Block 22 admin health: the gateway's internal address (only GET /health is called, no token) */
  GATEWAY_URL: z.string().url().default('http://gateway:4000'),
  /** disk usage levels on the admin health page: warn / critical at this percentage used */
  HEALTH_DISK_WARN_PCT: z.coerce.number().int().min(50).max(99).default(85),
  HEALTH_DISK_CRIT_PCT: z.coerce.number().int().min(51).max(100).default(95),
  /** database size (GB) above which the admin health page warns */
  HEALTH_DB_WARN_GB: z.coerce.number().positive().default(10),
  // Block 23 phase 3 (pre-registered, hidden in Admin -> Settings until phase 3 wires them)
  /** sign-in UI: the app's own pages or Authentik's; unset = phase 3 decides */
  LOGIN_UI: z.preprocess(emptyAsUnset, z.enum(['app', 'authentik']).optional()),
  AUTHENTIK_LOGIN_FLOW: later('default-authentication-flow'),
  AUTHENTIK_STATIC_SETUP_FLOW: later('default-authenticator-static-setup'),
  AUTHENTIK_WEBAUTHN_SETUP_FLOW: later('default-authenticator-webauthn-setup'),
  AUTHENTIK_PASSWORD_CHANGE_FLOW: later('default-password-change'),
  AUTHENTIK_INVALIDATION_FLOW: later('default-invalidation-flow'),
  AUTHENTIK_EMAIL_CHANGE_FLOW: later('friendflix-email-change'),
  PASSKEYS_IN_APP: z.preprocess(emptyAsUnset, z.enum(['auto', 'off']).default('auto')),
  LOGIN_COVER_WALL: z.preprocess(emptyAsUnset, z.enum(['true', 'false']).default('true')),
});

export type Config = z.infer<typeof configSchema>;

/** The origin browsers use (Origin header checks); null while PUBLIC_URL is not set yet (setup), which matches no request. */
export function publicOrigin(cfg: Pick<Config, 'PUBLIC_URL'>): string | null {
  try {
    return cfg.PUBLIC_URL ? new URL(cfg.PUBLIC_URL).origin : null;
  } catch {
    return null;
  }
}

/** Cookies get the Secure flag when the app is served over https. */
export const secureCookies = (cfg: Pick<Config, 'PUBLIC_URL'>): boolean => cfg.PUBLIC_URL.startsWith('https://');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = configSchema.parse(withOriginPublicUrl(withFileSecrets(withRenamedEnv(env))));
  // yellow must come before red: a warn level at or above the critical one would never show, so both fall back to the defaults
  if (c.HEALTH_DISK_WARN_PCT >= c.HEALTH_DISK_CRIT_PCT) {
    console.warn(`HEALTH_DISK_WARN_PCT (${c.HEALTH_DISK_WARN_PCT}) must be below HEALTH_DISK_CRIT_PCT (${c.HEALTH_DISK_CRIT_PCT}); using 85 / 95`);
    return { ...c, HEALTH_DISK_WARN_PCT: 85, HEALTH_DISK_CRIT_PCT: 95 };
  }
  return c;
}
