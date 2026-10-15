// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Settings fixtures (shapes follow backend/src/routes/adminSettings.ts: SettingView, the PUT / test / import-env / generate
 * answers). Stateful: a save changes the rows, so specs can assert what the UI shows afterwards. Secrets never carry a value.
 */

type Kind = 'string' | 'url' | 'secret' | 'int' | 'number' | 'bool' | 'enum' | 'cidrList' | 'json';
type Source = 'env' | 'db' | 'bootstrap' | 'default' | 'unset';
export interface SettingViewMock {
  key: string; kind: Kind; source: Source; value: unknown | null; set: boolean; last4?: string; apply: 'live' | 'restart';
  restartPending: boolean; invalid: boolean; envNames: string[]; updatedAt: string | null; options?: readonly string[]; min?: number; max?: number;
  generate?: 'webhookSecret' | 'vapidPair';
}
export interface ProbeResultMock { ok: boolean; code: string; detail?: string }
export interface SettingsMock {
  rev: number;
  groups: Array<{ id: string; items: SettingViewMock[] }>;
  /** saves of sensitive keys (and generate) answer 401 reauth_required until /auth/reauth was passed */
  reauthRequired: boolean;
  /** the next PUT without force answers 400 probe_failed with this result (group = the first changed key's group) */
  probeFail: ProbeResultMock | null;
  /** the next PUT answers 400 invalid_settings with these errors (then it is cleared) */
  saveErrors: Record<string, string> | null;
  /** answer of POST /api/admin/settings/test */
  testResult: ProbeResultMock;
  /** bodies of every PUT and POST, in order */
  puts: Array<{ values: Record<string, unknown>; force?: boolean }>;
  tests: Array<{ group: string; values?: Record<string, unknown> }>;
  imports: Array<string[] | 'all'>;
}

const UPDATED = '2026-10-01T09:30:00Z';
/** canary: seeded as the `value` of secret rows (the real API sends null); it must never reach the page */
export const LEAK = 'mock-leak-canary-9f3e';
const env = (key: string, legacy: string[] = []) => [key, ...legacy].flatMap((n) => [n, `${n}_FILE`]);

