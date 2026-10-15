// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { pushEnabled } from '../src/push.js';
import { CREDENTIAL_DESTINATIONS, generateVapidPair, generateWebhookSecret, NO_DESTINATION } from '../src/routes/adminSettings.js';
import { SETTINGS, settingDef } from '../src/settings/registry.js';
import { ADMIN, cfg, ENC_KEY, fakeHttp, makeEnv, type Handler, type TestEnv } from './helpers.js';

// Admin -> Settings API (Block 25, spec Part I): write-only secrets, locked env keys, validation, probes against the candidate config,
// re-authentication for sensitive keys, env import, generated secrets, audit with key names only, and no secret in any log line.
type Sess = { cookies: Record<string, string>; csrf: string };
const DORA = { sub: 'sub-dora', email: 'dora@example.com', name: 'Dora', groups: [] as string[] };

const SECRETS = {
  oidcEnv: 'env-oidc-secret-AAAA9911',
  jfFile: 'file-jf-key-BBBB9922',
  tmdbDb: 'db-tmdb-key-EEEE1234',
  dbPass: 'db-pass-CCCC9933',
  metrics: 'metrics-token-DDDD9944',
};

function harness(opts: { settingsEnv?: NodeJS.ProcessEnv; logs?: string[] } = {}) {
  const h = {
    env: undefined as unknown as TestEnv,
    admin: undefined as unknown as Sess,
    /** the probes' HTTP world (ctx.fetchImpl), replaceable per test */
    probe: {} as Record<string, Handler>,
    /** every host a probe called */
    hosts: [] as string[],
    as: (s: Sess, method: string, url: string, payload?: unknown) =>
      h.env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object }),
    /** stamps a re-authentication on the admin session (phase 2's reauthAt) */
    reauth: async (s: Sess, at = Date.now()) => {
      const key = `sess:${s.cookies.ff_sid}`;
      await h.env.kv.set(key, JSON.stringify({ ...JSON.parse((await h.env.kv.get(key))!), reauthAt: at }), 600);
    },
    put: (values: Record<string, unknown>, force?: boolean) => h.as(h.admin, 'PUT', '/api/admin/settings', { values, ...(force === undefined ? {} : { force }) }),
    audits: async (action: string) => (await h.env.pool.query<{ meta: unknown }>('select meta from audit_log where action=$1 order by id', [action])).rows.map((r) => r.meta),
  };
  beforeAll(async () => {
    const stream = opts.logs ? { write: (m: string) => { opts.logs!.push(m); } } : undefined;
    h.env = await makeEnv({}, {
      settingsEnv: opts.settingsEnv,
      ctxPatch: (c) => {
        c.fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
          h.hosts.push(new URL(i instanceof Request ? i.url : String(i)).host);
          return fakeHttp(h.probe)(i, init);
        }) as typeof fetch;
      },
      ...(stream ? { logger: { stream, level: 'trace' } } : {}),
    });
    h.admin = await h.env.login(ADMIN);
  });
  afterAll(() => h.env.close());
  return h;
}

