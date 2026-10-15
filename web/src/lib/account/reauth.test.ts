// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api';
import { isReauthError, reauthHref, startReauth } from './reauth';

const loc = (pathname: string) => ({ pathname, href: '' });
const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('reauth helpers', () => {
  it('builds the /auth/reauth URL with an encoded next', () => {
    expect(reauthHref('/me/account?delete=1')).toBe('/auth/reauth?next=%2Fme%2Faccount%3Fdelete%3D1');
    const l = loc('/me/account');
    vi.stubGlobal('location', l);
    startReauth('/me/account');
    expect(l.href).toBe('/auth/reauth?next=%2Fme%2Faccount');
  });

  it('recognises only the 401 reauth_required answer', () => {
    expect(isReauthError(new ApiError(401, { error: 'reauth_required' }))).toBe(true);
    expect(isReauthError(new ApiError(401, { error: 'unauthenticated' }))).toBe(false);
    expect(isReauthError(new ApiError(403, { error: 'reauth_required' }))).toBe(false);
    expect(isReauthError(new ApiError(401, null))).toBe(false);
    expect(isReauthError(new Error('reauth_required'))).toBe(false);
  });
});

describe('api() and 401', () => {
  it('reauth_required rejects with an ApiError and stays on the page (F4)', async () => {
    const l = loc('/me/account');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"reauth_required"}'));
    const e = await api('/api/account/delete', { method: 'POST', body: { confirm: true } }).catch((x: unknown) => x);
    expect(isReauthError(e)).toBe(true);
    expect(l.href).toBe('');
  });

  it('any other 401 still goes to the sign-in, also with a body that is not JSON', async () => {
    for (const body of ['{"error":"unauthenticated"}', '<html>proxy</html>', '']) {
      const l = loc('/me/account');
      vi.stubGlobal('location', l);
      vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => undefined });
      vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: () => undefined });
      vi.stubGlobal('fetch', answer(401, body));
      const settled = await Promise.race([api('/api/account').then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
      expect(settled).toBe('pending'); // the redirect never resolves
      expect(l.href).toBe('/auth/login');
    }
  });
});

describe('api() and 401 on public pages (preflight D8)', () => {
  it('the e-mail confirmation page /confirm-email works without a session: a 401 is not sent to /auth/login', async () => {
    const l = loc('/confirm-email');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}'));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(l.href).toBe('');
  });

  it('the in-app sign-in /login keeps a 401 to itself: no redirect to /auth/login (which would come back to /login)', async () => {
    const l = loc('/login');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}'));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(401);
    expect(l.href).toBe('');
  });

  it('the reset-link page /reset keeps a 401 to itself too', async () => {
    const l = loc('/reset');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}'));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(l.href).toBe('');
  });
});
