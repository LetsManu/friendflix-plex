// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { buildApp, type Extra } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createLiveCtx, type Ctx } from '../src/ctx.js';
import { keyFromBase64 } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { MemoryKV } from '../src/kv.js';
import { createMediaServer } from '../src/media/index.js'; // fork
import { SeerrClient } from '../src/seerr/client.js';
import type { OidcClaims } from '../src/oidc.js';
import { DEFAULT_ROLES } from '../src/roles.js';
import { MemorySettingsBus } from '../src/settings/bus.js';
import { settingDef } from '../src/settings/registry.js';
import { updateMeta, writeRows } from '../src/settings/repo.js';
import { toStored } from '../src/settings/resolve.js';
import { createSettingsStore, type SettingsStore } from '../src/settings/store.js';
import { isSetupComplete } from '../src/setup/state.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from './plexfake.js'; // fork
import type { PlexMediaServer } from '../src/plex/service.js'; // fork

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/ff_test';
export const ENC_KEY = Buffer.alloc(32, 7).toString('base64');

export const cfg: Config = {
  PORT: 3000, PUBLIC_URL: 'https://portal.example.com', DATABASE_URL: TEST_DB, REDIS_URL: 'redis://x', SESSION_TTL_SECONDS: 600, SESSION_IDLE_SECONDS: 300,
  APP_ENC_KEY: ENC_KEY, INTERNAL_SECRET: 'internal-secret-123456', WEBHOOK_SECRET: 'webhook-secret-123456', ADMIN_GROUP: 'friendflix-admins',
  OIDC_ISSUER: 'https://auth.example.com/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
  MEDIA_SERVER: 'jellyfin', JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'adminkey', PLEX_URL: undefined, PLEX_TOKEN: undefined /* fork */, REQUESTS_URL: 'http://requests:5055', REQUESTS_API_KEY: 'seerrkey',
  NTFY_URL: undefined, DISCORD_WEBHOOK_URL: undefined, METRICS_TOKEN: undefined, TMDB_API_KEY: undefined, OMDB_API_KEY: undefined, AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined,
  AUTHENTIK_ENROLL_FLOW: undefined, AUTHENTIK_RECOVERY_FLOW: undefined, AUTHENTIK_TOTP_SETUP_FLOW: undefined, ROLE_TEMPLATES: undefined, OIDC_ALLOW_INSECURE: 'false', BACKGROUND_JOBS: 'false',
  RECO_W_GENRES: 1, RECO_W_TAGS: 0.6, RECO_W_STUDIOS: 0.4, RECO_W_PEOPLE: 0.8, RECO_W_TEXT: 1, RECO_W_NUMERIC: 0.3, RECO_W_COLLECTION: 1.5,
  RECO_ENGINE: 'v1', RECO_HALF_LIFE_DAYS: 120, RECO_COEFFS: undefined, RECO_EXPLORE: 0,
  PREVIEW_DIR: '/tmp/ff-test-previews', PREVIEW_WARM: 'false',
  DOWNLOADS_ENABLED: 'true', DIRECT_PLAY_REQUIRES_DOWNLOAD: 'false', DOWNLOAD_DIR: '/tmp/ff-test-downloads', DOWNLOAD_CACHE_MAX_GB: 50, DOWNLOAD_MIN_FREE_GB: 0, DOWNLOAD_PREP_CONCURRENCY: 1, DOWNLOAD_PAUSE_STREAMS: 2, DOWNLOAD_FILE_TTL_HOURS: 48, DOWNLOAD_OFFLINE_GRACE_DAYS: 7, DOWNLOAD_CREATE_PER_HOUR: 10_000,
  PLAYBACK_CHECK_HOUR: 4, NTFY_BASE_URL: undefined, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined, DIGEST_DAY: 0, DIGEST_HOUR: 18,
  CAST_ENABLED: 'true', GIT_SHA: 'dev', BUILD_TIME: undefined, APP_VERSION: undefined, APP_CODENAME: undefined, UPDATE_REPO: 'LetsManu/friendflix-plex', UPDATE_CHANNEL: 'stable', GITHUB_TOKEN: undefined, PORTAINER_WEBHOOK_URL: undefined, PORTAINER_URL: undefined,
  PORTAINER_API_KEY: undefined, PORTAINER_STACK_ID: undefined, PORTAINER_ENDPOINT_ID: 1, API_COMPRESSION: 'true', HOME_NETWORKS: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'],
  GATEWAY_URL: 'http://gateway:4000', HEALTH_DISK_WARN_PCT: 85, HEALTH_DISK_CRIT_PCT: 95, HEALTH_DB_WARN_GB: 10,
  LOGIN_UI: undefined, AUTHENTIK_LOGIN_FLOW: 'default-authentication-flow', AUTHENTIK_STATIC_SETUP_FLOW: 'default-authenticator-static-setup',
  AUTHENTIK_WEBAUTHN_SETUP_FLOW: 'default-authenticator-webauthn-setup', AUTHENTIK_PASSWORD_CHANGE_FLOW: 'default-password-change',
  AUTHENTIK_INVALIDATION_FLOW: 'default-invalidation-flow', AUTHENTIK_EMAIL_CHANGE_FLOW: 'friendflix-email-change', PASSKEYS_IN_APP: 'auto', LOGIN_COVER_WALL: 'true', POSTPLAY_ENABLED: 'true',
};