describe('settings with values from env, a secret file and the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-settings-'));
  writeFileSync(join(dir, 'jf'), `${SECRETS.jfFile}\n`);
  const h = harness({
    settingsEnv: {
      OIDC_CLIENT_SECRET: SECRETS.oidcEnv,
      JELLYFIN_ADMIN_API_KEY_FILE: join(dir, 'jf'),
      PREVIEW_WARM: 'false',
      NTFY_URL: 'https://ntfy.example.com/friendflix?auth=ntfy-token-FFFF9955',
      DATABASE_URL: `postgres://friendflix:${SECRETS.dbPass}@postgres:5432/friendflix`,
      METRICS_TOKEN: SECRETS.metrics,
    },
  });

  it('GET never contains a secret value from env, file or db; last4 only for hint keys', async () => {
    await h.env.ctx.settings.save({ TMDB_API_KEY: SECRETS.tmdbDb }, null);
    const r = await h.as(h.admin, 'GET', '/api/admin/settings');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const text = JSON.stringify(body);
    for (const v of [...Object.values(SECRETS), ENC_KEY, cfg.INTERNAL_SECRET, cfg.WEBHOOK_SECRET, cfg.REQUESTS_API_KEY]) expect(text).not.toContain(v);
    for (const d of SETTINGS.filter((s) => s.secret)) {
      const v = (h.env.ctx.cfg as Record<string, unknown>)[d.key];
      if (typeof v === 'string' && v) expect(text).not.toContain(v);
    }
    const items = new Map<string, any>(body.groups.flatMap((g: any) => g.items.map((i: any) => [i.key, { ...i, group: g.id }])));
    expect(items.get('TMDB_API_KEY')).toMatchObject({ source: 'db', set: true, value: null, last4: '1234', kind: 'secret', invalid: false });
    expect(items.get('TMDB_API_KEY').updatedAt).toEqual(expect.any(String));
    expect(items.get('OIDC_CLIENT_SECRET')).toMatchObject({ source: 'env', set: true, value: null, group: 'signin', envNames: ['OIDC_CLIENT_SECRET', 'OIDC_CLIENT_SECRET_FILE'] });
    expect(items.get('OIDC_CLIENT_SECRET').last4).toBeUndefined();
    expect(items.get('JELLYFIN_ADMIN_API_KEY')).toMatchObject({ source: 'env', set: true, value: null, group: 'media' });
    expect(items.get('PREVIEW_WARM')).toMatchObject({ source: 'env', value: false, kind: 'bool' });
    expect(items.get('REQUESTS_URL')).toMatchObject({ source: 'db', value: cfg.REQUESTS_URL, envNames: ['REQUESTS_URL', 'REQUESTS_URL_FILE', 'SEERR_URL', 'SEERR_URL_FILE'] });
    expect(items.get('API_COMPRESSION')).toMatchObject({ apply: 'live', restartPending: false });
    expect(items.get('DOWNLOAD_CREATE_PER_HOUR')).toMatchObject({ apply: 'restart', restartPending: false });
    expect(items.get('HEALTH_DISK_WARN_PCT')).toMatchObject({ min: 50, max: 99 });
    expect(items.get('WEBHOOK_SECRET')).toMatchObject({ generate: 'webhookSecret' });
    // hidden (phase 3) keys are left out; env-only and bootstrap keys are in "server" without secret values
    expect(items.has('LOGIN_UI')).toBe(false);
    expect(items.get('DATABASE_URL')).toMatchObject({ group: 'server', source: 'env', set: true, value: null });
    expect(items.get('APP_ENC_KEY')).toMatchObject({ group: 'server', set: true, value: null });
    expect(items.get('METRICS_TOKEN')).toMatchObject({ group: 'server', source: 'env', set: true, value: null });
    expect(items.get('MEDIA_SERVER')).toMatchObject({ group: 'server', value: 'jellyfin' });
    // a credential inside a shown URL is redacted
    expect(items.get('NTFY_URL')).toMatchObject({ source: 'env', value: 'https://ntfy.example.com/friendflix?auth=redacted' });
    expect(text).not.toContain('ntfy-token-FFFF9955');
    expect(body.groups.map((g: any) => g.id).at(-1)).toBe('server');
    expect(body.rev).toEqual(expect.any(Number));
    expect(body.pendingRestart).toEqual([]);
  });

  it('an undecryptable stored secret shows invalid: true, set: false', async () => {
    await h.env.pool.query("insert into settings(key, enc) values ('AUTHENTIK_API_TOKEN', $1)", [encrypt(Buffer.alloc(32, 9), 'other-key-token')]);
    await h.env.ctx.settings.reload();
    const body = (await h.as(h.admin, 'GET', '/api/admin/settings')).json();
    const item = body.groups.flatMap((g: any) => g.items).find((i: any) => i.key === 'AUTHENTIK_API_TOKEN');
    expect(item).toMatchObject({ invalid: true, set: false, value: null });
    await h.env.pool.query("delete from settings where key='AUTHENTIK_API_TOKEN'");
    await h.env.ctx.settings.reload();
  });

  it('PUT of an env-locked key -> 400 locked; METRICS_TOKEN and hidden keys -> unknown', async () => {
    const r = await h.put({ PREVIEW_WARM: true });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toEqual({ PREVIEW_WARM: 'locked' });
    expect((await h.put({ METRICS_TOKEN: 'x', NOPE: 1, LOGIN_UI: 'app' })).json().errors).toEqual({ METRICS_TOKEN: 'unknown', NOPE: 'unknown', LOGIN_UI: 'unknown' });
    await h.reauth(h.admin);
    expect((await h.put({ OIDC_CLIENT_SECRET: 'new' })).json().errors).toEqual({ OIDC_CLIENT_SECRET: 'locked' });
  });

  it('import-env all moves exactly the env-set settings (env keeps winning) and is audited with key names', async () => {
    const r = await h.as(h.admin, 'POST', '/api/admin/settings/import-env', { keys: 'all' });
    expect(r.statusCode).toBe(200);
    expect([...r.json().moved].sort()).toEqual(['JELLYFIN_ADMIN_API_KEY', 'NTFY_URL', 'OIDC_CLIENT_SECRET', 'PREVIEW_WARM']);
    const rows = (await h.env.pool.query<{ key: string; value: unknown; enc: string | null }>("select key, value, enc from settings where key in ('OIDC_CLIENT_SECRET','PREVIEW_WARM')")).rows;
    expect(rows.find((x) => x.key === 'OIDC_CLIENT_SECRET')).toMatchObject({ value: null, enc: expect.any(String) });
    expect(rows.find((x) => x.key === 'PREVIEW_WARM')).toMatchObject({ value: false, enc: null });
    expect(h.env.ctx.settings.sources().OIDC_CLIENT_SECRET).toBe('env');
    const meta = await h.audits('settings.import_env');
    expect(meta).toHaveLength(1);
    expect(meta[0]).toEqual({ keys: r.json().moved });
    expect(JSON.stringify(meta)).not.toContain(SECRETS.oidcEnv);
    expect((await h.as(h.admin, 'POST', '/api/admin/settings/import-env', { keys: ['NOPE'] })).json().errors).toEqual({ NOPE: 'unknown' });
  });
});