interface Spec { /** a value the backend would never send (secrets): the UI must ignore it */ leak?: string; kind: Kind; source?: Source; value?: unknown; set?: boolean; last4?: string; apply?: 'restart'; invalid?: boolean; legacy?: string[]; options?: string[]; min?: number; max?: number; generate?: 'webhookSecret' | 'vapidPair' }
/** every visible setting of the registry, by group (spec Part A: 48) */
const GROUPS: Array<[string, Array<[string, Spec]>]> = [
  ['general', [
    ['PUBLIC_URL', { kind: 'url', source: 'env', value: 'https://friend.example.com' }],
    ['WEBHOOK_SECRET', { kind: 'secret', source: 'db', set: true, generate: 'webhookSecret' }],
    ['API_COMPRESSION', { kind: 'bool', source: 'default', value: true }],
  ]],
  ['signin', [
    ['OIDC_ISSUER', { kind: 'url', source: 'db', value: 'https://auth.example.com/application/o/friendflix/' }],
    ['OIDC_CLIENT_ID', { kind: 'string', source: 'db', value: 'friendflix' }],
    ['OIDC_CLIENT_SECRET', { kind: 'secret', source: 'env', set: true }],
    ['ADMIN_GROUP', { kind: 'string', source: 'default', value: 'friendflix-admins' }],
    ['AUTHENTIK_URL', { kind: 'url', source: 'db', value: 'https://auth.example.com' }],
    ['AUTHENTIK_API_TOKEN', { kind: 'secret', source: 'db', set: true }],
    ['AUTHENTIK_ENROLL_FLOW', { kind: 'string', source: 'unset' }],
    ['AUTHENTIK_RECOVERY_FLOW', { kind: 'string', source: 'default', value: 'default-recovery-flow' }],
    ['AUTHENTIK_TOTP_SETUP_FLOW', { kind: 'string', source: 'default', value: 'default-authenticator-totp-setup' }],
  ]],
  ['media', [
    ['JELLYFIN_URL', { kind: 'url', source: 'db', value: 'http://jellyfin:8096' }],
    ['JELLYFIN_ADMIN_API_KEY', { kind: 'secret', source: 'unset', set: false, invalid: true }],
  ]],
  ['requests', [
    ['REQUESTS_URL', { kind: 'url', source: 'env', value: 'http://requests:5055', legacy: ['SEERR_URL'] }],
    ['REQUESTS_API_KEY', { kind: 'secret', source: 'env', set: true, legacy: ['SEERR_API_KEY'] }],
  ]],
  ['notifications', [
    ['NTFY_URL', { kind: 'url', source: 'db', value: 'https://ntfy.example.com/friendflix?auth=redacted' }],
    ['NTFY_BASE_URL', { kind: 'url', source: 'unset' }],
    ['DISCORD_WEBHOOK_URL', { kind: 'secret', source: 'unset', set: false }],
  ]],
  ['push', [
    ['VAPID_PUBLIC_KEY', { kind: 'string', source: 'unset', generate: 'vapidPair' }],
    ['VAPID_PRIVATE_KEY', { kind: 'secret', source: 'unset', set: false, generate: 'vapidPair' }],
    ['VAPID_SUBJECT', { kind: 'string', source: 'unset' }],
  ]],
  ['sources', [
    ['TMDB_API_KEY', { kind: 'secret', source: 'db', set: true, last4: 'abcd', leak: LEAK }],
    ['OMDB_API_KEY', { kind: 'secret', source: 'unset', set: false }],
  ]],
  ['downloads', [
    ['DOWNLOADS_ENABLED', { kind: 'bool', source: 'default', value: true }],
    ['DIRECT_PLAY_REQUIRES_DOWNLOAD', { kind: 'bool', source: 'default', value: false }],
    ['DOWNLOAD_CACHE_MAX_GB', { kind: 'number', source: 'default', value: 50 }],
    ['DOWNLOAD_MIN_FREE_GB', { kind: 'number', source: 'default', value: 2, min: 0 }],
    ['DOWNLOAD_PREP_CONCURRENCY', { kind: 'int', source: 'default', value: 1, min: 1, max: 4 }],
    ['DOWNLOAD_PAUSE_STREAMS', { kind: 'int', source: 'default', value: 2, min: 0 }],
    ['DOWNLOAD_FILE_TTL_HOURS', { kind: 'number', source: 'default', value: 48 }],
    ['DOWNLOAD_OFFLINE_GRACE_DAYS', { kind: 'number', source: 'default', value: 7 }],
    ['DOWNLOAD_CREATE_PER_HOUR', { kind: 'int', source: 'default', value: 20, min: 1, apply: 'restart' }],
  ]],
  ['playback', [
    ['CAST_ENABLED', { kind: 'bool', source: 'default', value: true }],
    ['PREVIEW_WARM', { kind: 'bool', source: 'default', value: true }],
    ['HOME_NETWORKS', { kind: 'cidrList', source: 'default', value: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] }],
  ]],
  ['updates', [
    ['GITHUB_TOKEN', { kind: 'secret', source: 'unset', set: false }],
    ['PORTAINER_WEBHOOK_URL', { kind: 'secret', source: 'unset', set: false }],
    ['PORTAINER_URL', { kind: 'url', source: 'unset' }],
    ['PORTAINER_API_KEY', { kind: 'secret', source: 'unset', set: false }],
    ['PORTAINER_STACK_ID', { kind: 'string', source: 'unset' }],
    ['PORTAINER_ENDPOINT_ID', { kind: 'int', source: 'default', value: 1 }],
  ]],
  ['health', [
    ['PLAYBACK_CHECK_HOUR', { kind: 'int', source: 'default', value: 4, min: -1, max: 23 }],
    ['HEALTH_DISK_WARN_PCT', { kind: 'int', source: 'default', value: 85, min: 50, max: 99 }],
    ['HEALTH_DISK_CRIT_PCT', { kind: 'int', source: 'default', value: 95, min: 51, max: 100 }],
    ['HEALTH_DB_WARN_GB', { kind: 'number', source: 'default', value: 10 }],
  ]],
  ['sessions', [
    ['SESSION_TTL_SECONDS', { kind: 'int', source: 'default', value: 28800, min: 1 }],
    ['SESSION_IDLE_SECONDS', { kind: 'int', source: 'default', value: 7200, min: 1 }],
  ]],
];
/** env-only and bootstrap keys (read-only; credentials never carry a value) */
const SERVER: Array<[string, Kind, Source, unknown]> = [
  ['PORT', 'int', 'default', 3000], ['DIGEST_DAY', 'int', 'default', 0], ['DIGEST_HOUR', 'int', 'default', 18], ['MEDIA_SERVER', 'string', 'default', 'jellyfin'],
  ['METRICS_TOKEN', 'secret', 'unset', null], ['ROLE_TEMPLATES', 'string', 'unset', null], ['OIDC_ALLOW_INSECURE', 'string', 'default', 'false'],
  ['PREVIEW_DIR', 'string', 'default', '/data/previews'], ['UPDATE_REPO', 'string', 'default', 'LetsManu/friendflix'], ['DOWNLOAD_DIR', 'string', 'default', '/data/downloads'],
  ['BACKGROUND_JOBS', 'string', 'env', 'true'], ['GATEWAY_URL', 'string', 'default', 'http://gateway:4000'],
  ['DATABASE_URL', 'secret', 'bootstrap', LEAK], ['REDIS_URL', 'secret', 'bootstrap', null], ['APP_ENC_KEY', 'secret', 'bootstrap', null], ['INTERNAL_SECRET', 'secret', 'bootstrap', null],
];

