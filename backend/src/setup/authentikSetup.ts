// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { basename, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { join, plainHttpUrl, smallJson } from '../settings/probeKit.js';

/**
 * The setup wizard's Authentik automation (spec Part G): groups, OAuth2 provider + application, service account, enrollment and
 * recovery flows and the brand's recovery flow, from a one-time admin API token.
 *
 * Its own client on purpose (never authentik.ts's call(), which sends the saved service token): the admin token lives only in this
 * call. It is sent to the URL that was typed in and nowhere else (http/https without user info, checked before any request; redirects
 * are never followed) and never stored, logged or put into an error: an AkError carries a code only, network errors and upstream
 * bodies are mapped, never passed on. The token that is saved (AUTHENTIK_API_TOKEN) is the service account's, read back with view_key.
 * Every request has a 10 s deadline that also covers its body; a blueprint import 60 s (Authentik applies it synchronously: the shipped
 * recovery example took 17 s on a fresh 2026.8.3 install).
 */
export type AkStepId = 'check' | 'groups' | 'provider' | 'serviceAccount' | 'enrollment' | 'recovery' | 'brand' | 'readback' | 'adminMember' | 'extraFlows';
export interface AkStep { id: AkStepId; state: 'create' | 'update' | 'exists' | 'skip' | 'ok' | 'failed'; detail?: string /* i18n code */ }

export type AkCode = 'invalid_url' | 'unauthorized' | 'not_superuser' | 'unsupported_version' | 'blueprint_invalid' | 'unreachable' | 'unexpected' | 'issuer_mismatch';
export class AkError extends Error {
  constructor(readonly code: AkCode) {
    super(`authentik setup failed: ${code}`);
  }
}

/**
 * Blueprints imported after the built-in steps (step 7, extraFlows). The e-mail change flow (Block 23 phase 3) needs its mail template,
 * a file in Authentik's /templates folder that no API can write: it is imported only once Authentik lists that template
 * (`GET stages/email/templates/`), else the step reports `template_missing` and nothing is created (an e-mail stage without its template
 * would fail the whole import, and a stock template would send a link that does not lead back into FriendFlix).
 */
export const AK_EXTRA_BLUEPRINTS: Array<{ id: string; file: string; context?: (cfg: Config) => Record<string, string>; template?: string }> = [
  { id: 'emailChange', file: 'friendflix-email-change.yaml', template: 'friendflix-email-change.html' },
];

/** deploy/authentik/ (the repository in development, /app/deploy/authentik/ in the image: the Dockerfile copies the files there) */
export const AK_BLUEPRINT_DIR = fileURLToPath(new URL('../../../deploy/authentik/', import.meta.url));

const TIMEOUT_MS = 10_000;
export const IMPORT_TIMEOUT_MS = 60_000;
const MIN_VERSION: readonly [number, number] = [2024, 4];
const PROVIDER = 'FriendFlix';
const APP_SLUG = 'friendflix';
const USERS_GROUP = 'friendflix-users';
const SERVICE_USER = 'friendflix-invites';
const SERVICE_TOKEN = 'friendflix-invites-token';
const ENROLL_FLOW = 'friendflix-enrollment';
const RECOVERY_FLOW = 'default-recovery-flow';
const RECOVERY_BLUEPRINT = 'example/flows-recovery-email-mfa-verification.yaml';
const IDENTIFICATION_STAGE = 'default-authentication-identification';
const BLUEPRINTS = { setup: 'friendflix-setup.yaml', serviceAccount: 'friendflix-service-account.yaml', enrollment: 'friendflix-blueprint.yaml' } as const;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const cancel = (r: Response) => void r.body?.cancel().catch(() => undefined);

interface Client {
  base: URL;
  /** GET: the JSON of a 2xx answer (an array only with `list`); null for a 404 when `optional` */
  json(path: string, opts?: { optional?: boolean; anonymous?: boolean; list?: boolean }): Promise<Obj | null>;
  /** a request whose answer has no body that matters (2xx or an AkError) */
  send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<void>;
  /** the raw answer to a multipart POST (blueprint import), mapped like json() but 400 left to the caller */
  form(path: string, data: FormData): Promise<Response>;
}

