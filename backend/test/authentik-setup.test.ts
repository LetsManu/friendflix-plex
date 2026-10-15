// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AK_BLUEPRINT_DIR, AK_EXTRA_BLUEPRINTS, applyAuthentik, applyLockTtlS, IMPORT_TIMEOUT_MS, importBlueprint, planAuthentik, type AkStep } from '../src/setup/authentikSetup.js';
import { issueSetupCode } from '../src/setup/code.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Block 25 Task 13 (spec Part G "Authentik automation"): groups, provider, service account, flows and brand from a one-time admin token.
const ADMIN_TOKEN = 'ak-admin-placeholder-Tq39'; // a test placeholder, never a real credential
const SERVICE_KEY = 'ff-service-key-placeholder-0001'; // the service account's (fictional) token key
const AK = 'https://auth.example.com';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/authentik-setup/${name}.json`, import.meta.url), 'utf8'));

interface AkCall { method: string; path: string; search: string; auth?: string; json?: unknown; form?: Record<string, string>; init: RequestInit }
interface FakeOpts {
  superuser?: boolean; version?: string; meStatus?: number;
  /** pre-existing objects (an Authentik that has seen FriendFlix before) */
  groups?: string[]; provider?: Record<string, unknown> | null; app?: boolean; users?: string[]; flows?: string[];
  brandRecovery?: string | null; stageRecovery?: string | null;
  /** 1-based index of the blueprint import that answers success: false */
  failImport?: number;
  issuer?: string;
  /** the service account token works for the authentik probe */
  serviceKey?: string;
  throwOn?: string;
}

function fakeAuthentik(o: FakeOpts = {}) {
  const calls: AkCall[] = [];
  const imports: Array<{ file?: string; content?: string; context?: Record<string, string>; path?: string }> = [];
  const groups = new Map<string, string>((o.groups ?? []).map((n, i) => [n, `g-${i}`]));
  let provider: Record<string, unknown> | null = o.provider === undefined ? null : o.provider;
  let app = o.app ?? false;
  const users = new Set(o.users ?? []);
  const flows = new Map<string, string>((o.flows ?? []).map((s, i) => [s, `flow-${i}`]));
  const brand = { ...fixture('brand').results[0], flow_recovery: o.brandRecovery ?? null };
  const stage = { ...fixture('identification-stage').results[0], recovery_flow: o.stageRecovery ?? null };
  const patches: Array<{ path: string; json: unknown }> = [];
  const added: Array<{ group: string; pk: unknown }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const list = <T>(items: T[]) => json({ pagination: { count: items.length }, results: items });
  const key = o.serviceKey ?? SERVICE_KEY;

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: AkCall = { method, path: url.pathname, search: url.search, auth: headers.Authorization, init };
    if (init.body instanceof FormData) {
      call.form = {};
      for (const [k, v] of init.body.entries()) call.form[k] = typeof v === 'string' ? v : `file:${(v as File).name}:${(v as File).type}`;
    } else if (typeof init.body === 'string') call.json = JSON.parse(init.body);
    calls.push(call);
    if (o.throwOn && url.pathname.includes(o.throwOn)) throw new Error(`connect ECONNREFUSED ${ADMIN_TOKEN}`);
    const p = url.pathname;
    const q = url.searchParams;
    // the service account's token (authentik probe after the save) and the admin token
    const bearer = headers.Authorization?.replace(/^Bearer /, '');
    if (p === '/application/o/friendflix/.well-known/openid-configuration') {
      return json({ ...fixture('discovery'), issuer: o.issuer ?? `${AK}/application/o/friendflix/` });
    }
    if (bearer === key) {
      if (p === '/api/v3/core/users/me/') return json({ user: { pk: 99, username: 'friendflix-invites', is_superuser: false } });
      if (p === '/api/v3/flows/instances/friendflix-enrollment/') return flows.has('friendflix-enrollment') ? json({ slug: 'friendflix-enrollment' }) : json({}, 404);
      return json({ detail: 'denied' }, 403);
    }
    if (bearer !== ADMIN_TOKEN) return json({ detail: 'Token invalid/expired' }, 403);
    if (method === 'GET' && p === '/api/v3/core/users/me/') {
      if (o.meStatus) return json({}, o.meStatus);
      const me = fixture('me');
      me.user.is_superuser = o.superuser ?? true;
      return json(me);
    }
    if (method === 'GET' && p === '/api/v3/admin/version/') return json({ ...fixture('version'), version_current: o.version ?? '2026.8.3' });
    if (method === 'GET' && p === '/api/v3/core/groups/') {
      const n = q.get('name')!;
      return list(groups.has(n) ? [{ pk: groups.get(n), name: n }] : []);
    }
    if (method === 'POST' && /^\/api\/v3\/core\/groups\/[^/]+\/add_user\/$/.test(p)) {
      added.push({ group: p.split('/')[5]!, pk: (call.json as { pk: unknown }).pk });
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && p === '/api/v3/providers/oauth2/') return list(provider && q.get('name') === 'FriendFlix' ? [provider] : []);
    if (method === 'GET' && p === '/api/v3/core/applications/friendflix/') return app ? json({ slug: 'friendflix', provider: 3 }) : json({ detail: 'Not found.' }, 404);
    if (method === 'GET' && p === '/api/v3/core/users/') return list(users.has(q.get('username')!) ? [{ pk: 99, username: q.get('username') }] : []);
    const flow = /^\/api\/v3\/flows\/instances\/([^/]+)\/$/.exec(p);
    if (method === 'GET' && flow) return flows.has(flow[1]!) ? json({ pk: flows.get(flow[1]!), slug: flow[1] }) : json({ detail: 'Not found.' }, 404);
    if (method === 'GET' && p === '/api/v3/core/brands/') return q.get('default') === 'true' ? list([brand]) : json({}, 400);
    if (method === 'PATCH' && p === `/api/v3/core/brands/${brand.brand_uuid}/`) {
      patches.push({ path: p, json: call.json });
      Object.assign(brand, call.json);
      return json(brand);
    }
    if (method === 'GET' && p === '/api/v3/stages/identification/') return list(q.get('name') === stage.name ? [stage] : []);
    if (method === 'PATCH' && p === `/api/v3/stages/identification/${stage.pk}/`) {
      patches.push({ path: p, json: call.json });
      // Authentik 2026.8.3 validates user_fields / sources from the request only (seen live)
      const b = call.json as { user_fields?: unknown[]; sources?: unknown[] };
      if (!b.user_fields?.length && !b.sources?.length) return json({ non_field_errors: ['When no user fields are selected, at least one source must be selected'] }, 400);
      Object.assign(stage, call.json);
      return json(stage);
    }
    if (method === 'GET' && p === '/api/v3/core/tokens/friendflix-invites-token/view_key/') {
      return users.has('friendflix-invites') ? json({ key }) : json({ detail: 'Not found.' }, 404);
    }
    if (method === 'POST' && p === '/api/v3/managed/blueprints/import/') {
      const form = init.body as FormData;
      const file = form.get('file') as File | null;
      const entry = {
        ...(file ? { file: file.name, content: await file.text() } : {}),
        ...(form.get('path') ? { path: String(form.get('path')) } : {}),
        ...(form.get('context') ? { context: JSON.parse(String(form.get('context'))) as Record<string, string> } : {}),
      };
      imports.push(entry);
      if (o.failImport === imports.length) return json({ success: false, logs: [{ event: 'Entry invalid', log_level: 'warning' }] });
      if (entry.file === 'friendflix-setup.yaml') {
        groups.set(entry.context!.admin_group!, 'g-admins');
        groups.set('friendflix-users', 'g-users');
        provider = fixture('provider');
        app = true;
      } else if (entry.file === 'friendflix-service-account.yaml') users.add('friendflix-invites');
      else if (entry.file === 'friendflix-blueprint.yaml') {
        users.add('friendflix-invites');
        flows.set('friendflix-enrollment', 'flow-enroll');
      } else if (entry.path === 'example/flows-recovery-email-mfa-verification.yaml') flows.set('default-recovery-flow', 'flow-recovery');
      return json({ success: true, logs: [] });
    }
    return json({ detail: 'Not found.' }, 404);
  }) as typeof fetch;
  return { calls, imports, patches, added, groups, flows, brand, stage, fetchImpl };
}

const states = (steps: AkStep[]) => steps.map((s) => `${s.id}:${s.state}${s.detail ? `:${s.detail}` : ''}`);
const planInput = { url: AK, token: ADMIN_TOKEN };
const applyInput = { url: AK, token: ADMIN_TOKEN, addMeToAdmins: false, publicUrl: 'https://tv.example.com', adminGroup: 'friendflix-admins' };
const deps = (f: typeof fetch) => ({ fetchImpl: f, blueprintDir: AK_BLUEPRINT_DIR });

describe('planAuthentik', () => {
  it('is_superuser false → steps [check failed not_superuser], no further call', async () => {
    const ak = fakeAuthentik({ superuser: false });
    expect(states(await planAuthentik(planInput, { fetchImpl: ak.fetchImpl }))).toEqual(['check:failed:not_superuser']);
    expect(ak.calls.map((c) => c.path)).toEqual(['/api/v3/core/users/me/']);
  });

  it("version_current '2024.2.1' → unsupported_version; 2024.4 passes", async () => {
    expect(states(await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ version: '2024.2.1' }).fetchImpl }))).toEqual(['check:failed:unsupported_version']);
    expect(states(await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ version: 'garbage' }).fetchImpl }))).toEqual(['check:failed:unsupported_version']);
    expect((await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ version: '2024.4.0' }).fetchImpl }))[0]).toEqual({ id: 'check', state: 'ok' });
  });

  it('a wrong token (403) → unauthorized; a network error → unreachable; a redirect is not followed', async () => {
    expect(states(await planAuthentik({ url: AK, token: 'wrong' }, { fetchImpl: fakeAuthentik().fetchImpl }))).toEqual(['check:failed:unauthorized']);
    expect(states(await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ meStatus: 401 }).fetchImpl }))).toEqual(['check:failed:unauthorized']);
    expect(states(await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ meStatus: 500 }).fetchImpl }))).toEqual(['check:failed:unexpected']);
    expect(states(await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ throwOn: '/users/me/' }).fetchImpl }))).toEqual(['check:failed:unreachable']);
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/' } })) as unknown as typeof fetch;
    expect(states(await planAuthentik(planInput, { fetchImpl: redirect }))).toEqual(['check:failed:unreachable']);
    const notJson = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(states(await planAuthentik(planInput, { fetchImpl: notJson }))).toEqual(['check:failed:unexpected']);
    const timeout = (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    expect(states(await planAuthentik(planInput, { fetchImpl: timeout }))).toEqual(['check:failed:unreachable']);
  });

  it('plan on an empty Authentik → groups create, provider create, serviceAccount create, enrollment create, recovery create, brand create; plan makes only GET requests', async () => {
    const ak = fakeAuthentik();
    const steps = await planAuthentik(planInput, { fetchImpl: ak.fetchImpl });
    expect(states(steps)).toEqual(['check:ok', 'groups:create', 'provider:create', 'serviceAccount:create', 'enrollment:create', 'recovery:create', 'brand:create', 'extraFlows:skip']);
    expect(ak.calls.length).toBeGreaterThan(8);
    expect(new Set(ak.calls.map((c) => c.method))).toEqual(new Set(['GET']));
    for (const c of ak.calls.filter((x) => x.path.startsWith('/api/'))) expect(c.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    for (const c of ak.calls) {
      expect(c.init.redirect).toBe('manual');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('plan on a configured Authentik → exists / update; a provider with other settings → update', async () => {
    const done = { groups: ['friendflix-admins', 'friendflix-users'], provider: fixture('provider'), app: true, users: ['friendflix-invites'], flows: ['friendflix-enrollment', 'default-recovery-flow'], brandRecovery: 'flow-x', stageRecovery: 'flow-x' };
    const same = await planAuthentik({ ...planInput, publicUrl: 'https://tv.example.com' }, { fetchImpl: fakeAuthentik(done).fetchImpl });
    expect(states(same)).toEqual(['check:ok', 'groups:exists', 'provider:exists', 'serviceAccount:update', 'enrollment:update', 'recovery:exists', 'brand:exists', 'extraFlows:skip']);
    // grant types missing (an API-created provider), another redirect URI, or no application: the blueprint updates it
    const noGrant = await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ ...done, provider: { ...fixture('provider'), grant_types: [] } }).fetchImpl });
    expect(noGrant.find((s) => s.id === 'provider')?.state).toBe('update');
    const otherUri = await planAuthentik({ ...planInput, publicUrl: 'https://friend.example.com' }, { fetchImpl: fakeAuthentik(done).fetchImpl });
    expect(otherUri.find((s) => s.id === 'provider')?.state).toBe('update');
    const noApp = await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ ...done, app: false }).fetchImpl });
    expect(noApp.find((s) => s.id === 'provider')?.state).toBe('update');
    // one group missing → create; only the identification stage lacks the recovery flow → brand create
    const partial = await planAuthentik(planInput, { fetchImpl: fakeAuthentik({ ...done, groups: ['friendflix-users'], stageRecovery: null }).fetchImpl });
    expect(states(partial)).toContain('groups:create');
    expect(states(partial)).toContain('brand:create');
  });

  it('refuses a URL with credentials or another scheme before any request', async () => {
    const ak = fakeAuthentik();
    for (const url of ['https://akadmin:x@auth.example.com', 'ftp://auth.example.com', 'not a url']) {
      expect(states(await planAuthentik({ ...planInput, url }, { fetchImpl: ak.fetchImpl }))).toEqual(['check:failed:invalid_url']);
    }
    expect(ak.calls).toEqual([]);
  });
});

describe('applyAuthentik', () => {
  it('apply posts three blueprint files then the recovery path import; the friendflix-setup import has context {"public_url":"https://tv.example.com","admin_group":"friendflix-admins"}', async () => {
    const ak = fakeAuthentik();
    const r = await applyAuthentik(applyInput, deps(ak.fetchImpl));
    expect(states(r.steps)).toEqual(['check:ok', 'groups:ok', 'provider:ok', 'serviceAccount:ok', 'enrollment:ok', 'recovery:ok', 'brand:ok', 'readback:ok', 'adminMember:skip', 'extraFlows:skip']);
    expect(ak.imports.map((i) => i.file ?? `path:${i.path}`)).toEqual([
      'friendflix-setup.yaml', 'friendflix-service-account.yaml', 'friendflix-blueprint.yaml', 'path:example/flows-recovery-email-mfa-verification.yaml',
    ]);
    expect(ak.imports[0]!.context).toEqual({ public_url: 'https://tv.example.com', admin_group: 'friendflix-admins' });
    // the files are sent unchanged, as YAML uploads
    expect(ak.imports[1]!.content).toBe(readFileSync(new URL('../../deploy/authentik/friendflix-service-account.yaml', import.meta.url), 'utf8'));
    const uploads = ak.calls.filter((c) => c.path === '/api/v3/managed/blueprints/import/');
    expect(uploads[0]!.form).toMatchObject({ file: 'file:friendflix-setup.yaml:application/x-yaml' });
    expect(uploads[1]!.form!.context).toBe('{}');
    // the brand and the identification stage get the recovery flow
    expect(ak.patches).toEqual([
      { path: `/api/v3/core/brands/${ak.brand.brand_uuid}/`, json: { flow_recovery: 'flow-recovery' } },
      { path: `/api/v3/stages/identification/${ak.stage.pk}/`, json: { user_fields: ['email', 'username'], sources: [], recovery_flow: 'flow-recovery' } },
    ]);
  });

  it('recovery flow exists → recovery exists, no import; brand with flow_recovery set → brand exists, no PATCH', async () => {
    const ak = fakeAuthentik({ flows: ['default-recovery-flow'], brandRecovery: 'flow-other', stageRecovery: 'flow-other' });
    const r = await applyAuthentik(applyInput, deps(ak.fetchImpl));
    expect(states(r.steps)).toContain('recovery:exists');
    expect(states(r.steps)).toContain('brand:exists');
    expect(ak.imports.some((i) => i.path)).toBe(false);
    expect(ak.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(ak.brand.flow_recovery).toBe('flow-other'); // never overwritten
  });

  it("readback: values.OIDC_ISSUER === 'https://auth.example.com/application/o/friendflix/', OIDC_CLIENT_ID/SECRET from the provider list, AUTHENTIK_API_TOKEN === the view_key result (not the admin token)", async () => {
    const ak = fakeAuthentik();
    const r = await applyAuthentik({ ...applyInput, url: `${AK}/` }, deps(ak.fetchImpl));
    expect(r.values).toEqual({
      AUTHENTIK_URL: AK,
      AUTHENTIK_API_TOKEN: SERVICE_KEY,
      OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/',
      OIDC_CLIENT_ID: 'fictional-client-id-0001',
      OIDC_CLIENT_SECRET: 'fictional-client-secret-0001',
      ADMIN_GROUP: 'friendflix-admins',
      AUTHENTIK_ENROLL_FLOW: 'friendflix-enrollment',
      AUTHENTIK_RECOVERY_FLOW: 'default-recovery-flow',
    });
    expect(JSON.stringify(r)).not.toContain(ADMIN_TOKEN);
    // the discovery document is fetched without the admin token
    const disc = ak.calls.find((c) => c.path.endsWith('/.well-known/openid-configuration'))!;
    expect(disc.auth).toBeUndefined();
  });

  it('discovery issuer mismatch → readback failed issuer_mismatch, values undefined', async () => {
    const r = await applyAuthentik(applyInput, deps(fakeAuthentik({ issuer: 'https://other.example.com/application/o/friendflix/' }).fetchImpl));
    expect(states(r.steps).at(-1)).toBe('readback:failed:issuer_mismatch');
    expect(r.values).toBeUndefined();
  });

  it('addMeToAdmins → POST core/groups/<pk>/add_user/ {pk: me.user.pk}', async () => {
    const ak = fakeAuthentik();
    const r = await applyAuthentik({ ...applyInput, addMeToAdmins: true }, deps(ak.fetchImpl));
    expect(states(r.steps)).toContain('adminMember:ok');
    expect(ak.added).toEqual([{ group: 'g-admins', pk: 7 }]);
    const post = ak.calls.find((c) => c.path.endsWith('/add_user/'))!;
    expect(post.path).toBe('/api/v3/core/groups/g-admins/add_user/');
    expect(post.json).toEqual({ pk: 7 });
  });

  it('import 2 answers success false → that step failed blueprint_invalid, later steps absent', async () => {
    const ak = fakeAuthentik({ failImport: 2 });
    const r = await applyAuthentik(applyInput, deps(ak.fetchImpl));
    expect(states(r.steps)).toEqual(['check:ok', 'groups:ok', 'provider:ok', 'serviceAccount:failed:blueprint_invalid']);
    expect(r.values).toBeUndefined();
    expect(ak.imports.length).toBe(2);
    // the first file holds the groups and the provider: its failure is reported on both (the import cannot tell which part failed)
    const first = await applyAuthentik(applyInput, deps(fakeAuthentik({ failImport: 1 }).fetchImpl));
    expect(states(first.steps)).toEqual(['check:ok', 'groups:failed:blueprint_invalid', 'provider:failed:blueprint_invalid']);
  });

  it('a failed check ends apply with that step alone (200 with the step list, no import): not_superuser, unauthorized', async () => {
    const su = fakeAuthentik({ superuser: false });
    const r = await applyAuthentik(applyInput, deps(su.fetchImpl));
    expect(states(r.steps)).toEqual(['check:failed:not_superuser']);
    expect(r.values).toBeUndefined();
    expect(su.imports).toEqual([]);
    const denied = await applyAuthentik(applyInput, deps(fakeAuthentik({ meStatus: 401 }).fetchImpl));
    expect(states(denied.steps)).toEqual(['check:failed:unauthorized']);
  });

  it('a failure in a later step stops the run there (codes only)', async () => {
    const r = await applyAuthentik(applyInput, deps(fakeAuthentik({ throwOn: '/core/brands/' }).fetchImpl));
    expect(states(r.steps).at(-1)).toBe('brand:failed:unreachable');
    expect(JSON.stringify(r)).not.toContain(ADMIN_TOKEN);
    expect(r.values).toBeUndefined();
  });

  it("the apply lock's TTL outlasts a run's worst case, extra blueprints included", async () => {
    // 3 file imports + 3 path attempts at 60 s, 2 pauses, about 13 other requests at 10 s, the probes after the save
    expect(applyLockTtlS()).toBeGreaterThanOrEqual((6 * IMPORT_TIMEOUT_MS + 6_000 + 13 * 10_000 + 60_000) / 1000);
    const base = applyLockTtlS();
    AK_EXTRA_BLUEPRINTS.push({ id: 'emailChange', file: 'friendflix-service-account.yaml' });
    try {
      expect(applyLockTtlS()).toBe(base + IMPORT_TIMEOUT_MS / 1000);
    } finally {
      AK_EXTRA_BLUEPRINTS.length = 0;
    }
  });

  it('extra blueprints (phase 3) are imported after the admin membership, with their context', async () => {
    const ak = fakeAuthentik();
    AK_EXTRA_BLUEPRINTS.push({ id: 'emailChange', file: 'friendflix-service-account.yaml', context: (c) => ({ flow: c.AUTHENTIK_EMAIL_CHANGE_FLOW }) });
    try {
      const plan = await planAuthentik(planInput, { fetchImpl: ak.fetchImpl });
      expect(states(plan).at(-1)).toBe('extraFlows:update');
      const r = await applyAuthentik(applyInput, { ...deps(ak.fetchImpl), cfg: { AUTHENTIK_EMAIL_CHANGE_FLOW: 'friendflix-email-change' } as never });
      expect(states(r.steps).at(-1)).toBe('extraFlows:ok');
      expect(ak.imports.at(-1)!.context).toEqual({ flow: 'friendflix-email-change' });
    } finally {
      AK_EXTRA_BLUEPRINTS.length = 0;
    }
  });
});

describe('importBlueprint', () => {
  it('posts multipart file + context or a path; success false → blueprint_invalid; 400 → blueprint_invalid; a file name outside the folder is refused', async () => {
    const ak = fakeAuthentik();
    await importBlueprint(AK, ADMIN_TOKEN, { path: 'example/flows-recovery-email-mfa-verification.yaml' }, deps(ak.fetchImpl));
    expect(ak.imports).toEqual([{ path: 'example/flows-recovery-email-mfa-verification.yaml', context: {} }]);
    const failing = fakeAuthentik({ failImport: 1 });
    await expect(importBlueprint(AK, ADMIN_TOKEN, { file: 'friendflix-setup.yaml', context: {} }, deps(failing.fetchImpl))).rejects.toMatchObject({ code: 'blueprint_invalid' });
    const bad = (async () => new Response(JSON.stringify({ file: ['invalid'] }), { status: 400 })) as unknown as typeof fetch;
    await expect(importBlueprint(AK, ADMIN_TOKEN, { file: 'friendflix-setup.yaml', context: {} }, deps(bad))).rejects.toMatchObject({ code: 'blueprint_invalid' });
    await expect(importBlueprint(AK, ADMIN_TOKEN, { file: '../../etc/passwd', context: {} }, deps(ak.fetchImpl))).rejects.toMatchObject({ code: 'blueprint_invalid' });
    await expect(importBlueprint('ftp://auth.example.com', ADMIN_TOKEN, { path: 'x.yaml' }, deps(ak.fetchImpl))).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(importBlueprint(AK, ADMIN_TOKEN, { file: 'no-such-file.yaml', context: {} }, deps(ak.fetchImpl))).rejects.toMatchObject({ code: 'blueprint_invalid' });
    const huge = (async () => new Response(JSON.stringify({ success: true, logs: ['x'.repeat(5 * 1024 * 1024)] }), { status: 200 })) as unknown as typeof fetch;
    await expect(importBlueprint(AK, ADMIN_TOKEN, { path: 'x.yaml' }, deps(huge))).rejects.toMatchObject({ code: 'blueprint_invalid' });
  });

  it('a path import answered 5xx (the worker did not list the blueprints in time) is retried, a file import is not', async () => {
    const answers = (statuses: number[]) => {
      const seen: number[] = [];
      const f = (async () => {
        const s = statuses[seen.length] ?? 200;
        seen.push(s);
        return new Response(s === 200 ? JSON.stringify({ success: true, logs: [] }) : 'Internal Server Error', { status: s });
      }) as unknown as typeof fetch;
      return { f, seen };
    };
    const ok = answers([500, 500]);
    await importBlueprint(AK, ADMIN_TOKEN, { path: 'example/x.yaml' }, { ...deps(ok.f), retryDelayMs: 0 });
    expect(ok.seen).toEqual([500, 500, 200]);
    const down = answers([500, 502, 503, 200]);
    await expect(importBlueprint(AK, ADMIN_TOKEN, { path: 'example/x.yaml' }, { ...deps(down.f), retryDelayMs: 0 })).rejects.toMatchObject({ code: 'unexpected' });
    expect(down.seen).toEqual([500, 502, 503]);
    const file = answers([500]);
    await expect(importBlueprint(AK, ADMIN_TOKEN, { file: 'friendflix-setup.yaml', context: {} }, { ...deps(file.f), retryDelayMs: 0 })).rejects.toMatchObject({ code: 'unexpected' });
    expect(file.seen).toEqual([500]);
  });

  it('blueprint imports get the longer deadline; other calls 10 s', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    try {
      await applyAuthentik(applyInput, deps(fakeAuthentik().fetchImpl));
      const ms = timeouts.mock.calls.map((c) => c[0]);
      expect(ms.filter((x) => x === IMPORT_TIMEOUT_MS).length).toBe(4);
      expect(ms.filter((x) => x === 10_000).length).toBe(ms.length - 4);
    } finally {
      timeouts.mockRestore();
    }
  });
});

describe('deploy/authentik/friendflix-setup.yaml', () => {
  // D24: no YAML parser dependency; the structure is asserted here, the live import against Authentik 2026.8.3 proves the parse
  const text = readFileSync(new URL('../../deploy/authentik/friendflix-setup.yaml', import.meta.url), 'utf8');
  const body = text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  it('has the SPDX header and an import note like the other blueprints', () => {
    expect(text.startsWith('# SPDX-FileCopyrightText: 2026 Manuel Weißböck\n# SPDX-License-Identifier: AGPL-3.0-or-later\n')).toBe(true);
    expect(text).toMatch(/# Import/);
    expect(body).toMatch(/^version: 1$/m);
    expect(body).not.toMatch(/\t/);
  });

  it('contains grant_types [authorization_code], the strict redirect !Format, the implicit-consent !Find and the context keys', () => {
    expect(body).toMatch(/^ {6}grant_types: \[authorization_code\]$/m);
    expect(body).toMatch(/- matching_mode: strict\n\s+url: !Format \["%s\/auth\/callback", !Context public_url\]/);
    expect(body).toMatch(/authorization_flow: !Find \[authentik_flows\.flow, \[slug, default-provider-authorization-implicit-consent\]\]/);
    expect(body).toMatch(/invalidation_flow: !Find \[authentik_flows\.flow, \[slug, default-provider-invalidation-flow\]\]/);
    expect(body).toMatch(/signing_key: !Find \[authentik_crypto\.certificatekeypair, \[name, "authentik Self-signed Certificate"\]\]/);
    for (const s of ['openid', 'email', 'profile']) expect(body).toContain(`goauthentik.io/providers/oauth2/scope-${s}]]`);
    expect(body).toMatch(/^context:\n {2}admin_group: friendflix-admins$/m);
    expect(body).toMatch(/name: !Context admin_group/);
    expect(body).toMatch(/meta_launch_url: !Context public_url/);
    for (const kv of ['client_type: confidential', 'sub_mode: hashed_user_id', 'include_claims_in_id_token: true', 'issuer_mode: per_provider', 'slug: friendflix', 'policy_engine_mode: any', 'name: friendflix-users']) {
      expect(body).toContain(kv);
    }
    // every !Context names one of the two keys the wizard sends
    expect([...body.matchAll(/!Context (\w+)/g)].map((m) => m[1]).every((k) => k === 'public_url' || k === 'admin_group')).toBe(true);
    // consistent indentation: every line indents by an even number of spaces
    for (const line of body.split('\n')) expect((/^ */.exec(line)![0].length) % 2, line).toBe(0);
  });
});

describe('POST /api/setup/authentik/plan and /apply', () => {
  const logs: string[] = [];
  let env: TestEnv;
  let ak: ReturnType<typeof fakeAuthentik>;
  let sess: { cookies: Record<string, string>; csrf: string };
  let ip = 0;
  beforeAll(async () => {
    env = await makeEnv({}, {
      setupComplete: false,
      ctxPatch: (c) => { c.fetchImpl = ((u: RequestInfo | URL, i?: RequestInit) => ak.fetchImpl(u, i)) as typeof fetch; },
      logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' },
    });
    const code = await issueSetupCode(env.ctx);
    const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: '10.97.0.1' });
    const csrf = r.cookies.find((c) => c.name === 'ff_setup_csrf')!.value;
    sess = { cookies: { ff_setup: r.cookies.find((c) => c.name === 'ff_setup')!.value, ff_setup_csrf: csrf }, csrf };
  });
  afterAll(() => env.close());
  const post = (what: 'plan' | 'apply', payload: Record<string, unknown>, s: Partial<typeof sess> = sess, headers: Record<string, string> = { 'x-ff-setup-csrf': sess.csrf }) =>
    env.app.inject({ method: 'POST', url: `/api/setup/authentik/${what}`, cookies: s.cookies ?? {}, headers, payload, remoteAddress: `10.96.0.${++ip}` });

  it('needs the setup session and its csrf header', async () => {
    ak = fakeAuthentik();
    for (const what of ['plan', 'apply'] as const) {
      expect((await post(what, planInput, {}, {})).statusCode).toBe(401);
      expect((await post(what, planInput, sess, {})).statusCode).toBe(403);
    }
    expect(ak.calls).toEqual([]);
  });

  it('validates the URL before any request (http/https, no userinfo)', async () => {
    ak = fakeAuthentik();
    for (const url of ['https://akadmin:x@auth.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      for (const what of ['plan', 'apply'] as const) {
        const r = await post(what, { ...planInput, url, addMeToAdmins: false });
        expect(r.statusCode, url).toBe(400);
        expect(r.json()).toEqual({ ok: false, code: 'invalid', detail: 'invalid_url' });
      }
    }
    expect((await post('apply', planInput)).statusCode).toBe(400); // addMeToAdmins missing
    expect(ak.calls).toEqual([]);
  });

  it('plan returns the steps and makes only GET requests', async () => {
    ak = fakeAuthentik();
    const r = await post('plan', planInput);
    expect(r.statusCode).toBe(200);
    expect(states(r.json().steps)).toEqual(['check:ok', 'groups:create', 'provider:create', 'serviceAccount:create', 'enrollment:create', 'recovery:create', 'brand:create', 'extraFlows:skip']);
    expect(new Set(ak.calls.map((c) => c.method))).toEqual(new Set(['GET']));
  });

  it('apply saves the eight keys and returns the steps', async () => {
    ak = fakeAuthentik();
    const r = await post('apply', { ...planInput, addMeToAdmins: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(states(r.json().steps)).toContain('adminMember:ok');
    // the redirect URI is built from the saved public URL
    expect(ak.imports[0]!.context).toEqual({ public_url: env.ctx.cfg.PUBLIC_URL, admin_group: 'friendflix-admins' });
    await env.ctx.settings.reload();
    const c = env.ctx.cfg;
    expect({
      AUTHENTIK_URL: c.AUTHENTIK_URL, AUTHENTIK_API_TOKEN: c.AUTHENTIK_API_TOKEN, OIDC_ISSUER: c.OIDC_ISSUER, OIDC_CLIENT_ID: c.OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: c.OIDC_CLIENT_SECRET,
      ADMIN_GROUP: c.ADMIN_GROUP, AUTHENTIK_ENROLL_FLOW: c.AUTHENTIK_ENROLL_FLOW, AUTHENTIK_RECOVERY_FLOW: c.AUTHENTIK_RECOVERY_FLOW,
    }).toEqual({
      AUTHENTIK_URL: AK, AUTHENTIK_API_TOKEN: SERVICE_KEY, OIDC_ISSUER: `${AK}/application/o/friendflix/`, OIDC_CLIENT_ID: 'fictional-client-id-0001',
      OIDC_CLIENT_SECRET: 'fictional-client-secret-0001', ADMIN_GROUP: 'friendflix-admins', AUTHENTIK_ENROLL_FLOW: 'friendflix-enrollment', AUTHENTIK_RECOVERY_FLOW: 'default-recovery-flow',
    });
    // both probes ran with the new values: the service account's token, not the admin token
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/instances/friendflix-enrollment/' && c.auth === `Bearer ${SERVICE_KEY}`)).toBe(true);
    const audit = await env.pool.query("select meta from audit_log where action = 'settings.update' order by id desc limit 1");
    expect(audit.rows[0].meta.keys.sort()).toEqual(['ADMIN_GROUP', 'AUTHENTIK_API_TOKEN', 'AUTHENTIK_ENROLL_FLOW', 'AUTHENTIK_RECOVERY_FLOW', 'AUTHENTIK_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER']);
    expect(await env.ctx.kv.get('setup:authentik:apply')).toBeNull(); // the lock is released
    // step 5 may say "Sign in with Authentik" (also after a reload); a sign-in key saved by hand makes it neutral again
    const state = () => env.app.inject({ url: '/api/setup/state', cookies: sess.cookies }).then((x) => x.json().signinVia);
    expect(await state()).toBe('authentik');
    const put = await env.app.inject({ method: 'PUT', url: '/api/setup/settings', cookies: sess.cookies, headers: { 'x-ff-setup-csrf': sess.csrf }, payload: { values: { ADMIN_GROUP: 'friendflix-admins' } } });
    expect(put.statusCode).toBe(200);
    expect(await state()).toBeNull();
  });

  it('a failed step answers ok false with the steps; nothing is saved', async () => {
    ak = fakeAuthentik({ failImport: 3 });
    const rev = env.ctx.settings.rev();
    const r = await post('apply', { ...planInput, addMeToAdmins: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: false, steps: expect.any(Array) });
    expect(states(r.json().steps).at(-1)).toBe('enrollment:failed:blueprint_invalid');
    expect(env.ctx.settings.rev()).toBe(rev);
  });

  it('a probe refusal after apply: 400 probe_failed with the steps; nothing saved', async () => {
    ak = fakeAuthentik({ serviceKey: 'other-service-key-placeholder' });
    // the service token the readback returns does not work (fake: only `other-...` is known, but view_key says so too) → swap the probe's answer
    const real = ak.fetchImpl;
    ak.fetchImpl = (async (u: RequestInfo | URL, i?: RequestInit) => {
      if (String(u).includes('/flows/instances/friendflix-enrollment/') && (i?.headers as Record<string, string>).Authorization !== `Bearer ${ADMIN_TOKEN}`) return new Response('{}', { status: 403 });
      return real(u, i);
    }) as typeof fetch;
    const rev = env.ctx.settings.rev();
    const r = await post('apply', { ...planInput, addMeToAdmins: false });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'probe_failed', group: 'signin', steps: expect.any(Array) });
    expect(env.ctx.settings.rev()).toBe(rev);
  });

  it('one run at a time: 409 busy while another holds the lock (no request)', async () => {
    ak = fakeAuthentik();
    await env.ctx.kv.set('setup:authentik:apply', '1', 120);
    try {
      const r = await post('apply', { ...planInput, addMeToAdmins: false });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'busy' });
      expect(ak.calls).toEqual([]);
    } finally {
      await env.ctx.kv.del('setup:authentik:apply');
    }
  });

  it("a run that outlasted its lock never releases the next run's lock; its own lock has an owner value and the derived TTL", async () => {
    ak = fakeAuthentik();
    const real = ak.fetchImpl;
    let seen: string | null = null;
    ak.fetchImpl = (async (u: RequestInfo | URL, i?: RequestInit) => {
      // mid-run: the lock is this run's (a random owner value), then it runs out and another run takes it
      if (seen === null && String(u).includes('/managed/blueprints/import/')) {
        seen = await env.ctx.kv.get('setup:authentik:apply');
        await env.ctx.kv.set('setup:authentik:apply', 'next-run', 60);
      }
      return real(u, i);
    }) as typeof fetch;
    const setnx = vi.spyOn(env.ctx.kv, 'setnx');
    try {
      const r = await post('apply', { ...planInput, addMeToAdmins: false });
      expect(r.statusCode).toBe(200);
      expect(setnx).toHaveBeenCalledWith('setup:authentik:apply', expect.any(String), applyLockTtlS());
      expect(seen).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(await env.ctx.kv.get('setup:authentik:apply')).toBe('next-run');
    } finally {
      setnx.mockRestore();
      await env.ctx.kv.del('setup:authentik:apply');
    }
  });

  it('sign-in keys from the environment are kept and, when Authentik now has another value, reported by name (never the value)', async () => {
    ak = fakeAuthentik();
    const real = env.ctx.settings.sources.bind(env.ctx.settings);
    const cfg = vi.spyOn(env.ctx, 'cfg', 'get').mockReturnValue({ ...env.ctx.cfg, OIDC_CLIENT_ID: 'env-client-id-placeholder', ADMIN_GROUP: 'friendflix-admins' } as never);
    const spy = vi.spyOn(env.ctx.settings, 'sources').mockImplementation(() => ({ ...real(), OIDC_CLIENT_ID: 'env', ADMIN_GROUP: 'env' }));
    try {
      const r = await post('apply', { ...planInput, addMeToAdmins: false });
      expect(r.statusCode).toBe(200);
      // ADMIN_GROUP from the environment is the one Authentik got: not reported
      expect(r.json()).toMatchObject({ ok: true, envKept: ['OIDC_CLIENT_ID'] });
      expect(r.body).not.toContain('env-client-id-placeholder');
      expect(r.body).not.toContain('fictional-client-id-0001');
      const audit = await env.pool.query("select meta from audit_log where action = 'settings.update' order by id desc limit 1");
      expect(audit.rows[0].meta.keys).not.toContain('OIDC_CLIENT_ID');
    } finally {
      spy.mockRestore();
      cfg.mockRestore();
    }
    // nothing from the environment: no envKept at all
    ak = fakeAuthentik();
    expect((await post('apply', { ...planInput, addMeToAdmins: false })).json().envKept).toBeUndefined();
  });

  it('PUBLIC_URL unset → 400 public_url_missing, no request', async () => {
    ak = fakeAuthentik();
    const spy = vi.spyOn(env.ctx, 'cfg', 'get').mockReturnValue({ ...env.ctx.cfg, PUBLIC_URL: undefined } as never);
    try {
      const r = await post('apply', { ...planInput, addMeToAdmins: false });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ ok: false, code: 'invalid', detail: 'public_url_missing' });
    } finally {
      spy.mockRestore();
    }
    expect(ak.calls).toEqual([]);
  });

  it('the admin token is not in any saved setting, kv key, log call or response body (search everything)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const bodies: string[] = [];
    try {
      for (const o of [{}, { superuser: false }, { meStatus: 500 }, { failImport: 2 }, { issuer: 'https://x.example.com/' }, { throwOn: '/managed/blueprints/import/' }, { throwOn: '/users/me/' }] as FakeOpts[]) {
        for (const what of ['plan', 'apply'] as const) {
          ak = fakeAuthentik(o);
          bodies.push((await post(what, { ...planInput, addMeToAdmins: true })).body);
        }
      }
      // a body that fails validation (4xx) and an unhandled error (5xx) quote nothing of the request
      bodies.push((await post('apply', { ...planInput, addMeToAdmins: 'yes' })).body);
      bodies.push((await post('plan', { url: AK, token: `${ADMIN_TOKEN}${'x'.repeat(600)}` })).body);
      ak = { ...fakeAuthentik(), fetchImpl: (() => { throw new TypeError(`sync ${ADMIN_TOKEN}`); }) as unknown as typeof fetch };
      const crash = await post('apply', { ...planInput, addMeToAdmins: false });
      bodies.push(crash.body);
      // a 5xx: the settings write throws with an error text that quotes the token
      ak = fakeAuthentik();
      const save = vi.spyOn(env.ctx.settings, 'save').mockRejectedValueOnce(Object.assign(new Error(`db down ${ADMIN_TOKEN}`), { code: 'ECONNRESET' }));
      try {
        const r500 = await post('apply', { ...planInput, addMeToAdmins: false });
        expect(r500.statusCode).toBe(500);
        bodies.push(r500.body);
      } finally {
        save.mockRestore();
      }
      expect(await env.ctx.kv.get('setup:authentik:apply')).toBeNull(); // released in finally
      for (const b of bodies) expect(b).not.toContain(ADMIN_TOKEN);
      for (const s of spies) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(ADMIN_TOKEN);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(ADMIN_TOKEN);
    // saved settings (values and encrypted rows decrypted through the store), audit rows and kv
    await env.ctx.settings.reload();
    expect(JSON.stringify(env.ctx.cfg)).not.toContain(ADMIN_TOKEN);
    expect(env.ctx.cfg.AUTHENTIK_API_TOKEN).toBe(SERVICE_KEY);
    const rows = await env.pool.query('select * from settings');
    expect(JSON.stringify(rows.rows)).not.toContain(ADMIN_TOKEN);
    const audit = await env.pool.query('select * from audit_log');
    expect(JSON.stringify(audit.rows)).not.toContain(ADMIN_TOKEN);
    // every kv key and value, through the public API
    const keys = await env.kv.keys('');
    expect(keys.length).toBeGreaterThan(0);
    expect(JSON.stringify([keys, await env.kv.mget(keys)])).not.toContain(ADMIN_TOKEN);
  });
});