/** non-secret keys whose save needs a recent sign-in (backend adminSettings.ts REAUTH_KEYS, OIDC_* / AUTHENTIK_*, credential destinations) */
const REAUTH = /^(OIDC_|AUTHENTIK_)|^(ADMIN_GROUP|NTFY_URL|NTFY_BASE_URL|PUBLIC_URL|HOME_NETWORKS|JELLYFIN_URL|REQUESTS_URL|PORTAINER_URL)$/;

export function settingsState(): SettingsMock {
  const groups = GROUPS.map(([id, rows]) => ({
    id,
    items: rows.map(([key, s]): SettingViewMock => {
      const set = s.set ?? (s.value !== undefined && s.value !== null);
      return {
        key, kind: s.kind, source: s.source ?? 'default', value: s.kind === 'secret' ? (s.leak ?? null) : (s.value ?? null), set, apply: s.apply ?? 'live',
        restartPending: false, invalid: s.invalid ?? false, envNames: env(key, s.legacy), updatedAt: s.source === 'db' ? UPDATED : null,
        ...(s.last4 ? { last4: s.last4 } : {}), ...(s.options ? { options: s.options } : {}), ...(s.min !== undefined ? { min: s.min } : {}),
        ...(s.max !== undefined ? { max: s.max } : {}), ...(s.generate ? { generate: s.generate } : {}),
      };
    }),
  }));
  groups.push({
    id: 'server',
    items: SERVER.map(([key, kind, source, value]) => ({
      key, kind, source, value, set: value !== null || source === 'bootstrap', apply: 'restart', restartPending: false, invalid: false, envNames: env(key), updatedAt: null,
    })),
  });
  return { rev: 7, groups, reauthRequired: false, probeFail: null, saveErrors: null, testResult: { ok: true, code: 'ok' }, puts: [], tests: [], imports: [] };
}