describe('PUT /api/admin/settings', () => {
  const h = harness();

  it('a plain key saves without re-authentication, audited with { keys } only', async () => {
    const r = await h.put({ CAST_ENABLED: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ rev: expect.any(Number) });
    expect(h.env.ctx.cfg.CAST_ENABLED).toBe('false');
    expect(await h.audits('settings.update')).toEqual([{ keys: ['CAST_ENABLED'] }]);
    await h.put({ CAST_ENABLED: true });
  });

  it('a secret without recent re-authentication -> 401 reauth_required; within 10 min -> 200', async () => {
    const hook = 'https://discord.com/api/webhooks/1/secret-token-XYZ';
    await h.reauth(h.admin, Date.now() - 11 * 60_000);
    for (const values of [{ DISCORD_WEBHOOK_URL: hook }, { ADMIN_GROUP: 'other' }, { AUTHENTIK_ENROLL_FLOW: 'x' }, { OIDC_CLIENT_ID: 'x' }, { JELLYFIN_URL: 'http://evil.example.com' },
      { NTFY_URL: 'https://evil.example.com/t' }, { NTFY_BASE_URL: 'https://evil.example.com' }, { PUBLIC_URL: 'https://evil.example.com' },
      { HOME_NETWORKS: ['0.0.0.0/0'] }]) {
      const r = await h.put(values);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'reauth_required' });
    }
    // session lifetimes stay without re-authentication
    expect((await h.put({ SESSION_TTL_SECONDS: cfg.SESSION_TTL_SECONDS, SESSION_IDLE_SECONDS: cfg.SESSION_IDLE_SECONDS })).statusCode).toBe(200);
    await h.reauth(h.admin);
    const ok = await h.put({ DISCORD_WEBHOOK_URL: hook });
    expect(ok.statusCode).toBe(200);
    expect(h.env.ctx.cfg.DISCORD_WEBHOOK_URL).toBe(hook);
    const audit = await h.audits('settings.update');
    expect(audit.at(-1)).toEqual({ keys: ['DISCORD_WEBHOOK_URL'] });
    expect(JSON.stringify(audit)).not.toContain('secret-token-XYZ');
  });

  it('validation: schema codes, http(s) URLs only, run-required keys cannot be cleared, warn < critical', async () => {
    await h.reauth(h.admin);
    const r = await h.put({
      SESSION_TTL_SECONDS: -1, NTFY_URL: 'javascript:alert(1)', NTFY_BASE_URL: 'file:///etc/passwd', AUTHENTIK_URL: 'ftp://auth.example.com',
      PORTAINER_URL: 'gopher://x', OIDC_CLIENT_SECRET: null, JELLYFIN_URL: '', HEALTH_DISK_WARN_PCT: 96,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      error: 'invalid_settings',
      errors: {
        SESSION_TTL_SECONDS: 'too_small', NTFY_URL: 'invalid_url', NTFY_BASE_URL: 'invalid_url', AUTHENTIK_URL: 'invalid_url', PORTAINER_URL: 'invalid_url',
        OIDC_CLIENT_SECRET: 'required', JELLYFIN_URL: 'required', HEALTH_DISK_WARN_PCT: 'warn_above_critical',
      },
    });
    expect((await h.put({ HEALTH_DISK_CRIT_PCT: 85 })).json().errors).toEqual({ HEALTH_DISK_CRIT_PCT: 'warn_above_critical' });
    // credentials never go into a URL setting (they would be shown in Admin -> Settings)
    expect((await h.put({ NTFY_URL: 'https://user:pass@ntfy.example.com/t' })).json().errors).toEqual({ NTFY_URL: 'invalid_url' });
    // the shown redaction marker never goes back as the token (an edited redacted URL), on save and on test
    const ntfy = h.env.ctx.cfg.NTFY_URL;
    const red = await h.put({ NTFY_URL: 'https://ntfy.example.com/other?auth=redacted' });
    expect(red.statusCode).toBe(400);
    expect(red.json().errors).toEqual({ NTFY_URL: 'redacted' });
    expect((await h.put({ NTFY_BASE_URL: 'https://ntfy.example.com/?x=redacted' })).json().errors).toEqual({ NTFY_BASE_URL: 'redacted' });
    expect(h.env.ctx.cfg.NTFY_URL).toBe(ntfy);
    expect((await h.put({ NTFY_URL: 'https://ntfy.example.com/redacted?auth=tk_real' })).statusCode).toBe(200);
    expect(h.env.ctx.cfg.OIDC_CLIENT_SECRET).toBe(cfg.OIDC_CLIENT_SECRET);
    // a valid change of both levels together is fine; '' resets a non-required key to its default
    expect((await h.put({ HEALTH_DISK_WARN_PCT: 90, HEALTH_DISK_CRIT_PCT: 97 })).statusCode).toBe(200);
    expect((await h.put({ HEALTH_DISK_WARN_PCT: '', HEALTH_DISK_CRIT_PCT: null })).statusCode).toBe(200);
    expect(h.env.ctx.cfg.HEALTH_DISK_WARN_PCT).toBe(85);
    expect((await h.as(h.admin, 'PUT', '/api/admin/settings', { values: 'x' })).statusCode).toBe(400);
  });

  it('a probe answering 401 for JELLYFIN_URL -> 400 not_admin and nothing is saved', async () => {
    await h.reauth(h.admin);
    h.probe = { 'GET /Auth/Keys': () => ({ status: 401 }) };
    const before = h.env.ctx.settings.rev();
    const r = await h.put({ JELLYFIN_URL: 'http://media.internal:8096' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'probe_failed', group: 'media', probe: { ok: false, code: 'not_admin' } });
    expect(h.env.ctx.cfg.JELLYFIN_URL).toBe(cfg.JELLYFIN_URL);
    expect(h.env.ctx.settings.rev()).toBe(before);
    // force never overrides a hard failure
    expect((await h.put({ JELLYFIN_URL: 'http://media.internal:8096' }, true)).statusCode).toBe(400);
  });

  it('the probe tests the candidate (new URL with the saved key); timeout blocks unless force', async () => {
    await h.reauth(h.admin);
    const seen: string[] = [];
    h.probe = {
      'GET /Auth/Keys': (u, init) => {
        seen.push(`${u.host} ${(init.headers as Record<string, string>).Authorization}`);
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
    };
    const r = await h.put({ JELLYFIN_URL: 'http://media.internal:8096' });
    expect(r.statusCode).toBe(400);
    expect(r.json().probe).toEqual({ ok: false, code: 'timeout' });
    expect(seen[0]).toMatch(/^media\.internal:8096 .*Token="adminkey"/);
    const forced = await h.put({ JELLYFIN_URL: 'http://media.internal:8096' }, true);
    expect(forced.statusCode).toBe(200);
    expect(h.env.ctx.cfg.JELLYFIN_URL).toBe('http://media.internal:8096');
    h.probe = { 'GET /Auth/Keys': () => ({ json: {} }) };
    expect((await h.put({ JELLYFIN_URL: cfg.JELLYFIN_URL })).statusCode).toBe(200);
  });

  it('clearing a whole optional group skips its probe; a group that stays configured is probed', async () => {
    await h.reauth(h.admin);
    h.probe = {};
    expect((await h.put({ REQUESTS_URL: null, REQUESTS_API_KEY: null })).statusCode).toBe(200);
    expect(h.env.ctx.seerr).toBeNull();
    h.probe = { 'GET /api/v1/request/count': () => ({ status: 401 }) };
    const r = await h.put({ REQUESTS_URL: cfg.REQUESTS_URL, REQUESTS_API_KEY: 'wrong-key' });
    expect(r.json()).toMatchObject({ group: 'requests', probe: { code: 'unauthorized' } });
    h.probe = { 'GET /api/v1/request/count': () => ({ json: { total: 1 } }) };
    expect((await h.put({ REQUESTS_URL: cfg.REQUESTS_URL, REQUESTS_API_KEY: cfg.REQUESTS_API_KEY })).statusCode).toBe(200);
  });

  it('a saved data-source key drops the source failure state', async () => {
    await h.reauth(h.admin);
    await h.env.kv.set('src:pause:tmdb', '1', 3600);
    h.probe = { 'GET /3/configuration': () => ({ json: {} }) };
    expect((await h.put({ TMDB_API_KEY: 'tmdbkey-12345678' })).statusCode).toBe(200);
    expect(await h.env.kv.get('src:pause:tmdb')).toBeNull();
  });
});