function client(url: string, token: string, fetchImpl: typeof fetch): Client {
  const base = plainHttpUrl(url);
  if (!base) throw new AkError('invalid_url');

  const call = async (method: string, path: string, init: { body?: BodyInit; json?: boolean; anonymous?: boolean; timeoutMs?: number }): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (!init.anonymous) headers.Authorization = `Bearer ${token}`;
    if (init.json) headers['content-type'] = 'application/json';
    let r: Response;
    try {
      r = await fetchImpl(join(base, path), {
        method, headers, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS), ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch {
      // a network error's text may quote the URL: only the code leaves
      throw new AkError('unreachable');
    }
    // never follow a redirect: the token would go to wherever it points
    if (r.status >= 300 && r.status < 400) {
      cancel(r);
      throw new AkError('unreachable');
    }
    if (r.status === 401 || r.status === 403) {
      cancel(r);
      throw new AkError('unauthorized');
    }
    return r;
  };
  const read = async (r: Response, max: number, list = false): Promise<Obj> => {
    // the deadline also covers the body: a server that stalls or resets after the headers is unreachable
    const body = await smallJson(r, max).catch(() => { throw new AkError('unreachable'); });
    if (list && Array.isArray(body)) return body as unknown as Obj;
    const o = obj(body);
    if (!o) throw new AkError('unexpected');
    return o;
  };

  return {
    base,
    async json(path, opts = {}) {
      const r = await call('GET', path, { anonymous: opts.anonymous });
      if (r.status === 404 && opts.optional) {
        cancel(r);
        return null;
      }
      if (!r.ok) {
        cancel(r);
        throw new AkError('unexpected');
      }
      return read(r, 256 * 1024, opts.list);
    },
    async send(method, path, body) {
      const r = await call(method, path, { body: JSON.stringify(body), json: true });
      cancel(r);
      if (!r.ok) throw new AkError('unexpected');
    },
    form: (path, data) => call('POST', path, { body: data, timeoutMs: IMPORT_TIMEOUT_MS }),
  };
}

type Deps = { fetchImpl: typeof fetch; blueprintDir: string; /** pause before a path import is retried (tests) */ retryDelayMs?: number };
type BlueprintSource = { file: string; context: Record<string, string> } | { path: string };

/**
 * A path import is checked against Authentik's blueprint list, which the server asks the worker for and waits at most 10 s: a busy worker
 * (seen on a freshly started 2026.8.3) answers 500 ResultTimeout. Such an answer is retried; nothing was applied.
 */
const PATH_ATTEMPTS = 3;
const PATH_RETRY_MS = 3_000;
/** the requests of an apply besides the imports (check, lookups, brand and stage patches, readback, admin membership), generously */
const APPLY_REQUESTS = 20;

/**
 * How long the apply lock (routes/setup.ts) must last: a run's worst case, every import at its deadline (the path import with its
 * retries and pauses, the extra blueprints too), every other request at its own, plus a margin for the probes after the save.
 */
export function applyLockTtlS(): number {
  const imports = Object.keys(BLUEPRINTS).length + PATH_ATTEMPTS + AK_EXTRA_BLUEPRINTS.length;
  return Math.ceil((imports * IMPORT_TIMEOUT_MS + (PATH_ATTEMPTS - 1) * PATH_RETRY_MS + APPLY_REQUESTS * TIMEOUT_MS) / 1000) + 120;
}

async function importWith(c: Client, src: BlueprintSource, deps: { blueprintDir: string; retryDelayMs?: number }): Promise<void> {
  const data = new FormData();
  if ('file' in src) {
    // a file name from this module's list: anything with a directory part is refused, not resolved
    if (basename(src.file) !== src.file || !src.file.endsWith('.yaml')) throw new AkError('blueprint_invalid');
    const text = await readFile(joinPath(deps.blueprintDir, src.file), 'utf8').catch(() => { throw new AkError('blueprint_invalid'); });
    data.append('file', new Blob([text], { type: 'application/x-yaml' }), src.file);
    data.append('context', JSON.stringify(src.context));
  } else {
    data.append('path', src.path);
    data.append('context', '{}');
  }
  let r = await c.form('/api/v3/managed/blueprints/import/', data);
  for (let attempt = 1; 'path' in src && r.status >= 500 && attempt < PATH_ATTEMPTS; attempt++) {
    cancel(r);
    await new Promise((res) => setTimeout(res, deps.retryDelayMs ?? PATH_RETRY_MS));
    r = await c.form('/api/v3/managed/blueprints/import/', data);
  }
  if (r.status === 400) {
    cancel(r);
    throw new AkError('blueprint_invalid');
  }
  if (!r.ok) {
    cancel(r);
    throw new AkError('unexpected');
  }
  // { success, logs }: the logs are not read on (they may quote values); success false = an entry did not validate or apply
  const body = obj(await smallJson(r, 4 * 1024 * 1024).catch(() => { throw new AkError('unreachable'); }));
  if (body?.success !== true) throw new AkError('blueprint_invalid');
}

/**
 * Imports a blueprint through `POST /api/v3/managed/blueprints/import/` (multipart; Authentik validates, checks the token's permissions
 * per model and applies it synchronously): a file from `deps.blueprintDir` with its context, or a path inside Authentik's own blueprint
 * folder. `success: false` (or 400) → AkError blueprint_invalid.
 */
export async function importBlueprint(url: string, token: string, src: BlueprintSource, deps: Deps): Promise<void> {
  await importWith(client(url, token, deps.fetchImpl), src, deps);
}

const results = (o: Obj | null): Obj[] => (Array.isArray(o?.results) ? (o.results as unknown[]).map(obj).filter((x): x is Obj => !!x) : []);
const q = (v: string) => encodeURIComponent(v);

/** step 1: a superuser token on a supported version; answers the token owner's pk (adminMember) */
async function check(c: Client): Promise<unknown> {
  const user = obj((await c.json('/api/v3/core/users/me/'))?.user);
  if (!user || user.pk === undefined) throw new AkError('unexpected');
  if (user.is_superuser !== true) throw new AkError('not_superuser');
  const v = /^(\d+)\.(\d+)/.exec(String((await c.json('/api/v3/admin/version/'))?.version_current ?? ''));
  const [major, minor] = v ? [Number(v[1]), Number(v[2])] : [0, 0];
  if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1])) throw new AkError('unsupported_version');
  return user.pk;
}

