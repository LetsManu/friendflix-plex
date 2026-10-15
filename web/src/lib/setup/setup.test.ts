// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { describeActivity } from '#lib/admin/activity';
import {
  akApply, akPlan, APPLY_TIMEOUT_MS, CSRF_HEADER, firstOpenStep, isPlainHttp, mediaAuto, readCookie, redirectUri, saveSetup, setupState, testSetup, unlock,
} from './api';
import { akFailText, errorText, failedStep, failure, filled, isSecretKey, otherFieldErrors, probeText } from './messages';

const LOCALES = ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr'] as const;

afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await setLocale('de'); });

describe('setup API', () => {
  const res = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  function stub(answer: () => unknown = () => res(200, { ok: true })) {
    const fetch = vi.fn(async (..._a: unknown[]) => answer());
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', { cookie: 'ff_session=x; ff_setup_csrf=tok%2B1; other=y' });
    return fetch;
  }
  const init = (f: ReturnType<typeof stub>, i = 0) => f.mock.calls[i]![1] as RequestInit & { headers: Record<string, string> };

  it('calls the routes with the documented bodies; writes carry x-ff-setup-csrf from the cookie, reads do not', async () => {
    const f = stub();
    await setupState();
    await unlock('k7qm-3xa9-pt2d');
    await saveSetup({ PUBLIC_URL: 'https://tv.example.com' });
    await saveSetup({ JELLYFIN_URL: 'http://jellyfin:8096' }, true);
    await testSetup('media', { JELLYFIN_URL: 'http://jellyfin:8096' });
    await testSetup('general');
    await mediaAuto({ url: 'http://jellyfin:8096', username: 'admin', password: 'pw' });
    await akPlan({ url: 'https://auth.example.com', token: 't' });
    await akApply({ url: 'https://auth.example.com', token: 't', addMeToAdmins: false });
    const seen = f.mock.calls.map(([url, i]) => [url, (i as RequestInit).method, (i as RequestInit).body ? JSON.parse((i as { body: string }).body) : undefined]);
    expect(seen).toEqual([
      ['/api/setup/state', 'GET', undefined],
      ['/api/setup/unlock', 'POST', { code: 'k7qm-3xa9-pt2d' }],
      ['/api/setup/settings', 'PUT', { values: { PUBLIC_URL: 'https://tv.example.com' } }],
      ['/api/setup/settings', 'PUT', { values: { JELLYFIN_URL: 'http://jellyfin:8096' }, force: true }],
      ['/api/setup/test', 'POST', { group: 'media', values: { JELLYFIN_URL: 'http://jellyfin:8096' } }],
      ['/api/setup/test', 'POST', { group: 'general' }],
      ['/api/setup/media/auto', 'POST', { url: 'http://jellyfin:8096', username: 'admin', password: 'pw' }],
      ['/api/setup/authentik/plan', 'POST', { url: 'https://auth.example.com', token: 't' }],
      ['/api/setup/authentik/apply', 'POST', { url: 'https://auth.example.com', token: 't', addMeToAdmins: false }],
    ]);
    expect(init(f, 0).headers[CSRF_HEADER]).toBeUndefined();
    for (let i = 1; i < f.mock.calls.length; i++) expect(init(f, i).headers[CSRF_HEADER]).toBe('tok+1');
    expect(init(f, 1).credentials).toBe('same-origin');
    expect(init(f, 1).headers['content-type']).toBe('application/json');
    expect(APPLY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000); // an apply takes ~30 s, a busy Authentik much longer
  });

  it('a refusal is an ApiError with the body; an unreadable body is {}; network and timeout are status 0', async () => {
    stub(() => res(401, { error: 'wrong_code' }));
    await expect(unlock('x')).rejects.toMatchObject({ status: 401, body: { error: 'wrong_code' } });
    stub(() => res(502, '<html>bad gateway</html>'));
    await expect(setupState()).rejects.toMatchObject({ status: 502, body: {} });
    stub(() => res(200, ''));
    await expect(setupState()).resolves.toBeNull();
    stub(() => { throw new TypeError('Failed to fetch'); });
    await expect(setupState()).rejects.toMatchObject({ status: 0, body: { error: 'network' } });
    stub(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    await expect(akApply({ url: 'u', token: 't', addMeToAdmins: true })).rejects.toMatchObject({ status: 0, body: { error: 'timeout' } });
    stub(() => res(200, { text: 'x' }));
    const broken = { status: 200, ok: true, text: async () => { throw new Error('reset'); } };
    vi.stubGlobal('fetch', vi.fn(async () => broken));
    await expect(setupState()).resolves.toBeNull();
  });

  it('reads cookies: missing, plain, encoded, malformed', () => {
    expect(readCookie('ff_setup_csrf', '')).toBe('');
    expect(readCookie('ff_setup_csrf', 'a=1; ff_setup_csrf=abc')).toBe('abc');
    expect(readCookie('ff_setup_csrf', 'ff_setup_csrf=a%2Fb')).toBe('a/b');
    expect(readCookie('ff_setup_csrf', 'ff_setup_csrf=%E0%A4%A')).toBe('%E0%A4%A');
    expect(readCookie('ff_setup_csrf', 'novalue; xff_setup_csrf=1')).toBe('');
    vi.stubGlobal('document', undefined);
    expect(readCookie('ff_setup_csrf')).toBe('');
  });

  it('starts on the first step that needs something; helpers for http and the redirect URI', () => {
    const st = (publicUrl: string, media: string, signin: string) => ({ steps: { publicUrl, media, signin, admin: 'todo' } }) as Parameters<typeof firstOpenStep>[0];
    expect(firstOpenStep(st('todo', 'todo', 'todo'))).toBe(2);
    expect(firstOpenStep(st('env', 'todo', 'todo'))).toBe(3);
    expect(firstOpenStep(st('done', 'env', 'todo'))).toBe(4);
    expect(firstOpenStep(st('done', 'done', 'env'))).toBe(5);
    expect(isPlainHttp(' HTTP://auth.example.com')).toBe(true);
    expect(isPlainHttp('https://auth.example.com')).toBe(false);
    expect(redirectUri('https://tv.example.com/')).toBe('https://tv.example.com/auth/callback');
    expect(redirectUri(' https://tv.example.com ')).toBe('https://tv.example.com/auth/callback');
  });
});

describe('setup messages', () => {
  it('maps every refusal: session, complete, rate limit, probe (soft or hard), fields, probe-shaped refusals, codes, unknown', () => {
    expect(failure(new ApiError(409, { error: 'setup_complete' }))).toEqual({ kind: 'complete' });
    expect(failure(new ApiError(401, { error: 'setup_session_required' }))).toEqual({ kind: 'session' });
    expect(failure(new ApiError(401, null))).toEqual({ kind: 'session' });
    expect(failure(new ApiError(403, { error: 'csrf' }))).toEqual({ kind: 'session' });
    expect(failure(new ApiError(401, { error: 'wrong_code' }))).toEqual({ kind: 'message', text: tr('setup.errors.wrong_code') });
    expect(failure(new ApiError(429, { statusCode: 429, error: 'Too Many Requests' }))).toEqual({ kind: 'message', text: tr('setup.errors.rate_limited') });
    expect(failure(new ApiError(409, { error: 'busy' }))).toEqual({ kind: 'message', text: tr('setup.errors.busy') });
    const steps = [{ id: 'check', state: 'ok' }];
    expect(failure(new ApiError(400, { error: 'probe_failed', group: 'media', probe: { ok: false, code: 'unreachable' }, steps }))).toMatchObject({ kind: 'message', soft: true, steps, probe: { code: 'unreachable' } });
    expect(failure(new ApiError(400, { error: 'probe_failed', probe: { ok: false, code: 'not_admin' } }))).toMatchObject({ soft: false, text: tr('setup.probe.not_admin') });
    expect(failure(new ApiError(400, { error: 'invalid_settings', errors: { PUBLIC_URL: 'origin_only' } }))).toEqual({ kind: 'message', text: tr('setup.errors.invalid_settings'), fields: { PUBLIC_URL: 'origin_only' } });
    expect(failure(new ApiError(400, { ok: false, code: 'invalid', detail: 'env_locked' }))).toMatchObject({ probe: { code: 'invalid', detail: 'env_locked' }, text: `${tr('settings.probe.invalid')} ${tr('setup.probeDetail.env_locked')}` });
    expect(failure(new ApiError(400, { ok: false, code: 'invalid', detail: '<b>' }))).toMatchObject({ probe: { code: 'invalid' }, text: tr('settings.probe.invalid') });
    expect(failure(new ApiError(400, { error: 'not_allowed' }))).toEqual({ kind: 'message', text: tr('setup.errors.not_allowed') });
    expect(failure(new ApiError(0, { error: 'network' })).kind).toBe('message');
    expect(failure(new ApiError(500, 'oops'))).toEqual({ kind: 'message', text: tr('setup.errors.unknown', { status: '500' }) });
    expect(failure(new ApiError(500, { error: 'Some Text' }))).toEqual({ kind: 'message', text: tr('setup.errors.unknown', { status: '500' }) });
    expect(failure(new Error('x'))).toEqual({ kind: 'message', text: tr('setup.errors.unknown', { status: '0' }) });
  });

  it('probe texts: the wizard wording first, then Admin → Settings, then a generic one; details likewise', () => {
    expect(probeText({ ok: false, code: 'wizard_pending' })).toBe(tr('setup.probe.wizard_pending'));
    expect(probeText({ ok: false, code: 'timeout' })).toBe(tr('settings.probe.timeout'));
    expect(probeText({ ok: false, code: 'unreachable', detail: 'timeout' })).toBe(`${tr('settings.probe.unreachable')} ${tr('setup.probeDetail.timeout')}`);
    expect(probeText({ ok: true, code: 'warning', detail: 'echo_mismatch' })).toBe(`${tr('setup.probe.warning')} ${tr('setup.probeDetail.echo_mismatch')}`);
    expect(probeText({ ok: false, code: 'invalid', detail: 'redirect' })).toBe(`${tr('settings.probe.invalid')} ${tr('settings.probeDetail.redirect')}`);
    expect(probeText({ ok: false, code: 'nope' as never, detail: 'nope' })).toBe(tr('settings.probe.invalid'));
    expect(probeText({ ok: false, code: 'unexpected' as never })).toBe(tr('setup.probe.unexpected'));
  });

  it('Authentik step failures, the failed step, error codes and form helpers', () => {
    expect(akFailText('blueprint_invalid')).toMatch(/in ein paar Minuten/);
    expect(akFailText('whatever')).toBe(tr('setup.ak.fail.unexpected'));
    expect(akFailText(undefined)).toBe(tr('setup.ak.fail.unexpected'));
    expect(failedStep([{ id: 'check', state: 'ok' }, { id: 'groups', state: 'failed', detail: 'unreachable' }])).toEqual({ id: 'groups', state: 'failed', detail: 'unreachable' });
    expect(failedStep([{ id: 'check', state: 'ok' }])).toBeNull();
    expect(errorText('no_code')).toMatch(/BACKGROUND_JOBS=true/);
    expect(errorText('x-y', 418)).toBe(tr('setup.errors.unknown', { status: '418' }));
    expect(filled({ A: ' x ', B: '', C: '  ' })).toEqual({ A: 'x' });
    expect(otherFieldErrors({ JELLYFIN_URL: 'invalid_url', ADMIN_GROUP: 'locked' }, ['JELLYFIN_URL'])).toEqual([`${tr('settings.keys.ADMIN_GROUP.label')}: ${tr('settings.errors.locked')}`]);
    expect(otherFieldErrors(undefined, [])).toEqual([]);
    expect(['JELLYFIN_ADMIN_API_KEY', 'OIDC_CLIENT_SECRET', 'AUTHENTIK_API_TOKEN'].every(isSecretKey)).toBe(true);
    expect(['JELLYFIN_URL', 'OIDC_CLIENT_ID', 'ADMIN_GROUP', 'AUTHENTIK_ENROLL_FLOW'].some(isSecretKey)).toBe(false);
  });

  it('every code the backend answers has a sentence in every language; the request service is never named after a product', async () => {
    const errors = ['wrong_code', 'code_expired', 'code_locked', 'no_code', 'setup_session_required', 'csrf', 'setup_complete', 'busy', 'not_allowed', 'not_supported',
      'invalid_settings', 'rate_limited', 'network', 'timeout', 'no_probe', 'bad_request'];
    const ak = ['unauthorized', 'not_superuser', 'unsupported_version', 'blueprint_invalid', 'unreachable', 'unexpected', 'issuer_mismatch', 'invalid_url'];
    // probe codes and details of settings/probes.ts, the media server's automatic key and the setup routes
    const probe = ['ok', 'unreachable', 'timeout', 'unauthorized', 'invalid', 'not_admin', 'issuer_mismatch', 'wizard_pending', 'unexpected', 'warning'];
    const details = ['echo_mismatch', 'insecure', 'not_tested', 'timeout', 'env_locked', 'env_key_locked', 'public_url_missing', 'invalid_url', 'redirect', 'not_found', 'upstream_error',
      'bad_response', 'incomplete', 'insecure_issuer', 'enroll_flow_missing', 'not_set', 'rate_limited'];
    for (const c of errors) expect(hasKey(`setup.errors.${c}`), c).toBe(true);
    for (const c of ak) expect(hasKey(`setup.ak.fail.${c}`), c).toBe(true);
    for (const c of probe) expect(hasKey(`setup.probe.${c}`) || hasKey(`settings.probe.${c}`), c).toBe(true);
    for (const c of details) expect(hasKey(`setup.probeDetail.${c}`) || hasKey(`settings.probeDetail.${c}`), c).toBe(true);
    for (const l of LOCALES) {
      const dict = (await import(`../i18n/locales/${l}/setup.ts`)).default as object;
      expect(JSON.stringify(dict), l).not.toMatch(/seerr/i);
      await setLocale(l);
      expect(errorText('no_code'), l).toMatch(/BACKGROUND_JOBS=true/);
      expect(akFailText('blueprint_invalid'), l).not.toBe(akFailText('unexpected'));
    }
  });

  it('the audit log shows the completed setup (D21) in every language', async () => {
    for (const l of LOCALES) {
      await setLocale(l);
      const d = describeActivity({ id: 1, at: '', action: 'setup.completed', target: null, actor: 'Anna' });
      expect(d.icon, l).toBe('check');
      expect(d.text, l).toContain('Anna');
      expect(d.text, l).toBe(tr('admin.activity.setup.completed', { actor: 'Anna' }));
    }
  });
});