describe('POST /api/admin/settings/test', () => {
  const h = harness();

  it('tests the unsaved candidate values; omitted secrets use the saved ones; nothing is saved', async () => {
    const tokens: string[] = [];
    h.probe = { 'GET /Auth/Keys': (_u, init) => { tokens.push((init.headers as Record<string, string>).Authorization!); return { json: {} }; } };
    const rev = h.env.ctx.settings.rev();
    const a = await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'media', values: { JELLYFIN_ADMIN_API_KEY: 'candidate-key' } });
    expect(a.json()).toEqual({ ok: true, code: 'ok', probe: 'media' });
    const b = await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'media' });
    expect(b.json()).toMatchObject({ ok: true, code: 'ok' });
    expect(tokens[0]).toContain('Token="candidate-key"');
    expect(tokens[1]).toContain('Token="adminkey"');
    expect(h.env.ctx.settings.rev()).toBe(rev);
    expect(h.env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe('adminkey');
  });

  it('a new destination for a saved secret needs re-authentication (the saved key would be sent there)', async () => {
    await h.reauth(h.admin, Date.now() - 11 * 60_000);
    h.probe = { 'GET /Auth/Keys': () => ({ json: {} }) };
    const r = await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'media', values: { JELLYFIN_URL: 'http://evil.example.com' } });
    expect(r.statusCode).toBe(401);
    // with its own candidate key it is fine
    const ok = await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'media', values: { JELLYFIN_URL: 'http://evil.example.com', JELLYFIN_ADMIN_API_KEY: 'typed-key' } });
    expect(ok.json()).toMatchObject({ ok: true });
  });

  it('several probes in a group: the worst result; unconfigured -> not_set; a group without probes -> 400', async () => {
    await h.reauth(h.admin);
    h.probe = { 'GET /3/configuration': () => ({ status: 401 }) };
    const r = await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'sources', values: { TMDB_API_KEY: 'tmdbkey-12345678' } });
    expect(r.json()).toEqual({ ok: false, code: 'unauthorized', probe: 'tmdb' });
    expect((await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'sources' })).json()).toEqual({ ok: false, code: 'invalid', detail: 'not_set' });
    expect((await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'health' })).json()).toEqual({ error: 'no_probe' });
    expect((await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'media', values: { JELLYFIN_URL: 'ftp://x' } })).json().errors).toEqual({ JELLYFIN_URL: 'invalid_url' });
    expect((await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'nope' })).statusCode).toBe(400);
  });
});