export type Handler = (url: URL, init: RequestInit, body: any) => { status?: number; json?: unknown; raw?: string | Uint8Array; type?: string } | undefined;
export interface Call { method: string; host?: string; path: string; search: string; body: any; auth?: string }

/** In-memory fake of the Jellyfin/Seerr HTTP APIs: routes are matched by "METHOD /path". */
export function fakeHttp(routes: Record<string, Handler>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, host: url.host, path: url.pathname, search: url.search, body, auth: (init.headers as Record<string, string> | undefined)?.Authorization });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && new RegExp(`^${p}$`).test(url.pathname);
    });
    const r = key ? routes[key]!(url, init, body) : undefined;
    const status = r?.status ?? (key ? 200 : 404);
    if (r?.raw !== undefined) return new Response(r.raw as BodyInit, { status, ...(r.type ? { headers: { 'content-type': r.type } } : {}) });
    return new Response(status === 204 || r?.json === undefined ? null : JSON.stringify(r.json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

export async function resetDb(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: TEST_DB, max: 5 });
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  return pool;
}

export interface TestEnv {
  ctx: Ctx;
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: pg.Pool;
  jfCalls: Call[];
  seerrCalls: Call[];
  claims: { current: OidcClaims };
  kv: MemoryKV;
  login: (claims?: OidcClaims) => Promise<{ cookies: Record<string, string>; csrf: string }>;
  close: () => Promise<void>;
  /** fork: makeEnv(…, { server: 'plex' }): the Plex implementation (the current ctx.jf, already synced once) and its fake server */
  plex?: { readonly ms: PlexMediaServer; fake: PlexFake };
}

export const ADMIN: OidcClaims = { sub: 'sub-admin', email: 'admin@example.com', name: 'Admin', groups: ['friendflix-admins'] };

export function defaultJellyfin(): Record<string, Handler> {
  let n = 0;
  return {
    'POST /Users/New': (_u, _i, b) => ({ json: { Id: `jf${String(++n).padStart(30, '0')}ab`, Name: b.Name } }),
    'GET /Users/[^/]+': () => ({ json: { Policy: { IsAdministrator: false, Keep: 'me' } } }),
    'POST /Users/[^/]+/Policy': () => ({ status: 204 }),
    'POST /Users/AuthenticateByName': (_u, _i, b) => ({ json: { AccessToken: `tok-${b.Username}`, User: { Id: 'x', Name: b.Username } } }),
    'GET /Library/MediaFolders': () => ({ json: { Items: [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }] } }),
    'GET /System/Ping': () => ({ json: 'Jellyfin Server' }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The test store: a real settings store plus the override behind `ctx.cfg = {...}` in tests. An override keeps the keys that differ from
 * the store's snapshot and reports them as 'env' (like a value from the environment); a save of an overridden key drops its override.
 */
export interface TestSettings extends SettingsStore { override(next: Config): void }

function withOverride(inner: SettingsStore): TestSettings {
  let patch: Partial<Config> = {};
  let merged: { base: Config; patch: Partial<Config>; cfg: Config } | undefined;
  const current = (): Config => {
    const base = inner.current();
    if (!Object.keys(patch).length) return base;
    if (merged?.base !== base || merged.patch !== patch) merged = { base, patch, cfg: Object.freeze({ ...base, ...patch }) };
    return merged.cfg;
  };
  return {
    ...inner,
    current,
    sources: () => ({ ...inner.sources(), ...Object.fromEntries(Object.keys(patch).map((k) => [k, 'env' as const])) }),
    async save(changes, actor) {
      patch = Object.fromEntries(Object.entries(patch).filter(([k]) => !(k in changes)));
      return inner.save(changes, actor);
    },
    override(next) {
      const base = inner.current() as Record<string, unknown>;
      patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(v, base[k])));
    },
  };
}

/**
 * A settings store holding the test config: settings as database rows (saves work), every other key as env. `extraEnv` adds real
 * environment variables (VAR or VAR_FILE); the keys they name are neither stored as rows nor compared with the test config.
 */
export async function testSettings(pool: pg.Pool, c: Config = cfg, extraEnv: NodeJS.ProcessEnv = {}): Promise<TestSettings> {
  const fromEnv = new Set(Object.keys(extraEnv).map((k) => k.replace(/_FILE$/, '')));
  const env: NodeJS.ProcessEnv = {};
  const rows: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || fromEnv.has(k)) continue;
    const def = settingDef(k);
    if (def) rows[k] = toStored(def, v);
    else env[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  Object.assign(env, extraEnv);
  await writeRows(pool, keyFromBase64(ENC_KEY), rows, null);
  const store = withOverride(await createSettingsStore({ db: pool, encKey: keyFromBase64(ENC_KEY), env, bus: new MemorySettingsBus(), log: { warn: () => {} }, pollMs: 3_600_000 }));
  const got = store.current() as Record<string, unknown>;
  const off = Object.keys(c).filter((k) => !fromEnv.has(k) && !same(got[k], (c as Record<string, unknown>)[k]));
  if (off.length) throw new Error(`test settings differ from the test config: ${off.join(', ')}`);
  return store;
}

