// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disablePush, enablePush, isIosNonStandalone, pushState, pushSupported, syncPush, testPush, updateBroadcast } from './push';

// Browser push plumbing (service worker registration, PushManager, Notification) is faked; the backend is faked at fetch level.
const KEY_BYTES = new Uint8Array([1, 2, 250, 251, 252, 253]);
const PUBLIC_KEY = 'AQL6-_z9'; // base64url of KEY_BYTES, without padding

let config: { enabled: boolean; publicKey?: string } | 'error';
let calls: Array<{ path: string; method: string; body: any }>;
let subscribeAnswer: { broadcast: boolean } | 'error';
let sub: { endpoint: string; getKey: (k: string) => ArrayBuffer | null; unsubscribe: ReturnType<typeof vi.fn> } | null;
let pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
let permission: NotificationPermission;
let ask: NotificationPermission;
let nav: Record<string, unknown>;
let standaloneMedia = false;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const makeSub = (endpoint = 'https://push.example/abc') => ({
  endpoint,
  getKey: (k: string) => (k === 'p256dh' ? new Uint8Array([251, 255, 0]).buffer : k === 'auth' ? new Uint8Array([1, 2, 3, 4]).buffer : null),
  unsubscribe: vi.fn(async () => true),
});

beforeEach(() => {
  config = { enabled: true, publicKey: PUBLIC_KEY };
  calls = [];
  subscribeAnswer = { broadcast: true };
  sub = null;
  permission = 'default';
  ask = 'granted';
  pushManager = {
    getSubscription: vi.fn(async () => sub),
    subscribe: vi.fn(async () => { sub = makeSub('https://push.example/new'); return sub; }),
  };
  nav = { serviceWorker: { ready: Promise.resolve({ pushManager }) }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', platform: 'Linux', maxTouchPoints: 0 };
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('Notification', { get permission() { return permission; }, requestPermission: vi.fn(async () => ask) });
  vi.stubGlobal('matchMedia', () => ({ matches: standaloneMedia }));
  vi.stubGlobal('location', { pathname: '/account', href: '/account' });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/push/config') return config === 'error' ? json({}, 500) : json(config);
    if (path === '/api/push/subscribe') return subscribeAnswer === 'error' ? json({}, 500) : json(subscribeAnswer);
    if (path === '/api/push/test') return json({ sent: true });
    return json({ ok: true });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  standaloneMedia = false;
});

describe('support detection', () => {
  it('needs a service worker, PushManager and Notification', () => {
    expect(pushSupported()).toBe(true);
    vi.stubGlobal('window', { Notification: class {} });
    expect(pushSupported()).toBe(false);
  });

  it('flags iPhone/iPad Safari outside the home-screen app (push only works installed)', () => {
    expect(isIosNonStandalone()).toBe(false);
    nav.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
    expect(isIosNonStandalone()).toBe(true);
    nav.standalone = true;
    expect(isIosNonStandalone()).toBe(false);
    delete nav.standalone;
    standaloneMedia = true;
    expect(isIosNonStandalone()).toBe(false);
    standaloneMedia = false;
    nav.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    nav.platform = 'MacIntel';
    nav.maxTouchPoints = 5; // iPadOS
    expect(isIosNonStandalone()).toBe(true);
  });
});

describe('pushState', () => {
  it('unsupported browsers: ios-install on iOS Safari, else unsupported', async () => {
    vi.stubGlobal('window', {});
    expect(await pushState()).toBe('unsupported');
    nav.userAgent = 'iPhone';
    expect(await pushState()).toBe('ios-install');
  });

  it('server-off when the server has no VAPID keys or the config request fails', async () => {
    config = { enabled: false };
    expect(await pushState()).toBe('server-off');
    config = 'error';
    expect(await pushState()).toBe('server-off');
  });

  it('denied / off / on from the permission and the current subscription', async () => {
    permission = 'denied';
    expect(await pushState()).toBe('denied');
    permission = 'granted';
    expect(await pushState()).toBe('off');
    sub = makeSub();
    expect(await pushState()).toBe('on');
    pushManager.getSubscription.mockRejectedValueOnce(new Error('InvalidStateError'));
    expect(await pushState()).toBe('off');
  });
});

describe('enablePush', () => {
  it('asks for permission, subscribes with the server key and registers the subscription', async () => {
    expect(await enablePush(true)).toBe('on');
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const opts = pushManager.subscribe.mock.calls[0]![0];
    expect(opts.userVisibleOnly).toBe(true);
    expect([...opts.applicationServerKey]).toEqual([...KEY_BYTES]);
    const reg = calls.find((c) => c.path === '/api/push/subscribe')!;
    expect(reg.method).toBe('POST');
    expect(reg.body).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: '-_8A', auth: 'AQIDBA' }, broadcast: true });
  });

  it('reuses an existing subscription', async () => {
    sub = makeSub();
    expect(await enablePush(false)).toBe('on');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path === '/api/push/subscribe')!.body).toMatchObject({ endpoint: 'https://push.example/abc', broadcast: false });
  });

  it('server-off without a public key; denied or off when the user does not allow notifications', async () => {
    config = { enabled: true };
    expect(await enablePush(true)).toBe('server-off');
    config = { enabled: true, publicKey: PUBLIC_KEY };
    ask = 'denied';
    expect(await enablePush(true)).toBe('denied');
    ask = 'default'; // prompt dismissed
    expect(await enablePush(true)).toBe('off');
    expect(calls.some((c) => c.path === '/api/push/subscribe')).toBe(false);
  });
});

describe('subscription maintenance', () => {
  it('disablePush tells the server and unsubscribes; nothing to do without a subscription', async () => {
    await disablePush();
    expect(calls).toHaveLength(0);
    sub = makeSub();
    const s = sub;
    await disablePush();
    expect(calls).toEqual([{ path: '/api/push/unsubscribe', method: 'POST', body: { endpoint: 'https://push.example/abc' } }]);
    expect(s.unsubscribe).toHaveBeenCalled();
  });

  it('disablePush still unsubscribes locally when the server is unreachable', async () => {
    sub = makeSub();
    const s = sub;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(disablePush()).resolves.toBeUndefined();
    expect(s.unsubscribe).toHaveBeenCalled();
  });

  it('updateBroadcast re-sends the subscription with the new flag; testPush asks the server to send a test', async () => {
    await updateBroadcast(true);
    expect(await testPush()).toEqual({ sent: false });
    expect(calls).toHaveLength(0);
    sub = makeSub();
    await updateBroadcast(false);
    expect(calls[0]!.body).toMatchObject({ endpoint: 'https://push.example/abc', broadcast: false });
    expect(await testPush()).toEqual({ sent: true });
    expect(calls[1]).toEqual({ path: '/api/push/test', method: 'POST', body: { endpoint: 'https://push.example/abc' } });
  });

  it('syncPush re-registers on settings load and returns the broadcast flag; null when it cannot', async () => {
    expect(await syncPush()).toBeNull(); // permission not granted
    permission = 'granted';
    expect(await syncPush()).toBeNull(); // no subscription
    sub = makeSub();
    expect(await syncPush()).toBe(true);
    expect(calls.at(-1)!.body).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: '-_8A', auth: 'AQIDBA' } });
    subscribeAnswer = 'error';
    expect(await syncPush()).toBeNull();
  });
});