async function findGroup(c: Client, name: string): Promise<Obj | undefined> {
  return results(await c.json(`/api/v3/core/groups/?name=${q(name)}&include_users=false`)).find((g) => g.name === name);
}
async function findProvider(c: Client): Promise<Obj | undefined> {
  return results(await c.json(`/api/v3/providers/oauth2/?name=${q(PROVIDER)}`)).find((p) => p.name === PROVIDER);
}
async function flowPk(c: Client, slug: string): Promise<string | undefined> {
  const f = await c.json(`/api/v3/flows/instances/${q(slug)}/`, { optional: true });
  if (!f) return undefined;
  const pk = str(f.pk);
  if (!pk) throw new AkError('unexpected');
  return pk;
}
async function brandTargets(c: Client): Promise<{ brand?: Obj; stage?: Obj }> {
  const brand = results(await c.json('/api/v3/core/brands/?default=true')).find((b) => b.default !== false);
  const stage = results(await c.json(`/api/v3/stages/identification/?name=${q(IDENTIFICATION_STAGE)}`)).find((s) => s.name === IDENTIFICATION_STAGE);
  return { brand, stage };
}

/** Whether the existing provider already has what friendflix-setup.yaml sets (the fields the plan can compare). */
function providerMatches(p: Obj, publicUrl?: string): boolean {
  const grants = Array.isArray(p.grant_types) ? p.grant_types : [];
  const uris = Array.isArray(p.redirect_uris) ? p.redirect_uris.map(obj) : [];
  const uriOk = uris.length === 1 && uris[0]?.matching_mode === 'strict' &&
    (publicUrl ? uris[0]?.url === `${publicUrl.replace(/\/+$/, '')}/auth/callback` : String(uris[0]?.url ?? '').endsWith('/auth/callback'));
  return p.client_type === 'confidential' && grants.length === 1 && grants[0] === 'authorization_code' && uriOk &&
    p.sub_mode === 'hashed_user_id' && p.include_claims_in_id_token === true && p.issuer_mode === 'per_provider';
}