describe('POST /api/admin/settings/generate', () => {
  const h = harness();

  it('the generators', () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
    const p = generateVapidPair();
    expect(p.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(p.privateKey).toMatch(/^[\w-]{40,}$/);
  });

  it('needs a recent re-authentication (it replaces a secret)', async () => {
    const r = await h.as(h.admin, 'POST', '/api/admin/settings/generate', { what: 'webhookSecret' });
    expect(r.statusCode).toBe(401);
    expect(h.env.ctx.cfg.WEBHOOK_SECRET).toBe(cfg.WEBHOOK_SECRET);
  });

  it('webhookSecret: 64 hex chars once, no-store, saved; a later GET shows it set without the value', async () => {
    await h.reauth(h.admin);
    const r = await h.as(h.admin, 'POST', '/api/admin/settings/generate', { what: 'webhookSecret' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const { secret } = r.json();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.env.ctx.cfg.WEBHOOK_SECRET).toBe(secret);
    const get = await h.as(h.admin, 'GET', '/api/admin/settings');
    expect(get.body).not.toContain(secret);
    expect(get.json().groups.flatMap((g: any) => g.items).find((i: any) => i.key === 'WEBHOOK_SECRET')).toMatchObject({ set: true, value: null, source: 'db' });
    const audit = await h.audits('settings.generate');
    expect(audit).toEqual([{ what: 'webhookSecret', keys: ['WEBHOOK_SECRET'] }]);
  });

  it('vapidPair: only the public key is returned; the pair is saved and push accepts it', async () => {
    await h.reauth(h.admin);
    const r = await h.as(h.admin, 'POST', '/api/admin/settings/generate', { what: 'vapidPair' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(r.json())).toEqual(['publicKey']);
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = h.env.ctx.cfg;
    expect(r.json().publicKey).toBe(VAPID_PUBLIC_KEY);
    expect(VAPID_PRIVATE_KEY).toBeTruthy();
    expect(r.body).not.toContain(VAPID_PRIVATE_KEY);
    expect((await h.as(h.admin, 'GET', '/api/admin/settings')).body).not.toContain(VAPID_PRIVATE_KEY);
    expect(pushEnabled(h.env.ctx.cfg)).toBe(true);
  });

  it('a locked target is refused', async () => {
    await h.reauth(h.admin);
    const before = h.env.ctx.cfg;
    h.env.ctx.cfg = { ...before, WEBHOOK_SECRET: 'from-env-0123456789' };
    try {
      const r = await h.as(h.admin, 'POST', '/api/admin/settings/generate', { what: 'webhookSecret' });
      expect(r.statusCode).toBe(400);
      expect(r.json().errors).toEqual({ WEBHOOK_SECRET: 'locked' });
      expect(r.body).not.toMatch(/[0-9a-f]{64}/);
    } finally {
      h.env.ctx.cfg = before;
    }
  });
});

describe('saved credentials never go to a new host without re-authentication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-settings-'));
  writeFileSync(join(dir, 'requests'), 'file-requests-key-GGGG\n');
  const h = harness({ settingsEnv: { REQUESTS_API_KEY_FILE: join(dir, 'requests'), JELLYFIN_ADMIN_API_KEY: 'env-jf-key-HHHH', AUTHENTIK_API_TOKEN: 'env-ak-token-IIII' } });
  const EVIL = 'evil.example.com';
  const stale = () => h.reauth(h.admin, Date.now() - 20 * 60_000);
  const test = (group: string, values: Record<string, unknown>) => h.as(h.admin, 'POST', '/api/admin/settings/test', { group, values });

  it('every secret of the registry is a credential with destinations or one without (and every destination is a URL setting)', () => {
    const secrets = SETTINGS.filter((d) => d.secret).map((d) => d.key).sort();
    expect([...Object.keys(CREDENTIAL_DESTINATIONS), ...NO_DESTINATION].sort()).toEqual(secrets);
    for (const dests of Object.values(CREDENTIAL_DESTINATIONS)) {
      expect(dests.length).toBeGreaterThan(0);
      for (const d of dests) expect(settingDef(d)?.kind).toBe('url');
    }
  });

  it('a typed dummy for an env/_FILE credential does not unlock a new destination (Test and PUT)', async () => {
    await h.env.ctx.settings.save({ AUTHENTIK_URL: 'https://auth.example.com' }, null);
    await stale();
    h.hosts.length = 0;
    h.probe = { 'GET .*': () => ({ json: { total: 0 } }) };
    for (const [group, values] of [
      ['requests', { REQUESTS_URL: `http://${EVIL}`, REQUESTS_API_KEY: 'dummy' }],
      ['media', { JELLYFIN_URL: `http://${EVIL}`, JELLYFIN_ADMIN_API_KEY: 'dummy' }],
      ['signin', { AUTHENTIK_URL: `https://${EVIL}`, AUTHENTIK_API_TOKEN: 'dummy' }],
    ] as const) {
      const r = await test(group, values);
      expect(r.statusCode, group).toBe(401);
      expect(r.json()).toEqual({ error: 'reauth_required' });
      expect((await h.put(values)).statusCode, group).toBe(401);
    }
    expect(h.hosts).not.toContain(EVIL);
  });

  it.each(Object.entries(CREDENTIAL_DESTINATIONS).flatMap(([cred, dests]) => dests.map((d) => [cred, d] as const)))('%s -> %s', async (cred, dest) => {
    // the credential is saved (env or database) and the destination changes
    const c = h.env.ctx.cfg as Record<string, unknown>;
    if (!c[cred]) await h.env.ctx.settings.save({ [cred]: `saved-${cred}` }, null);
    if (cred === 'PORTAINER_API_KEY') await h.env.ctx.settings.save({ PORTAINER_URL: 'https://portainer.example.com', PORTAINER_STACK_ID: '1' }, null);
    await stale();
    h.hosts.length = 0;
    h.probe = { 'GET .*': () => ({ json: {} }) };
    const group = settingDef(dest)!.group;
    const url = `https://${EVIL}`;
    expect((await h.put({ [dest]: url })).statusCode).toBe(401);
    expect((await test(group, { [dest]: url })).statusCode).toBe(401);
    expect(h.hosts).not.toContain(EVIL);
    // the admin typed the credential for the new host themselves: a Test needs no re-authentication
    if (h.env.ctx.settings.sources()[cred] !== 'env') expect((await test(group, { [dest]: url, [cred]: 'typed-credential' })).statusCode).toBe(200);
  });
});

