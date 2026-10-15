// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-app sign-in fixtures (shapes follow backend/src/routes/authFlow.ts and flowSteps.ts). A scripted step sequence: every start and
 * every answer takes the next reply of its list. Like the backend, every POST must carry x-ff-flow-csrf equal to the ff_flow_csrf
 * cookie that GET /auth/flow/config sets (else 403 csrf), and the cover wall is GET /api/public/login-art (mocks/api.ts).
 * Fake values only: no real host, token or credential.
 */
import type { BrowserContext, Route } from '@playwright/test';

export type MockReply = { status?: number; body: unknown };
export interface FlowCall { path: string; body: any; csrf: string | null; csrfCookie: string | null }
export interface LoginMock {
  /** GET /auth/flow/config */
  config: MockReply;
  /** replies to POST /auth/flow/start, in order (the last one repeats) */
  starts: Array<MockReply | ((body: any) => MockReply)>;
  /** replies to POST /auth/flow/resume (/reset and /confirm-email), in order (the last one repeats) */
  resumes: Array<MockReply | ((body: any) => MockReply)>;
  /** replies to POST /auth/flow/answer, in order (the last one repeats) */
  answers: Array<MockReply | ((body: any) => MockReply)>;
  /** every POST, with the csrf header and cookie it carried */
  calls: FlowCall[];
  /** the value the next config sets as ff_flow_csrf */
  csrf: string;
}

export const MOCK_CSRF = 'mock-flow-csrf-0001';
export const ART_SET = 'mockartset01';
/** 36 cover paths like the backend's (`/api/public/login-art/<set>/<i>`) */
export const ART_IMAGES = Array.from({ length: 36 }, (_, i) => `/api/public/login-art/${ART_SET}/${i}`);

export function loginState(over: Partial<LoginMock> = {}): LoginMock {
  return { config: { body: { mode: 'app', recovery: true, enroll: false } }, starts: [{ body: identify() }], resumes: [{ body: { stage: 'expired' } }], answers: [], calls: [], csrf: MOCK_CSRF, ...over };
}

// ---- step builders (FlowStep, flowSteps.ts) ----
let n = 0;
const stepId = () => `mock-step-${String(++n).padStart(4, '0')}`;
export const identify = (over: Record<string, unknown> = {}) => ({ stage: 'identify', step: stepId(), passwordInline: false, canRecover: true, canEnroll: false, passkey: null, ...over });
export const password = (identity = 'anna@example.com', over: Record<string, unknown> = {}) => ({ stage: 'password', step: stepId(), identity, canRecover: true, ...over });
export const mfa = (over: Record<string, unknown> = {}) => ({ stage: 'mfa', step: stepId(), totp: true, recovery: true, passkey: null, passkeyClassic: false, ...over });
export const emailSent = (to: string | null = 'a•••@example.com') => ({ stage: 'email-sent', step: stepId(), to });
export const prompt = (fields: Array<{ key: string; type: string; label: string; required?: boolean }>, over: Record<string, unknown> = {}) =>
  ({ stage: 'prompt', step: stepId(), fields: fields.map((f) => ({ required: true, ...f })), ...over });
export const totpSetup = (secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP') => ({ stage: 'totp-setup', step: stepId(), otpauth: `otpauth://totp/FriendFlix:anna?secret=${secret}&issuer=FriendFlix` });
export const recoveryCodes = (codes: string[] = ['fakecode0001', 'fakecode0002', 'fakecode0003', 'fakecode0004']) => ({ stage: 'recovery-codes', step: stepId(), codes });
export const done = (next = '/') => ({ stage: 'done', next });

const cookieValue = (header: string | undefined, name: string): string | null => {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/** Mocks /auth/flow/* (and the classic /auth/login target) for a browser context. */
export async function installLogin(ctx: BrowserContext, st: LoginMock): Promise<void> {
  await ctx.route('**/auth/login**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>classic</title><h1>Classic sign-in (mock)</h1>' }));
  await ctx.route('**/auth/flow/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const J = (r: MockReply) => route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
    if (p === '/auth/flow/config' && req.method() === 'GET') {
      if ((st.config.status ?? 200) === 200) await ctx.addCookies([{ name: 'ff_flow_csrf', value: st.csrf, url: u.origin, sameSite: 'Strict' }]);
      return J(st.config);
    }
    if (req.method() !== 'POST') return J({ status: 404, body: { error: 'not_found' } });
    const headers = await req.allHeaders();
    let body: any = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { /* keep {} */ }
    const csrf = headers['x-ff-flow-csrf'] ?? null;
    const csrfCookie = cookieValue(headers.cookie, 'ff_flow_csrf');
    st.calls.push({ path: p, body, csrf, csrfCookie });
    if (!csrf || csrf !== csrfCookie) return J({ status: 403, body: { error: 'csrf' } });
    const next = (list: LoginMock['starts']) => {
      const r = list.length > 1 ? list.shift()! : list[0];
      if (!r) return { status: 500, body: { error: 'internal' } };
      return typeof r === 'function' ? r(body) : r;
    };
    if (p === '/auth/flow/start') return J(next(st.starts));
    if (p === '/auth/flow/answer') return J(next(st.answers));
    if (p === '/auth/flow/resume') return J(next(st.resumes));
    if (p === '/auth/flow/cancel') {
      await ctx.clearCookies({ name: 'ff_flow_csrf' });
      return J({ body: { ok: true } });
    }
    return J({ status: 404, body: { error: 'not_found' } });
  });
}