/** Runs steps in order; the first AkError ends the run with that step `failed` (a code, never a message). */
class Steps {
  readonly list: AkStep[] = [];
  failed = false;
  async run<T>(id: AkStepId, fn: () => Promise<{ state: AkStep['state']; value?: T; detail?: string }>): Promise<T | undefined> {
    if (this.failed) return undefined;
    try {
      const r = await fn();
      this.list.push({ id, state: r.state, ...(r.detail ? { detail: r.detail } : {}) });
      return r.value;
    } catch (e) {
      if (!(e instanceof AkError)) throw e;
      this.failed = true;
      this.list.push({ id, state: 'failed', detail: e.code });
      return undefined;
    }
  }
}

/**
 * The plan (read-only: GET requests only): what apply would create, update or leave. `publicUrl` and `adminGroup` (optional) make the
 * provider and group comparison exact.
 */
export async function planAuthentik(input: { url: string; token: string; publicUrl?: string; adminGroup?: string }, deps: { fetchImpl: typeof fetch }): Promise<AkStep[]> {
  const s = new Steps();
  let c: Client | undefined;
  await s.run('check', async () => {
    c = client(input.url, input.token, deps.fetchImpl);
    await check(c);
    return { state: 'ok' };
  });
  if (!c) return s.list;
  const ak = c;
  await s.run('groups', async () => {
    const names = [input.adminGroup || 'friendflix-admins', USERS_GROUP];
    const found = await Promise.all(names.map((n) => findGroup(ak, n)));
    return { state: found.every(Boolean) ? 'exists' : 'create' };
  });
  await s.run('provider', async () => {
    const [p, app] = [await findProvider(ak), await ak.json(`/api/v3/core/applications/${APP_SLUG}/`, { optional: true })];
    if (!p && !app) return { state: 'create' };
    return { state: p && app && providerMatches(p, input.publicUrl) ? 'exists' : 'update' };
  });
  // the blueprints re-apply their attributes to an existing account or flow: update, not exists
  await s.run('serviceAccount', async () => {
    const found = results(await ak.json(`/api/v3/core/users/?username=${q(SERVICE_USER)}`)).some((u) => u.username === SERVICE_USER);
    return { state: found ? 'update' : 'create' };
  });
  await s.run('enrollment', async () => ({ state: (await flowPk(ak, ENROLL_FLOW)) === undefined ? 'create' : 'update' }));
  await s.run('recovery', async () => ({ state: (await flowPk(ak, RECOVERY_FLOW)) === undefined ? 'create' : 'exists' }));
  await s.run('brand', async () => {
    const { brand, stage } = await brandTargets(ak);
    if (!brand && !stage) return { state: 'skip' };
    return { state: (brand && !brand.flow_recovery) || (stage && !stage.recovery_flow) ? 'create' : 'exists' };
  });
  await s.run('extraFlows', async () => {
    if (!AK_EXTRA_BLUEPRINTS.length) return { state: 'skip' };
    const r = await extraFlowsPlan(ak);
    return r.missing.length ? { state: r.ready.length ? 'update' : 'skip', detail: 'template_missing' } : { state: 'update' };
  });
  return s.list;
}

/** the extra blueprints that can be imported now, and those still waiting for their mail template */
async function extraFlowsPlan(c: Client): Promise<{ ready: typeof AK_EXTRA_BLUEPRINTS; missing: typeof AK_EXTRA_BLUEPRINTS }> {
  const needs = AK_EXTRA_BLUEPRINTS.some((b) => b.template);
  const listed = needs ? await c.json('/api/v3/stages/email/templates/', { optional: true, list: true }) : null;
  const names = new Set((Array.isArray(listed) ? listed : []).map((t) => str(obj(t)?.name)).filter(Boolean));
  const ready = AK_EXTRA_BLUEPRINTS.filter((b) => !b.template || names.has(b.template));
  return { ready, missing: AK_EXTRA_BLUEPRINTS.filter((b) => !ready.includes(b)) };
}

