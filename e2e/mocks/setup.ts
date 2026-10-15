// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Setup wizard fixtures (shapes follow backend/src/routes/setup.ts). Stateful: unlocking opens the setup session (cookies
 * ff_setup + ff_setup_csrf), saves mark the steps done. Every write must carry x-ff-setup-csrf equal to the cookie, like the backend.
 * While `complete` is false, /api/me answers 503 setup_required (mocks/api.ts).
 */

type Step = 'todo' | 'done' | 'env';
export interface ProbeMock { ok: boolean; code: string; detail?: string }
export interface AkStepMock { id: string; state: string; detail?: string }
export interface SetupMock {
  complete: boolean;
  unlocked: boolean;
  /** the code from the log (any case, dashes optional) */
  code: string;
  /** the next unlock answers this error (status, body) instead of checking the code */
  unlockError: { status: number; error: string } | null;
  media: { keys: string[]; auto: string[] | null };
  steps: { publicUrl: Step; media: Step; signin: Step; admin: Step };
  /** the backend's prefill: the saved PUBLIC_URL, else the browser's origin */
  prefill: { publicUrl: string | null };
  /** 'authentik' after a successful apply; a PUT of a sign-in key clears it */
  signinVia: 'authentik' | null;
  /** POST /api/setup/test answers per group */
  testResults: Record<string, ProbeMock>;
  /** the next PUT /api/setup/settings without force answers 400 probe_failed with this probe (then it is cleared) */
  saveProbeFail: ProbeMock | null;
  /** the next PUT answers this error (then it is cleared) */
  saveError: { status: number; body: object } | null;
  /** answer of POST /api/setup/media/auto (200) */
  autoResult: { ok: true } | ProbeMock;
  planSteps: AkStepMock[];
  /** answer of POST /api/setup/authentik/apply: status + body */
  apply: { status: number; body: object };
  /** apply waits this long (the real one takes ~30 s) */
  applyDelayMs: number;
  puts: Array<{ values: Record<string, unknown>; force?: boolean }>;
  tests: Array<{ group: string; values?: Record<string, unknown> }>;
  autos: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  applies: Array<Record<string, unknown>>;
  unlocks: string[];
  /** writes whose x-ff-setup-csrf did not match the cookie */
  badCsrf: number;
}

export const SETUP_CODE = 'K7QM-3XA9-PT2D';
const CSRF = 'mock-setup-csrf-token';
const AK_PLAN: AkStepMock[] = [
  { id: 'check', state: 'ok' }, { id: 'groups', state: 'create' }, { id: 'provider', state: 'update' }, { id: 'serviceAccount', state: 'create' },
  { id: 'enrollment', state: 'create' }, { id: 'recovery', state: 'exists' }, { id: 'brand', state: 'create' }, { id: 'extraFlows', state: 'skip' },
];
export const AK_APPLIED: AkStepMock[] = [
  { id: 'check', state: 'ok' }, { id: 'groups', state: 'ok' }, { id: 'provider', state: 'ok' }, { id: 'serviceAccount', state: 'ok' },
  { id: 'enrollment', state: 'ok' }, { id: 'recovery', state: 'exists' }, { id: 'brand', state: 'ok' }, { id: 'readback', state: 'ok' },
  { id: 'adminMember', state: 'ok' }, { id: 'extraFlows', state: 'skip' },
];

