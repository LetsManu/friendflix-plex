import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { MEDIA_SERVERS } from './media/index.js';

/** Reads VAR, or the file referenced by VAR_FILE (Docker secrets). */
function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  // Only known settings: unrelated *_FILE variables of the host environment must never be read.
  for (const key of Object.keys(schema.shape)) {
    const path = env[`${key}_FILE`];
    if (path) out[key] = readFileSync(path, 'utf8').trim();
  }
  return out;
}

const opt = z.string().optional().transform((v) => (v ? v : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.string().url(),
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
  /** Shared secret for Jellyfin/Seerr webhooks. */
  WEBHOOK_SECRET: z.string().min(16),
  ADMIN_GROUP: z.string().default('friendflix-admins'),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  /** which media server implementation backs this instance (one per instance), see docs/architecture.md "Media server seam" */
  MEDIA_SERVER: z.enum(MEDIA_SERVERS).default('jellyfin'),
  /** required when MEDIA_SERVER=jellyfin (see the check below) */
  JELLYFIN_URL: z.string().url().optional(),
  JELLYFIN_ADMIN_API_KEY: opt,
  SEERR_URL: z.string().url(),
  SEERR_API_KEY: z.string().min(1),
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
  AUTHENTIK_URL: opt,
  AUTHENTIK_API_TOKEN: opt,
  AUTHENTIK_ENROLL_FLOW: opt,
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
  BACKGROUND_JOBS: z.enum(['true', 'false']).default('true'),
  /** gzip/brotli for JSON API responses >= 1 KB (off when a reverse proxy already compresses) */
  API_COMPRESSION: z.enum(['true', 'false']).default('true'),
});

/** Settings each media server kind needs (another kind adds its own entry). */
const MEDIA_REQUIRED: Record<(typeof MEDIA_SERVERS)[number], Array<keyof z.infer<typeof schema>>> = {
  jellyfin: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'],
};

const checked = schema.superRefine((c, ctx) => {
  for (const k of MEDIA_REQUIRED[c.MEDIA_SERVER] ?? []) {
    if (c[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required for MEDIA_SERVER=${c.MEDIA_SERVER}` });
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return checked.parse(withFileSecrets(env));
}