/** step 7: the extra blueprints whose preconditions hold; `skip` + `template_missing` when one still waits for its mail template */
async function extraFlows(c: Client, deps: Deps & { cfg?: Config }): Promise<{ state: AkStep['state']; detail?: string }> {
  if (!AK_EXTRA_BLUEPRINTS.length) return { state: 'skip' };
  const { ready, missing } = await extraFlowsPlan(c);
  for (const b of ready) await importWith(c, { file: b.file, context: deps.cfg && b.context ? b.context(deps.cfg) : {} }, deps);
  return missing.length ? { state: ready.length ? 'ok' : 'skip', detail: 'template_missing' } : { state: 'ok' };
}

/**
 * Applies the plan (spec Part G steps 1-7). `values` (the eight settings) only when every step succeeded; nothing is rolled back in
 * Authentik on a failure (re-running is idempotent). `cfg` is handed to the extra blueprints' context functions.
 */
export async function applyAuthentik(
  input: { url: string; token: string; addMeToAdmins: boolean; publicUrl: string; adminGroup: string },
  deps: Deps & { cfg?: Config },
): Promise<{ steps: AkStep[]; values?: Record<string, string> }> {
  const s = new Steps();
  let c: Client | undefined;
  const mePk = await s.run('check', async () => {
    c = client(input.url, input.token, deps.fetchImpl);
    return { state: 'ok', value: await check(c) };
  });
  if (!c) return { steps: s.list };
  const ak = c;
  const base = ak.base.origin + ak.base.pathname.replace(/\/+$/, '');
  const publicUrl = input.publicUrl.replace(/\/+$/, '');
  const imported = (file: string, context: Record<string, string> = {}) => importWith(ak, { file, context }, deps);

  // step 2: one file holds the groups and the provider; both are reported, a failure too (the import cannot tell which part failed,
  // and the provider's scope mappings are the likelier cause on a freshly started Authentik)
  await s.run('groups', async () => {
    await imported(BLUEPRINTS.setup, { public_url: publicUrl, admin_group: input.adminGroup });
    return { state: 'ok' };
  });
  const groups = s.list.at(-1);
  if (groups?.id === 'groups') s.list.push({ ...groups, id: 'provider' });
  await s.run('serviceAccount', async () => (await imported(BLUEPRINTS.serviceAccount), { state: 'ok' }));
  await s.run('enrollment', async () => (await imported(BLUEPRINTS.enrollment), { state: 'ok' }));

  // step 3: Authentik's own recovery example (e-mail + MFA) when the default recovery flow is missing
  const recovery = await s.run('recovery', async () => {
    const pk = await flowPk(ak, RECOVERY_FLOW);
    if (pk) return { state: 'exists', value: pk };
    await importWith(ak, { path: RECOVERY_BLUEPRINT }, deps);
    const created = await flowPk(ak, RECOVERY_FLOW);
    if (!created) throw new AkError('unexpected');
    return { state: 'ok', value: created };
  });

  // step 4: the recovery flow for the brand and the identification stage, only where none is set (never overwritten)
  await s.run('brand', async () => {
    const { brand, stage } = await brandTargets(ak);
    let changed = false;
    if (brand && !brand.flow_recovery && str(brand.brand_uuid)) {
      await ak.send('PATCH', `/api/v3/core/brands/${q(String(brand.brand_uuid))}/`, { flow_recovery: recovery });
      changed = true;
    }
    if (stage && !stage.recovery_flow && str(stage.pk)) {
      // the serializer's validate() reads user_fields and sources from the request only, so a PATCH without them fails with "at least
      // one source must be selected" (2026.8.3): they are sent back unchanged
      const keep = Object.fromEntries((['user_fields', 'sources'] as const).filter((k) => Array.isArray(stage[k])).map((k) => [k, stage[k]]));
      await ak.send('PATCH', `/api/v3/stages/identification/${q(String(stage.pk))}/`, { ...keep, recovery_flow: recovery });
      changed = true;
    }
    return { state: changed ? 'ok' : 'exists' };
  });

  // step 5: client id + secret, the service account's token, the issuer as discovery reports it
  const issuer = `${base}/application/o/${APP_SLUG}/`;
  const read = await s.run('readback', async () => {
    const p = await findProvider(ak);
    const clientId = str(p?.client_id);
    const clientSecret = str(p?.client_secret);
    const key = str((await ak.json(`/api/v3/core/tokens/${SERVICE_TOKEN}/view_key/`))?.key);
    if (!clientId || !clientSecret || !key) throw new AkError('unexpected');
    // discovery is public: no token
    const doc = await ak.json(`/application/o/${APP_SLUG}/.well-known/openid-configuration`, { anonymous: true });
    if (doc?.issuer !== issuer) throw new AkError('issuer_mismatch');
    return { state: 'ok', value: { clientId, clientSecret, key } };
  });

  // step 6: the token's owner joins the admin group (the first FriendFlix sign-in is then an admin by group as well)
  await s.run('adminMember', async () => {
    if (!input.addMeToAdmins) return { state: 'skip' };
    const g = await findGroup(ak, input.adminGroup);
    if (!g || g.pk === undefined) throw new AkError('unexpected');
    await ak.send('POST', `/api/v3/core/groups/${q(String(g.pk))}/add_user/`, { pk: mePk });
    return { state: 'ok' };
  });

  // step 7: phase 3's flows
  await s.run('extraFlows', () => extraFlows(ak, deps));

  if (s.failed || !read) return { steps: s.list };
  return {
    steps: s.list,
    values: {
      AUTHENTIK_URL: base,
      AUTHENTIK_API_TOKEN: read.key,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: read.clientId,
      OIDC_CLIENT_SECRET: read.clientSecret,
      ADMIN_GROUP: input.adminGroup,
      AUTHENTIK_ENROLL_FLOW: ENROLL_FLOW,
      AUTHENTIK_RECOVERY_FLOW: RECOVERY_FLOW,
    },
  };
}

