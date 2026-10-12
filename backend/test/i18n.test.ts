import { afterEach, describe, expect, it } from 'vitest';
import { languageFromAcceptLanguage } from '../src/i18n.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { await env?.close(); });

const call = (s: Sess, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, ...headers }, payload: body as object });
const sessOf = (r: { cookies: Array<{ name: string; value: string }> }, prev: Sess): Sess => ({ cookies: { ff_sid: r.cookies.find((c) => c.name === 'ff_sid')?.value ?? prev.cookies.ff_sid! }, csrf: prev.csrf });
const me = async (s: Sess, headers: Record<string, string> = {}) => (await call(s, 'GET', '/api/me', undefined, headers)).json();

/** second (invited) account logged in on the same fake IdP */
async function invitedLogin(admin: Sess, sub: string): Promise<Sess> {
  const token = (await call(admin, 'POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
  env.claims.current = { sub, email: `${sub}@example.com`, name: sub, groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  return { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
}

describe('i18n helpers', () => {
  it('picks the best supported language from Accept-Language', () => {
    expect(languageFromAcceptLanguage('en-US,en;q=0.9,de;q=0.8')).toBe('en');
    expect(languageFromAcceptLanguage('ja,pl;q=0.5,fr;q=0.7')).toBe('fr');
    expect(languageFromAcceptLanguage('tr-TR')).toBe('tr');
    expect(languageFromAcceptLanguage('ja, zh;q=0.8')).toBeNull();
    expect(languageFromAcceptLanguage('de;q=0, it')).toBe('it');
    expect(languageFromAcceptLanguage(undefined)).toBeNull();
    expect(languageFromAcceptLanguage('')).toBeNull();
  });
});

describe('UI language', () => {
  it('/api/me: defaults, instance default by the admin (audited), non-admins are refused', async () => {
    env = await makeEnv();
    const admin = await env.login();
    let m = await me(admin, { 'accept-language': 'fr-CH,fr;q=0.9,en;q=0.5' });
    expect(m).toMatchObject({ language: 'de', languageChosen: false, defaultLanguage: 'de', defaultLanguageSet: false, suggestedLanguage: 'fr' });
    expect((await me(admin)).suggestedLanguage).toBeNull();

    expect((await call(admin, 'GET', '/api/admin/settings/language')).json()).toMatchObject({ language: 'de', set: false });
    expect((await call(admin, 'PUT', '/api/admin/settings/language', { language: 'xx' })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/settings/language', { language: 'en' }, { 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    const put = await call(admin, 'PUT', '/api/admin/settings/language', { language: 'en' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ language: 'en', set: true });
    await call(admin, 'PUT', '/api/admin/settings/language', { language: 'en' }); // unchanged: no second audit entry
    expect((await env.pool.query("select meta from audit_log where action='settings.language'")).rows.map((r) => r.meta)).toEqual([{ from: null, to: 'en' }]);
    m = await me(admin);
    expect(m).toMatchObject({ language: 'en', languageChosen: false, defaultLanguage: 'en', defaultLanguageSet: true });

    const friend = await invitedLogin(admin, 'f1');
    expect((await me(friend)).language).toBe('en'); // instance default applies to everybody without an own choice
    expect((await call(friend, 'PUT', '/api/admin/settings/language', { language: 'de' })).statusCode).toBe(403);
    expect((await call(friend, 'GET', '/api/admin/settings/language')).statusCode).toBe(403);
  });

  it('per profile: PUT /api/prefs/language, prefs enum, full prefs PUT keeps the language when the field is missing', async () => {
    env = await makeEnv();
    const owner = await env.login();
    expect((await call(owner, 'PUT', '/api/prefs/language', { language: 'klingon' })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/api/prefs/language', {})).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/api/prefs/language', { language: 'pl' })).json()).toEqual({ language: 'pl' });
    expect(await me(owner)).toMatchObject({ language: 'pl', languageChosen: true, defaultLanguageSet: false });

    // the full prefs object carries the language too (validated against the supported codes)
    const base = (await call(owner, 'GET', '/api/prefs')).json().prefs;
    expect(base.language).toBe('pl');
    expect((await call(owner, 'PUT', '/api/prefs', { ...base, language: 'xx' })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/api/prefs', { ...base, language: 'it' })).json().prefs.language).toBe('it');
    const { language: _drop, ...old } = base;
    const r = await call(owner, 'PUT', '/api/prefs', { ...old, autoplayNext: false }); // an older tab without `language`
    expect(r.json().prefs).toMatchObject({ autoplayNext: false, language: 'it' });
    expect((await me(owner)).language).toBe('it');
    // '' (a form loaded before any choice) must not clear a language chosen elsewhere meanwhile
    expect((await call(owner, 'PUT', '/api/prefs', { ...old, autoplayNext: false, language: '' })).json().prefs.language).toBe('it');
    expect(await me(owner)).toMatchObject({ language: 'it', languageChosen: true });
    // other viewing prefs survive the language-only route
    await call(owner, 'PUT', '/api/prefs/language', { language: 'es' });
    expect((await call(owner, 'GET', '/api/prefs')).json().prefs).toMatchObject({ autoplayNext: false, language: 'es' });

    // a second profile has its own (unset) language
    const p = await call(owner, 'POST', '/api/profiles', { name: 'Kind' });
    expect(p.statusCode).toBe(201);
    const sel = await call(owner, 'POST', `/api/profiles/${p.json().profile.id}/select`, {});
    expect(sel.statusCode).toBe(200);
    const kid = sessOf(sel, owner);
    expect(await me(kid)).toMatchObject({ language: 'de', languageChosen: false });
    await call(kid, 'PUT', '/api/prefs/language', { language: 'tr' });
    expect((await me(kid)).language).toBe('tr');
    const back = await call(kid, 'POST', `/api/profiles/${(await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id}/select`, {});
    expect((await me(sessOf(back, kid))).language).toBe('es');
  });
});