export function setupState(): SetupMock {
  return {
    complete: false, unlocked: false, code: SETUP_CODE, unlockError: null,
    media: { keys: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'], auto: ['url', 'username', 'password'] },
    steps: { publicUrl: 'todo', media: 'todo', signin: 'todo', admin: 'todo' },
    prefill: { publicUrl: 'https://tv.example.com' }, signinVia: null,
    testResults: {}, saveProbeFail: null, saveError: null, autoResult: { ok: true },
    planSteps: AK_PLAN, apply: { status: 200, body: { ok: true, steps: AK_APPLIED } }, applyDelayMs: 0,
    puts: [], tests: [], autos: [], plans: [], applies: [], unlocks: [], badCsrf: 0,
  };
}

const norm = (s: string) => s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const SIGNIN = /^(OIDC_|AUTHENTIK_|ADMIN_GROUP$)/;

type Reply = (b: unknown, status?: number, headers?: Record<string, string>) => Promise<void>;

/** null when the path is not a setup endpoint */
export function setupRoute(st: SetupMock, m: string, p: string, body: any, headers: Record<string, string>, J: Reply): Promise<void> | null {
  if (p === '/api/setup/state' && m === 'GET') {
    if (st.complete) return J({ complete: true }); // nothing else once complete (backend: routes/setup.ts)
    return J({ complete: false, unlocked: st.unlocked, mediaKind: 'jellyfin', media: st.media, steps: st.steps, prefill: st.prefill, signinVia: st.signinVia });
  }
  if (p === '/api/setup/unlock' && m === 'POST') {
    st.unlocks.push(String(body.code ?? ''));
    if (st.complete) return J({ error: 'setup_complete' }, 409);
    if (st.unlockError) return J({ error: st.unlockError.error }, st.unlockError.status);
    if (norm(String(body.code ?? '')) !== norm(st.code)) return J({ error: 'wrong_code' }, 401);
    st.unlocked = true;
    return J({ ok: true }, 200, { 'set-cookie': `ff_setup_csrf=${CSRF}; Path=/; SameSite=Strict` });
  }
  if (!p.startsWith('/api/setup/')) return null;
  // the session endpoints (requireSetupSession)
  if (st.complete) return J({ error: 'setup_complete' }, 409);
  if (!st.unlocked) return J({ error: 'setup_session_required' }, 401);
  if (headers['x-ff-setup-csrf'] !== CSRF || !(headers.cookie ?? '').includes(`ff_setup_csrf=${CSRF}`)) { st.badCsrf++; return J({ error: 'csrf' }, 403); }
  if (p === '/api/setup/settings' && m === 'PUT') {
    const values: Record<string, unknown> = body.values ?? {};
    st.puts.push(body.force === undefined ? { values } : { values, force: body.force });
    if (st.saveError) { const e = st.saveError; st.saveError = null; return J(e.body, e.status); }
    if (st.saveProbeFail && !body.force) { const probe = st.saveProbeFail; st.saveProbeFail = null; return J({ error: 'probe_failed', group: 'media', probe }, 400); }
    const keys = Object.keys(values);
    if (keys.includes('PUBLIC_URL')) st.steps.publicUrl = 'done';
    if (keys.some((k) => st.media.keys.includes(k))) st.steps.media = 'done';
    if (keys.some((k) => SIGNIN.test(k))) { st.steps.signin = 'done'; st.signinVia = null; }
    return J({ rev: 3 });
  }
  if (p === '/api/setup/test' && m === 'POST') {
    st.tests.push(body);
    return J(st.testResults[body.group] ?? { ok: true, code: 'ok' });
  }
  if (p === '/api/setup/media/auto' && m === 'POST') {
    st.autos.push(body);
    if (st.autoResult.ok) st.steps.media = 'done';
    return J(st.autoResult);
  }
  if (p === '/api/setup/authentik/plan' && m === 'POST') {
    st.plans.push(body);
    return J({ steps: st.planSteps });
  }
  if (p === '/api/setup/authentik/apply' && m === 'POST') {
    st.applies.push(body);
    const done = () => {
      if (st.apply.status === 200 && (st.apply.body as { ok?: boolean }).ok) { st.steps.signin = 'done'; st.signinVia = 'authentik'; }
      return J(st.apply.body, st.apply.status);
    };
    return st.applyDelayMs ? new Promise((r) => setTimeout(r, st.applyDelayMs)).then(done) : done();
  }
  return null;
}