const itemsOf = (st: SettingsMock) => st.groups.filter((g) => g.id !== 'server').flatMap((g) => g.items.map((i) => ({ group: g.id, item: i })));
const view = (st: SettingsMock) => ({
  rev: st.rev,
  pendingRestart: itemsOf(st).filter((x) => x.item.restartPending).map((x) => x.item.key),
  groups: st.groups,
});

type Reply = (b: unknown, status?: number) => Promise<void>;

export function settingsRoute(st: SettingsMock, m: string, p: string, body: any, J: Reply): Promise<void> | null {
  if (p === '/api/admin/settings' && m === 'GET') return J(view(st));
  if (p === '/api/admin/settings' && m === 'PUT') {
    const values: Record<string, unknown> = body.values ?? {};
    st.puts.push(body.force === undefined ? { values } : { values, force: body.force });
    const all = itemsOf(st);
    const find = (k: string) => all.find((x) => x.item.key === k);
    if (st.reauthRequired && Object.keys(values).some((k) => find(k)?.item.kind === 'secret' || REAUTH.test(k))) return J({ error: 'reauth_required' }, 401);
    if (st.saveErrors) { const errors = st.saveErrors; st.saveErrors = null; return J({ error: 'invalid_settings', errors }, 400); }
    const errors: Record<string, string> = {};
    for (const k of Object.keys(values)) {
      const f = find(k);
      if (!f) errors[k] = 'unknown';
      else if (f.item.source === 'env') errors[k] = 'locked';
    }
    for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && /[?&]auth=redacted\b/.test(v)) errors[k] = 'redacted';
    if (Object.keys(errors).length) return J({ error: 'invalid_settings', errors }, 400);
    if (st.probeFail && !body.force) return J({ error: 'probe_failed', group: find(Object.keys(values)[0]!)!.group, probe: st.probeFail }, 400);
    for (const [k, v] of Object.entries(values)) {
      const it = find(k)!.item;
      const clear = v === null || v === '';
      it.source = clear ? 'default' : 'db';
      it.set = !clear;
      it.updatedAt = clear ? null : new Date().toISOString();
      if (it.kind === 'secret') { if (k === 'TMDB_API_KEY' || k === 'OMDB_API_KEY') { if (clear) delete it.last4; else it.last4 = String(v).slice(-4); } it.invalid = false; }
      else it.value = clear ? null : it.kind === 'cidrList' ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : v;
      if (it.apply === 'restart') it.restartPending = true;
    }
    st.rev++;
    return J({ rev: st.rev });
  }
  if (p === '/api/admin/settings/test' && m === 'POST') {
    // the real rule: a saved credential would go to a changed destination
    if (st.reauthRequired && Object.keys(body.values ?? {}).some((k) => REAUTH.test(k))) return J({ error: 'reauth_required' }, 401);
    st.tests.push(body);
    return J(st.testResult);
  }
  if (p === '/api/admin/settings/import-env' && m === 'POST') {
    st.imports.push(body.keys);
    const env = itemsOf(st).filter((x) => x.item.source === 'env').map((x) => x.item.key);
    return J({ moved: body.keys === 'all' ? env : (body.keys as string[]).filter((k) => env.includes(k)) });
  }
  if (p === '/api/admin/settings/generate' && m === 'POST') {
    if (st.reauthRequired) return J({ error: 'reauth_required' }, 401);
    if (body.what === 'webhookSecret') {
      const it = itemsOf(st).find((x) => x.item.key === 'WEBHOOK_SECRET')!.item;
      it.set = true; it.source = 'db';
      return J({ secret: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0' });
    }
    for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
      const it = itemsOf(st).find((x) => x.item.key === k)!.item;
      it.set = true; it.source = 'db';
      if (k === 'VAPID_PUBLIC_KEY') it.value = 'BPubKeyExample';
    }
    return J({ publicKey: 'BPubKeyExample' });
  }
  return null;
}
