// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canRenderEarly, clearHint, clearReloadFlag, earlyProfile, gateHref, hintOf, kidsAllowed, kidsRedirect, markPicked, needsProfileGate, needsWelcome, parseHint, readActive, readHint, readPicked, readReloading, safeNext, welcomeHref, writeHint } from './gate';

describe('needsProfileGate', () => {
  const multi = { profileCount: 3, profileChosen: true };
  it('single-profile accounts are never gated', () => {
    expect(needsProfileGate({ profileCount: 1, profileChosen: true }, '/', false)).toBe(false);
    expect(needsProfileGate({ profileCount: 0 }, '/', false)).toBe(false);
  });
  it('server says no profile chosen: gate everywhere but /profiles', () => {
    expect(needsProfileGate({ profileRequired: true }, '/watch/x', true)).toBe(true);
    expect(needsProfileGate({ profileCount: 2, profileChosen: false }, '/remote', true)).toBe(true);
    expect(needsProfileGate({ profileRequired: true }, '/profiles', false)).toBe(false);
  });
  it('several profiles: once per browser session', () => {
    expect(needsProfileGate(multi, '/', false)).toBe(true);
    expect(needsProfileGate(multi, '/watch/abc', false)).toBe(true); // deep links continue via ?next=
    expect(needsProfileGate(multi, '/', true)).toBe(false);
  });
  it('no session gate on televisions and the remote control', () => {
    expect(needsProfileGate({ ...multi, tv: true }, '/', false)).toBe(false);
    expect(needsProfileGate(multi, '/remote', false)).toBe(false);
    expect(needsProfileGate(multi, '/remote/x', false)).toBe(false);
    expect(needsProfileGate(multi, '/remotely', false)).toBe(true);
  });
});

describe('kids profiles', () => {
  it('only kids routes are allowed; everything else goes to the kids home', () => {
    for (const p of ['/kids', '/kids/search', '/item/abc', '/watch/abc', '/search', '/profiles', '/offline', '/settings', '/welcome']) expect(kidsAllowed(p), p).toBe(true);
    for (const p of ['/', '/party', '/party/x', '/lists', '/lists/1', '/requests', '/stats', '/digest', '/admin', '/admin/users', '/me', '/watchlist', '/match', '/vote', '/kidsx', '/settingsx', '/settings/devices', '/browse/movies'])
      expect(kidsAllowed(p), p).toBe(false);
    expect(kidsRedirect({ kids: true }, '/')).toBe('/kids');
    expect(kidsRedirect({ kids: true }, '/party/abc')).toBe('/kids');
    expect(kidsRedirect({ kids: true }, '/watch/abc')).toBeNull();
    expect(kidsRedirect({ kids: false }, '/party/abc')).toBeNull();
    expect(kidsRedirect(null, '/admin')).toBeNull();
  });
  it('a kids hint never renders a grown-up page early', () => {
    const h = hintOf({ deviceApproved: true, profileCount: 2, kids: true });
    expect(h.kids).toBe(true);
    expect(parseHint(JSON.stringify(h))).toEqual(h);
    expect(canRenderEarly(h, true, '/')).toBe(false);
    expect(canRenderEarly(h, true, '/lists')).toBe(false);
    expect(canRenderEarly(h, true, '/kids')).toBe(true);
    expect(parseHint(JSON.stringify({ ...h, kids: 'yes' }))?.kids).toBeUndefined();
  });
  it('the hint remembers a missing request service (only an explicit false)', () => {
    const h = hintOf({ deviceApproved: true, profileCount: 1, features: { requests: false } });
    expect(h.noRequests).toBe(true);
    expect(parseHint(JSON.stringify(h))).toEqual(h);
    expect(hintOf({ deviceApproved: true, profileCount: 1, features: { requests: true } }).noRequests).toBeUndefined();
    expect(hintOf({ deviceApproved: true, profileCount: 1 }).noRequests).toBeUndefined();
    expect(parseHint(JSON.stringify({ ...h, noRequests: 'yes' }))?.noRequests).toBeUndefined();
  });
});

