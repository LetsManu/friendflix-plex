import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api', () => ({ api: vi.fn() }));
vi.mock('#lib/kids', async () => { const { writable } = await import('svelte/store'); return { kidsMode: writable(false) }; });
const { setAppBadge, unreadCount, syncBadge } = await import('./badge');
const { api } = await import('#lib/api');
const { kidsMode } = await import('#lib/kids');
const { updateBadge } = await import('./sw/push');

describe('app badge', () => {
  it('sets, clamps and clears through the Badging API', async () => {
    const nav = { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn().mockResolvedValue(undefined) };
    expect(await setAppBadge(3, nav)).toBe(true);
    expect(nav.setAppBadge).toHaveBeenLastCalledWith(3);
    await setAppBadge(250, nav);
    expect(nav.setAppBadge).toHaveBeenLastCalledWith(99);
    expect(await setAppBadge(0, nav)).toBe(true);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
    await setAppBadge(Number.NaN, nav);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(2);
  });
  it('is a quiet no-op where unsupported or when the browser refuses', async () => {
    expect(await setAppBadge(2, {})).toBe(false);
    expect(await setAppBadge(2, undefined)).toBe(false);
    expect(await setAppBadge(2, { setAppBadge: () => Promise.reject(new Error('denied')) })).toBe(false);
  });
  it('counts unread notifications', () => {
    expect(unreadCount([{ read: false }, { read: true }, {}])).toBe(2);
    expect(unreadCount(undefined)).toBe(0);
  });
  it('service worker: badge = notifications still showing', async () => {
    const setB = vi.fn().mockResolvedValue(undefined), clearB = vi.fn().mockResolvedValue(undefined);
    const mk = (n: number) => ({ registration: { showNotification: vi.fn(), getNotifications: async () => new Array(n).fill({}) }, navigator: { setAppBadge: setB, clearAppBadge: clearB } });
    await updateBadge(mk(2)); expect(setB).toHaveBeenCalledWith(2);
    await updateBadge(mk(0)); expect(clearB).toHaveBeenCalledTimes(1);
    await expect(updateBadge({ registration: { showNotification: vi.fn() } })).resolves.toBeUndefined(); // no Badging API
  });
  it('kids profiles never ask for notifications', async () => {
    kidsMode.set(true);
    vi.mocked(api).mockClear();
    await syncBadge();
    expect(api).not.toHaveBeenCalled();
    kidsMode.set(false);
  });
});