describe('access', () => {
  const h = harness();

  it('non-admins get 403 on all five routes', async () => {
    await h.env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-dora', 'dora@example.com', 'Dora', 'friend', $1, 'Dora', $2)", ['sub-dora'.padEnd(32, '0'), encrypt(h.env.ctx.encKey, 'pw')]);
    const dora = await h.env.login(DORA);
    await h.reauth(dora);
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings', { values: { CAST_ENABLED: false } }],
      ['POST', '/api/admin/settings/test', { group: 'media' }],
      ['POST', '/api/admin/settings/import-env', { keys: 'all' }],
      ['POST', '/api/admin/settings/generate', { what: 'webhookSecret' }],
    ];
    for (const [m, url, body] of routes) {
      const r = await h.as(dora, m, url, body);
      expect(r.statusCode, `${m} ${url}`).toBe(403);
    }
    expect((await h.env.app.inject({ url: '/api/admin/settings' })).statusCode).toBe(401);
  });

  it('state-changing routes need the CSRF token', async () => {
    for (const [url, body] of [['/api/admin/settings', { values: { CAST_ENABLED: false } }], ['/api/admin/settings/test', { group: 'media' }],
      ['/api/admin/settings/import-env', { keys: 'all' }], ['/api/admin/settings/generate', { what: 'webhookSecret' }]] as const) {
      const r = await h.env.app.inject({ method: url === '/api/admin/settings' ? 'PUT' : 'POST', url, cookies: h.admin.cookies, payload: body });
      expect(r.statusCode, url).toBe(403);
      expect(r.json()).toEqual({ error: 'csrf' });
    }
  });
});

