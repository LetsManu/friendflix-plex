// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import type { Ctx } from '../ctx.js';
import { REAUTH_WINDOW_S, recentlyAuthenticated } from '../reauth.js';
import { requireAdmin } from '../session.js';
import { resetSourceState } from '../sources/keys.js';
import { probeBlocks, probeConfigured, runProbe, type ProbeResult } from '../settings/probes.js';
import {
  BOOTSTRAP_KEYS, ENV_ONLY_KEYS, parseSettingValue, SETTINGS, settingDef,
  type ProbeId, type SettingDef, type SettingGroup, type SettingKind,
} from '../settings/registry.js';
import { readRows } from '../settings/repo.js';
import { toSchemaInput, toStored, type Source } from '../settings/resolve.js';
import { SettingsError } from '../settings/store.js';

/**
 * Admin -> Settings (spec Part I): the settings with their source, write-only secrets, saves with validation and live probes against the
 * candidate config, env import and generated secrets. saveWithProbes is shared with the setup wizard (no session there: re-authentication
 * is this route's business). Values never reach a log or an audit row: audits list key names, errors and probe results are codes.
 */

export const SETTING_GROUPS: readonly SettingGroup[] = ['general', 'signin', 'media', 'requests', 'notifications', 'push', 'sources',
  'downloads', 'playback', 'updates', 'health', 'sessions'];

export interface SettingView {
  key: string;
  kind: SettingKind;
  source: Source;
  /** null for secrets (and every bootstrap key and METRICS_TOKEN): they are write-only */
  value: unknown | null;
  set: boolean;
  last4?: string;
  apply: 'live' | 'restart';
  restartPending: boolean;
  /** a stored value that cannot be decrypted or fails its schema ("enter it again") */
  invalid: boolean;
  /** the environment names that set this key (env wins over the database) */
  envNames: string[];
  updatedAt: string | null;
  options?: readonly string[];
  min?: number;
  max?: number;
  generate?: SettingDef['generate'];
}

/** The server group's keys whose values are never shown (they hold credentials). */
const HIDDEN_VALUES: ReadonlySet<string> = new Set([...BOOTSTRAP_KEYS, 'METRICS_TOKEN']);
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';
/** what a shown URL carries instead of a credential; a submitted URL still holding it is refused (it would replace the real token) */
export const REDACTED = 'redacted';
const holdsRedaction = (v: unknown) => {
  try {
    return [...new URL(String(v)).searchParams.values()].includes(REDACTED);
  } catch {
    return false;
  }
};
/** a URL value as shown: without userinfo, and ntfy's `auth` query token replaced (they are credentials inside a non-secret value) */
function shownUrl(v: string): string {
  try {
    const u = new URL(v);
    if (!u.username && !u.password && !u.searchParams.has('auth')) return v;
    u.username = '';
    u.password = '';
    if (u.searchParams.has('auth')) u.searchParams.set('auth', REDACTED);
    return u.toString();
  } catch {
    return v;
  }
}
const envNames = (key: string, legacy: readonly string[] = []) => [key, ...legacy].flatMap((n) => [n, `${n}_FILE`]);

export async function settingsView(ctx: Ctx): Promise<{ rev: number; pendingRestart: string[]; groups: Array<{ id: SettingGroup | 'server'; items: SettingView[] }> }> {
  const cfg = ctx.cfg as Record<string, unknown>;
  const sources = ctx.settings.sources();
  const invalid = new Set(ctx.settings.invalid());
  const pending = ctx.settings.pendingRestart();
  const rows = new Map((await readRows(ctx.db)).rows.map((r) => [r.key, r]));

  const item = (d: SettingDef): SettingView => {
    const v = cfg[d.key];
    const set = isSet(v);
    const row = rows.get(d.key);
    const view: SettingView = {
      key: d.key, kind: d.kind, source: sources[d.key] ?? 'unset', value: d.secret || !set ? null : d.kind === 'url' ? shownUrl(String(v)) : toStored(d, v), set, apply: d.apply,
      restartPending: pending.includes(d.key), invalid: invalid.has(d.key), envNames: envNames(d.key, d.legacyEnv), updatedAt: row?.updatedAt ?? null,
    };
    if (d.hint === 'last4' && set) {
      const last4 = sources[d.key] === 'db' ? row?.last4 : String(v).slice(-4);
      if (last4) view.last4 = last4;
    }
    if (d.options) view.options = d.options;
    if (d.min !== undefined) view.min = d.min;
    if (d.max !== undefined) view.max = d.max;
    if (d.generate) view.generate = d.generate;
    return view;
  };
  const visible = SETTINGS.filter((d) => d.visible !== false);
  const groups: Array<{ id: SettingGroup | 'server'; items: SettingView[] }> = SETTING_GROUPS
    .map((id) => ({ id, items: visible.filter((d) => d.group === id).map(item) }))
    .filter((g) => g.items.length);

  // env-only and bootstrap keys: read-only, never a credential
  const server = [...ENV_ONLY_KEYS, ...BOOTSTRAP_KEYS].map((key): SettingView => {
    const v = cfg[key];
    const hidden = HIDDEN_VALUES.has(key);
    return {
      key, kind: hidden ? 'secret' : typeof v === 'number' ? 'int' : 'string', source: sources[key] ?? 'unset', value: hidden || !isSet(v) ? null : v,
      set: isSet(v), apply: 'restart', restartPending: false, invalid: false, envNames: envNames(key), updatedAt: null,
    };
  });
  groups.push({ id: 'server', items: server });
  return { rev: ctx.settings.rev(), pendingRestart: pending, groups };
}

