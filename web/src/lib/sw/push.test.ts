// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_URL, META_CACHE, offlineLocale, rememberOfflineLocale } from './locale';
import { installPush, safeLink } from './push';

const ORIGIN = 'https://portal.example';

describe('safeLink', () => {
  it('accepts same-origin relative paths only', () => {
    expect(safeLink('/title/1?x=1#y', ORIGIN)).toBe('/title/1?x=1#y');
    expect(safeLink('//evil.example/x', ORIGIN)).toBeNull();
    expect(safeLink('https://evil.example/x', ORIGIN)).toBeNull();
    expect(safeLink('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(safeLink(42, ORIGIN)).toBeNull();
    expect(safeLink('/x', 'not an origin')).toBeNull();
  });
});

describe('push handlers', () => {
  interface Win { url: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }
  let handlers: Map<string, (e: unknown) => void>;
  let shown: Array<{ title: string; o: Record<string, any> }>;
  let wins: Win[];
  let opened: string[];
  let badge: number | null;
  const scope = () => ({
    location: { origin: ORIGIN },
    registration: { showNotification: async (title: string, o: Record<string, unknown>) => void shown.push({ title, o }), getNotifications: async () => shown },
    navigator: { setAppBadge: async (n?: number) => { badge = n ?? null; }, clearAppBadge: async () => { badge = 0; } },
    clients: { matchAll: async () => wins, openWindow: async (u: string) => void opened.push(u) },
    addEventListener: (t: string, f: (e: unknown) => void) => handlers.set(t, f),
  });
  async function dispatch(type: string, e: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  const push = (data: unknown) => dispatch('push', { data });
  const click = (data: unknown) => { const close = vi.fn(); return dispatch('notificationclick', { notification: { data, close } }).then(() => close); };
  const win = (url: string, nav = true): Win => ({ url, focus: vi.fn(async () => undefined), ...(nav ? { navigate: vi.fn(async () => undefined) } : {}), postMessage: vi.fn() });

  beforeEach(() => {
    handlers = new Map();
    shown = [];
    wins = [];
    opened = [];
    badge = null;
    installPush(scope());
  });

  it('shows the payload as a notification with a safe link and updates the badge', async () => {
    await push({ json: () => ({ title: 'New episode', body: 'S1E2 is here', link: '/title/9', tag: 'ep-9' }) });
    expect(shown).toEqual([{ title: 'New episode', o: { body: 'S1E2 is here', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'ep-9', data: { link: '/title/9' } } }]);
    expect(badge).toBe(1);
  });

  it('falls back to defaults for missing, oversized or unsafe fields', async () => {
    await push({ json: () => ({ title: 'T'.repeat(200), body: 'B'.repeat(400), link: 'https://evil.example/', tag: 5 }) });
    expect(shown[0]!.title).toHaveLength(120);
    expect(shown[0]!.o.body).toHaveLength(300);
    expect(shown[0]!.o).toMatchObject({ tag: undefined, data: { link: '/' } });
    await push(null);
    expect(shown[1]).toMatchObject({ title: 'FriendFlix', o: { body: '' } });
    await push({ json: () => 'just a string' });
    expect(shown[2]!.title).toBe('FriendFlix');
  });

  it('a non-JSON payload is shown as plain text', async () => {
    await push({ json: () => { throw new SyntaxError('bad'); }, text: () => 'plain words' });
    expect(shown[0]).toMatchObject({ title: 'FriendFlix', o: { body: 'plain words' } });
    await push({ json: () => { throw new SyntaxError('bad'); }, text: () => { throw new Error('no'); } });
    expect(shown[1]!.o.body).toBe('');
  });

  it('a click focuses an open FriendFlix window and navigates it to the link', async () => {
    const other = win('https://other.example/');
    const mine = win(`${ORIGIN}/home`);
    wins = [other, mine];
    const close = await click({ link: '/title/9' });
    expect(close).toHaveBeenCalled();
    expect(mine.focus).toHaveBeenCalled();
    expect(mine.navigate).toHaveBeenCalledWith(`${ORIGIN}/title/9`);
    expect(other.focus).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('without navigate (or when it fails) the window gets a message to navigate itself', async () => {
    const w = win(`${ORIGIN}/home`, false);
    wins = [w];
    await click({ link: '/title/1' });
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'ff-nav', link: '/title/1' });
    const broken = win(`${ORIGIN}/home`);
    broken.navigate!.mockRejectedValue(new TypeError('not controlled'));
    wins = [broken];
    await click({ link: '/title/2' });
    expect(broken.postMessage).toHaveBeenCalledWith({ type: 'ff-nav', link: '/title/2' });
  });

  it('opens a new window when none is open; an unsafe link opens the start page', async () => {
    await click({ link: '//evil.example/' });
    expect(opened).toEqual([`${ORIGIN}/`]);
    await click(undefined);
    expect(opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
  });
});

describe('offline UI language', () => {
  let store: Map<string, Map<string, Response>>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('caches', {
      open: async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        const s = store.get(name)!;
        return { put: async (k: string, r: Response) => void s.set(k, r), match: async (k: string) => s.get(k)?.clone() };
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the page remembers the language; the worker reads it back', async () => {
    expect(await offlineLocale()).toBeNull();
    await rememberOfflineLocale('fr');
    expect(store.get(META_CACHE)!.has(LOCALE_URL)).toBe(true);
    expect(await offlineLocale()).toBe('fr');
  });

  it('ignores invalid values and never throws without Cache Storage', async () => {
    await rememberOfflineLocale('<script>');
    expect(await offlineLocale()).toBeNull();
    vi.stubGlobal('caches', undefined);
    await expect(rememberOfflineLocale('en')).resolves.toBeUndefined();
    expect(await offlineLocale()).toBeNull();
    vi.stubGlobal('caches', { open: async () => { throw new Error('SecurityError'); } });
    await expect(rememberOfflineLocale('en')).resolves.toBeUndefined();
  });
});