/**
 * A test app over a fresh database. Setup counts as complete unless `setupComplete: false` (the setup gate's own tests): most tests
 * exercise the running app, and a fresh database is otherwise in setup mode (spec Part E).
 */
export async function makeEnv(extraJf: Record<string, Handler> = {}, extra: Extra & { ctxPatch?: (c: Ctx) => void; seerr?: Record<string, Handler>; settingsEnv?: NodeJS.ProcessEnv; setupComplete?: boolean; server?: 'plex'; plexFake?: PlexFake; plexFetch?: (fake: PlexFake) => typeof fetch } = {}): Promise<TestEnv> { // fork: server, plexFake, plexFetch
  const pool = await resetDb();
  if (extra.setupComplete !== false) await updateMeta(pool, { setupCompletedAt: new Date() });
  const kv = new MemoryKV();
  const jfCalls: Call[] = [];
  const seerrCalls: Call[] = [];
  const claims = { current: ADMIN };
  const jfFetch = fakeHttp({ ...defaultJellyfin(), ...extraJf }, jfCalls);
  const seerrFetch = fakeHttp(extra.seerr ?? {}, seerrCalls);
  const encKey = keyFromBase64(ENC_KEY);
  // fork: makeEnv(…, { server: 'plex' }) sets MEDIA_SERVER=plex and PLEX_URL/PLEX_TOKEN as settings; the media factory then
  // builds the real PlexMediaServer over the fake (plexFetch: a wrapper around fake.fetch, e.g. a transcoder fake)
  const plexFake = extra.server === 'plex' ? extra.plexFake ?? new PlexFake() : undefined;
  const settings = await testSettings(pool, plexFake ? { ...cfg, MEDIA_SERVER: 'plex', PLEX_URL, PLEX_TOKEN } : cfg, extra.settingsEnv);
  const live = createLiveCtx({
    settings, kv, db: pool, encKey, fetchImpl: fetch,
    roles: DEFAULT_ROLES,
    // fork: the real factory (Jellyfin: the same JellyfinService as before; Plex: PlexMediaServer over the fake)
    media: (c) => createMediaServer({ cfg: c, kv, db: pool, encKey, fetchImpl: plexFake ? (extra.plexFetch?.(plexFake) ?? plexFake.fetch) : jfFetch }),
    requests: (c) => new SeerrClient(c.REQUESTS_URL, c.REQUESTS_API_KEY, seerrFetch),
    oidc: {
      // silent (the in-app sign-in's authorize): prompt=none, as the real provider sends it
      start: async (o) => ({ url: `https://idp/authorize${o?.silent ? '?prompt=none' : ''}`, state: 's' + Math.random().toString(36).slice(2), nonce: 'n', codeVerifier: 'v' }),
      finish: async () => ({ authTime: Math.floor(Date.now() / 1000), ...claims.current }), // a fresh IdP login unless a test sets authTime
    },
    overrideCfg: (c) => settings.override(c),
    log: { warn: () => {} },
  });
  const { ctx } = live;
  const plex: TestEnv['plex'] = plexFake ? // fork
    { get ms() { return ctx.jf as PlexMediaServer; }, fake: plexFake } : undefined;
  await plex?.ms.sync.run();
  extra.ctxPatch?.(ctx);
  await isSetupComplete(ctx); // warms the cache isOperational reads (server.ts does the same before the timers start)
  const app = await buildApp(ctx, extra);
  const dev: { v?: string } = {};
  const login = async (c: OidcClaims = claims.current) => {
    claims.current = c;
    const l = await app.inject('/auth/login?classic=1'); // the IdP redirect, also when LOGIN_UI is app
    const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value; // the login cookie carries the state
    const cb = await app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ...(dev.v ? { ff_dev: dev.v } : {}), ff_oidc: state } });
    dev.v = cb.cookies.find((x) => x.name === 'ff_dev')?.value ?? dev.v; // same browser -> same device
    if (cb.statusCode !== 302) throw new Error(`login failed ${cb.statusCode} ${cb.body}`);
    const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
    const me = await app.inject({ url: '/api/me', cookies: { ff_sid: sid } });
    return { cookies: { ff_sid: sid }, csrf: me.json().csrfToken as string };
  };
  return { ctx, app, pool, jfCalls, seerrCalls, claims, kv, login, plex, close: async () => { await live.close(); await plex?.ms.stop(); await settings.close(); await app.close(); await pool.end(); } }; // fork: plex, plex?.ms.stop()
}