/** Settings that hold a URL the backend calls (Discord and the Portainer webhook are secrets whose value is the URL). */
const URL_KEYS: ReadonlySet<string> = new Set([...SETTINGS.filter((d) => d.kind === 'url').map((d) => d.key), 'DISCORD_WEBHOOK_URL', 'PORTAINER_WEBHOOK_URL']);
/** an http(s) URL without userinfo (credentials belong in their own secret setting, never in a URL shown in Admin -> Settings) */
const httpUrl = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
};

/**
 * Every stored credential and the settings that decide where the backend sends it. Changing a destination while the credential stays
 * the saved one (from env, _FILE or the database) hands that credential to the new host, so it needs a recent re-authentication.
 * The media module's secrets go to its URL settings (Task 12 kinds included). Secrets not listed here go to fixed hosts or nowhere:
 * see NO_DESTINATION (a test checks that every secret of the registry is in exactly one of the two).
 */
const mediaDefs = SETTINGS.filter((d) => d.group === 'media');
export const CREDENTIAL_DESTINATIONS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(mediaDefs.filter((d) => d.secret).map((d) => [d.key, mediaDefs.filter((u) => u.kind === 'url').map((u) => u.key)])),
  REQUESTS_API_KEY: ['REQUESTS_URL'],
  AUTHENTIK_API_TOKEN: ['AUTHENTIK_URL'],
  PORTAINER_API_KEY: ['PORTAINER_URL'],
  OIDC_CLIENT_SECRET: ['OIDC_ISSUER'], // the token endpoint comes from the issuer's discovery
};
/** secrets that go to a fixed host (TMDB, OMDb, GitHub), are their own URL (Discord, Portainer webhook) or never leave (inbound, VAPID) */
export const NO_DESTINATION: readonly string[] = ['TMDB_API_KEY', 'OMDB_API_KEY', 'GITHUB_TOKEN', 'DISCORD_WEBHOOK_URL', 'PORTAINER_WEBHOOK_URL',
  'WEBHOOK_SECRET', 'VAPID_PRIVATE_KEY'];
const DESTINATIONS: ReadonlySet<string> = new Set(Object.values(CREDENTIAL_DESTINATIONS).flat());
/**
 * Non-secret keys whose change needs re-authentication: the admin group; ntfy (every user's topic and notification text goes there);
 * the public URL (cast tokens, invite and notification links, the OIDC redirect URI and the websocket Origin are built from it); the home
 * networks (they widen which clients get home trust).
 */
const REAUTH_KEYS: ReadonlySet<string> = new Set(['ADMIN_GROUP', 'NTFY_URL', 'NTFY_BASE_URL', 'PUBLIC_URL', 'HOME_NETWORKS']);

/** Keys whose saving needs a recent re-authentication: secrets, OIDC_* / AUTHENTIK_*, REAUTH_KEYS and every credential destination. */
export function needsReauth(keys: readonly string[]): boolean {
  return keys.some((k) => {
    const d = settingDef(k);
    return Boolean(d && (d.secret || REAUTH_KEYS.has(k) || /^(OIDC|AUTHENTIK)_/.test(k) || DESTINATIONS.has(k)));
  });
}

/** The candidate sends a saved credential to a changed destination (decided on the final candidate, after locked keys were dropped). */
export function redirectsSavedCredential(current: Config, next: Config): boolean {
  const cur = current as Record<string, unknown>, nxt = next as Record<string, unknown>;
  return Object.entries(CREDENTIAL_DESTINATIONS).some(([cred, dests]) =>
    isSet(nxt[cred]) && nxt[cred] === cur[cred] && dests.some((d) => String(nxt[d] ?? '') !== String(cur[d] ?? '')));
}

/**
 * The admin route's re-authentication rule for a save (`test: false`) or a Test (`test: true`): a save of a sensitive key, or any
 * candidate that would send a saved credential to a new host. A Test with its own typed credential needs none.
 */