describe('logs', () => {
  const logs: string[] = [];
  const h = harness({ logs });

  it('no log line carries a submitted secret, also on 4xx and 5xx answers', async () => {
    const secret = 'log-guard-secret-QQQQ7777';
    h.probe = { 'GET /Auth/Keys': () => { throw new TypeError(`fetch failed for http://media.internal/Auth/Keys token ${secret}`); } };
    await h.put({ OIDC_CLIENT_SECRET: secret }); // 401 reauth_required
    await h.reauth(h.admin);
    await h.put({ OIDC_CLIENT_SECRET: secret, SESSION_TTL_SECONDS: -1 }); // 400 validation
    await h.put({ JELLYFIN_ADMIN_API_KEY: secret }); // 400 probe unreachable
    await h.as(h.admin, 'POST', '/api/admin/settings/test', { group: 'media', values: { JELLYFIN_ADMIN_API_KEY: secret } });
    await h.put({ DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/1/${secret}` }); // 200
    // a malformed body whose parser error message quotes the secret (checked below): the 400 must neither answer nor log it
    const short = 'Kx9-Q7z'; // short enough for the parser's quoted snippet
    const payload = `{"values":${short}}`;
    let parseMessage = '';
    try { JSON.parse(payload); } catch (e) { parseMessage = (e as Error).message; }
    expect(parseMessage).toContain(short);
    const bad = await h.env.app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: h.admin.cookies, headers: { 'x-csrf-token': h.admin.csrf, 'content-type': 'application/json' }, payload });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain(short);
    const save = h.env.ctx.settings.save;
    h.env.ctx.settings.save = async () => { throw new Error('database down'); };
    try {
      const r = await h.put({ DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/2/${secret}` }); // 500
      expect(r.statusCode).toBe(500);
    } finally {
      h.env.ctx.settings.save = save;
    }
    const gen = await h.as(h.admin, 'POST', '/api/admin/settings/generate', { what: 'webhookSecret' });
    const generated = gen.json().secret as string;
    expect(logs.join('\n')).toContain('"statusCode":500');
    for (const line of logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain(short);
      expect(line).not.toContain(generated);
    }
  });
});