describe('onboarding (/welcome)', () => {
  it('only profiles the server marks as not onboarded, never on the welcome/picker/public pages or TVs', () => {
    expect(needsWelcome({ onboarded: false }, '/')).toBe(true);
    expect(needsWelcome({ onboarded: false }, '/item/x')).toBe(true);
    expect(needsWelcome({ onboarded: true }, '/')).toBe(false);
    expect(needsWelcome({}, '/')).toBe(false); // older server
    expect(needsWelcome(null, '/')).toBe(false);
    for (const p of ['/welcome', '/profiles', '/offline', '/invite/x', '/tv', '/remote', '/setup', '/setup/extras']) expect(needsWelcome({ onboarded: false }, p), p).toBe(false);
    expect(needsWelcome({ onboarded: false, tv: true }, '/')).toBe(false);
  });
  it('continues where the person wanted to go (kids: on the kids home)', () => {
    expect(welcomeHref('/watch/1?t=3')).toBe('/welcome?next=%2Fwatch%2F1%3Ft%3D3');
    expect(welcomeHref('/', true)).toBe('/welcome?next=%2Fkids');
    expect(welcomeHref('/item/1', true)).toBe('/welcome?next=%2Fitem%2F1');
  });
  it('safeNext keeps same-origin paths only', () => {
    expect(safeNext('/kids')).toBe('/kids');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/\\evil')).toBe('/');
    expect(safeNext(null, '/kids')).toBe('/kids');
  });
  it('a hint that still owes the onboarding renders nothing early', () => {
    const h = hintOf({ deviceApproved: true, profileCount: 1, profile: { id: 'p1' }, onboarded: false });
    expect(h.welcome).toBe(true);
    expect(parseHint(JSON.stringify(h))).toEqual(h);
    expect(canRenderEarly(h, false, '/')).toBe(false);
    expect(hintOf({ deviceApproved: true, profileCount: 1, onboarded: true }).welcome).toBeUndefined();
  });
});

describe('boot hint', () => {
  it('round-trips and rejects junk', () => {
    const h = hintOf({ deviceApproved: true, profileCount: 2, tv: false });
    expect(h).toEqual({ approved: true, multi: true, tv: false });
    expect(parseHint(JSON.stringify(h))).toEqual(h);
    expect(parseHint('{"approved":1}')).toBeNull();
    expect(parseHint('nope')).toBeNull();
    expect(parseHint(null)).toBeNull();
  });
  it('carries the UI language of the last answer (an early-rendered page waits for it)', () => {
    const h = hintOf({ deviceApproved: true, profileCount: 1, profile: { id: 'p1' }, language: 'en' });
    expect(h.lang).toBe('en');
    expect(parseHint(JSON.stringify(h))).toEqual(h);
    expect(parseHint(JSON.stringify({ ...h, lang: '<script>' }))?.lang).toBeUndefined();
  });
  it('renders early only when nothing has to happen first', () => {
    const ok = { approved: true, multi: false, tv: false };
    expect(canRenderEarly(ok, false, '/')).toBe(true);
    expect(canRenderEarly(null, true, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, approved: false }, true, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, tv: true }, true, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, multi: true }, false, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, multi: true }, true, '/')).toBe(true);
    expect(canRenderEarly(ok, true, '/profiles')).toBe(false);
    expect(canRenderEarly(ok, true, '/', null)).toBe(false); // profile of this tab unknown
    expect(canRenderEarly(ok, true, '/', 'p1', true)).toBe(false); // reloading after a profile switch elsewhere
  });
  it('early profile: the tab\'s own, else the only profile of the account', () => {
    const single = hintOf({ deviceApproved: true, profileCount: 1, profile: { id: 'p1' } });
    expect(single.profile).toBe('p1');
    expect(parseHint(JSON.stringify(single))).toEqual(single);
    expect(earlyProfile(single, null)).toBe('p1');
    expect(earlyProfile(single, 'p9')).toBe('p9');
    const multi = hintOf({ deviceApproved: true, profileCount: 3, profile: { id: 'p1' } });
    expect(multi.profile).toBeUndefined(); // several profiles: never guessed
    expect(earlyProfile(multi, null)).toBeNull();
  });
  it('gate link keeps the deep link', () => {
    expect(gateHref('/watch/1?t=30')).toBe('/profiles?next=%2Fwatch%2F1%3Ft%3D30');
  });
});

describe('hint lifetime (storage)', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), m }; };
  afterEach(() => vi.unstubAllGlobals());
  it('clearReloadFlag ends the profile-switch reload guard; clearHint drops hint, pick and tab profile', () => {
    const ls = store(), ss = store();
    vi.stubGlobal('localStorage', ls); vi.stubGlobal('sessionStorage', ss);
    ss.setItem('ff_profile_reload', '1');
    expect(readReloading()).toBe(true);
    clearReloadFlag();
    expect(readReloading()).toBe(false);
    writeHint({ approved: true, multi: false, tv: false, profile: 'p1' }); markPicked('p1');
    expect(readHint()?.profile).toBe('p1');
    clearHint();
    expect(readHint()).toBeNull();
    expect(readPicked()).toBe(false);
    expect(readActive()).toBeNull();
  });
  it('api() clears the hint when the session is gone (401) before redirecting to the login', async () => {
    const ls = store(), ss = store();
    vi.stubGlobal('localStorage', ls); vi.stubGlobal('sessionStorage', ss);
    const loc = { pathname: '/', href: '' };
    vi.stubGlobal('location', loc);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
    writeHint({ approved: true, multi: false, tv: false, profile: 'p1' });
    const { api } = await import('./api');
    void api('/api/library/resume'); // never settles: the page navigates away
    await new Promise((r) => setTimeout(r, 0));
    expect(readHint()).toBeNull();
    expect(loc.href).toBe('/auth/login');
  });
});