export function reauthNeeded(ctx: Ctx, values: Record<string, unknown>, opts: { test: boolean }): boolean {
  if (!opts.test && needsReauth(Object.keys(values))) return true;
  return redirectsSavedCredential(ctx.cfg, candidate(ctx, values, { skipLocked: true }).cfg);
}

interface Candidate { errors: Record<string, string>; cfg: Config; changes: Record<string, unknown | null> }

/**
 * Validates the submitted values and merges them into the current config (the candidate the probes test). null or '' clears a key
 * (back to its default); undefined leaves it. `skipLocked` (Test) lets env win silently instead of refusing the key.
 */
function candidate(ctx: Ctx, values: Record<string, unknown>, opts: { allowedKeys?: readonly string[]; skipLocked?: boolean } = {}): Candidate {
  const sources = ctx.settings.sources();
  const next: Record<string, unknown> = { ...ctx.cfg };
  const errors: Record<string, string> = {};
  const changes: Record<string, unknown | null> = {};
  for (const [key, v] of Object.entries(values)) {
    if (opts.allowedKeys && !opts.allowedKeys.includes(key)) {
      errors[key] = 'not_allowed';
      continue;
    }
    const def = settingDef(key);
    // env-only, bootstrap and build keys and the hidden (phase 3) entries are not settings of this page
    if (!def || def.visible === false) {
      errors[key] = 'unknown';
      continue;
    }
    if (sources[key] === 'env') {
      if (!opts.skipLocked) errors[key] = 'locked';
      continue;
    }
    if (v === undefined) continue;
    if (v === null || v === '') {
      const d = def.schema.safeParse(undefined);
      next[key] = d.success ? d.data : undefined;
      changes[key] = null;
      continue;
    }
    const r = parseSettingValue(def, toSchemaInput(def, v));
    if (!r.ok) errors[key] = r.code;
    else if (URL_KEYS.has(key) && isSet(r.value) && !httpUrl(r.value)) errors[key] = 'invalid_url';
    else if (URL_KEYS.has(key) && isSet(r.value) && holdsRedaction(r.value)) errors[key] = 'redacted';
    else {
      next[key] = r.value;
      changes[key] = v;
    }
  }
  const cfg = next as Config;
  for (const [key, v] of Object.entries(changes)) {
    if (v !== null || errors[key]) continue;
    const rr = settingDef(key)!.runRequired;
    if (typeof rr === 'function' ? rr(cfg) : rr) errors[key] = 'required';
  }
  // yellow must come before red (resolveConfig would silently fall back to 85 / 95)
  // reported on the level that was submitted (the warn level when both were)
  const level = 'HEALTH_DISK_WARN_PCT' in changes ? 'HEALTH_DISK_WARN_PCT' : 'HEALTH_DISK_CRIT_PCT';
  if (level in changes && cfg.HEALTH_DISK_WARN_PCT >= cfg.HEALTH_DISK_CRIT_PCT) errors[level] ??= 'warn_above_critical';
  return { errors, cfg, changes };
}

const RANK = (r: ProbeResult) => (r.ok ? (r.code === 'ok' ? 3 : 2) : probeBlocks(r, true) ? 0 : 1);
const probeGroup = (id: ProbeId) => SETTINGS.find((d) => d.probe === id)!.group;

type SaveResult = { rev: number } | { errors: Record<string, string> } | { probe: ProbeResult; group: SettingGroup };
interface SaveOpts { force: boolean; actor: string | null; allowedKeys?: readonly string[] }

async function save(ctx: Ctx, values: Record<string, unknown>, opts: SaveOpts, log: { action: string; meta?: Record<string, unknown> }): Promise<SaveResult> {
  const c = candidate(ctx, values, { allowedKeys: opts.allowedKeys });
  if (Object.keys(c.errors).length) return { errors: c.errors };
  const keys = Object.keys(c.changes);
  if (!keys.length) return { rev: ctx.settings.rev() };
  // the probes of the touched groups, against the candidate; an optional service that is now empty is not probed
  const ids = [...new Set(keys.map((k) => settingDef(k)!.probe).filter((p): p is ProbeId => p !== undefined))].filter((id) => probeConfigured(id, c.cfg));
  const results = await Promise.all(ids.map((id) => runProbe(ctx, id, c.cfg)));
  const blocked = results.findIndex((r) => probeBlocks(r, opts.force));
  if (blocked >= 0) return { probe: results[blocked]!, group: probeGroup(ids[blocked]!) };
  let rev: number;
  try {
    rev = await ctx.settings.save(c.changes, opts.actor);
  } catch (e) {
    if (e instanceof SettingsError) return { errors: e.errors }; // changed meanwhile (another instance, env)
    throw e;
  }
  await audit(ctx, opts.actor, log.action, undefined, { ...log.meta, keys });
  // a new data-source key must work at once (no 1 h pause from the old one)
  for (const [key, name] of [['TMDB_API_KEY', 'tmdb'], ['OMDB_API_KEY', 'omdb']] as const) {
    if (!(key in c.changes)) continue;
    await resetSourceState(ctx, name).catch(() => undefined);
  }
  return { rev };
}