/**
 * "Repair / upgrade the Authentik setup" (Admin → Status → Sign-in): the parts an existing install may lack after an update, with a
 * one-time superuser token like the wizard's (never stored or logged). It re-applies the service account blueprint (its permissions grow
 * with new releases: phase 3 added the device deletes and two reads; an install set up before never got them), imports the extra flows
 * whose preconditions hold (the e-mail change once its template is mounted) and reads the service token back. Groups, provider,
 * application, enrollment and recovery flows are left alone (an admin may have adapted them). `values.AUTHENTIK_API_TOKEN` is the
 * service token after the run: the caller saves it when it differs from the one in use (a deleted token is created anew by the import).
 */
export async function repairAuthentik(input: { url: string; token: string }, deps: Deps & { cfg?: Config }): Promise<{ steps: AkStep[]; values?: { AUTHENTIK_API_TOKEN: string } }> {
  const s = new Steps();
  let c: Client | undefined;
  await s.run('check', async () => {
    c = client(input.url, input.token, deps.fetchImpl);
    await check(c);
    return { state: 'ok' };
  });
  if (!c) return { steps: s.list };
  const ak = c;
  await s.run('serviceAccount', async () => (await importWith(ak, { file: BLUEPRINTS.serviceAccount, context: {} }, deps), { state: 'ok' }));
  await s.run('extraFlows', () => extraFlows(ak, deps));
  const key = await s.run('readback', async () => {
    const k = str((await ak.json(`/api/v3/core/tokens/${SERVICE_TOKEN}/view_key/`))?.key);
    if (!k) throw new AkError('unexpected');
    return { state: 'ok', value: k };
  });
  if (s.failed || !key) return { steps: s.list };
  return { steps: s.list, values: { AUTHENTIK_API_TOKEN: key } };
}