/** Validation, probes, one write and the audit `settings.update` (keys only). Shared with the setup wizard (actor null there). */
export function saveWithProbes(ctx: Ctx, values: Record<string, unknown>, opts: SaveOpts): Promise<SaveResult> {
  return save(ctx, values, opts, { action: 'settings.update' });
}

/** Tests a group's probes against the unsaved candidate (omitted secrets are the saved ones); the worst result wins. */
export async function testGroup(ctx: Ctx, group: SettingGroup, values: Record<string, unknown>, opts: { allowedKeys?: readonly string[] } = {}):
  Promise<{ errors: Record<string, string> } | { noProbe: true } | (ProbeResult & { probe?: ProbeId })> {
  const ids = [...new Set(SETTINGS.filter((d) => d.group === group && d.visible !== false && d.probe).map((d) => d.probe!))];
  if (!ids.length) return { noProbe: true };
  const c = candidate(ctx, values, { allowedKeys: opts.allowedKeys, skipLocked: true });
  if (Object.keys(c.errors).length) return { errors: c.errors };
  const run = ids.filter((id) => probeConfigured(id, c.cfg));
  if (!run.length) return { ok: false, code: 'invalid', detail: 'not_set' };
  const results = await Promise.all(run.map((id) => runProbe(ctx, id, c.cfg)));
  let worst = 0;
  results.forEach((r, i) => { if (RANK(r) < RANK(results[worst]!)) worst = i; });
  return { ...results[worst]!, probe: run[worst]! };
}

/** 32 random bytes as hex: the shared secret for the media server's and the request service's webhooks. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/** A Web Push (VAPID) key pair; the private key is saved server-side and never sent to a browser. */
export function generateVapidPair(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

export const valuesSchema = z.record(z.string().max(64), z.unknown()).refine((v) => Object.keys(v).length <= 100, 'too_many');

export function adminSettingsRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };
  // saves and tests call out to the services: bounded per client
  const saving = { ...admin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const probing = { ...admin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const reauthRequired = { error: 'reauth_required' } as const;

  app.get('/api/admin/settings', admin, async () => settingsView(ctx));

  app.put('/api/admin/settings', saving, async (req, reply) => {
    const b = z.object({ values: valuesSchema, force: z.boolean().optional() }).parse(req.body);
    if (reauthNeeded(ctx, b.values, { test: false }) && !recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send(reauthRequired);
    const r = await saveWithProbes(ctx, b.values, { force: b.force ?? false, actor: req.user!.id });
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    if ('probe' in r) return reply.code(400).send({ error: 'probe_failed', group: r.group, probe: r.probe });
    return r;
  });

  app.post('/api/admin/settings/test', probing, async (req, reply) => {
    const b = z.object({ group: z.enum(SETTING_GROUPS as [SettingGroup, ...SettingGroup[]]), values: valuesSchema.optional() }).parse(req.body);
    const values = b.values ?? {};
    if (reauthNeeded(ctx, values, { test: true }) && !recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send(reauthRequired);
    const r = await testGroup(ctx, b.group, values);
    if ('noProbe' in r) return reply.code(400).send({ error: 'no_probe' });
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    return r;
  });

  app.post('/api/admin/settings/import-env', admin, async (req) => {
    const { keys } = z.object({ keys: z.union([z.literal('all'), z.array(z.string().max(64)).max(100)]) }).parse(req.body);
    const moved = await ctx.settings.importEnv(keys, req.user!.id);
    await audit(ctx, req.user!.id, 'settings.import_env', undefined, { keys: moved });
    return { moved };
  });

  app.post('/api/admin/settings/generate', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { what } = z.object({ what: z.enum(['webhookSecret', 'vapidPair']) }).parse(req.body);
    reply.header('cache-control', 'no-store');
    // it replaces a secret
    if (!recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send(reauthRequired);
    const actor = req.user!.id;
    const log = { action: 'settings.generate', meta: { what } };
    if (what === 'webhookSecret') {
      const secret = generateWebhookSecret();
      const r = await save(ctx, { WEBHOOK_SECRET: secret }, { force: false, actor }, log);
      if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
      return { secret }; // the only time a secret value leaves the server
    }
    const pair = generateVapidPair();
    const r = await save(ctx, { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, { force: false, actor }, log);
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    return { publicKey: pair.publicKey };
  });
}
