// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  downloads: [] as unknown[] | 'error',
  confirmAnswer: false,
  confirmCalls: [] as Array<Record<string, unknown>>,
  removeAll: vi.fn(async () => undefined),
  disablePush: vi.fn(async () => undefined),
  clearHint: vi.fn(),
  cast: null as unknown,
  calls: [] as string[],
  stop: vi.fn(async () => { h.calls.push('cast.stop'); }),
}));
vi.mock('#lib/cast/engine', () => ({
  castEngine: { stop: h.stop },
  castSession: { subscribe: (fn: (v: unknown) => void) => { fn(h.cast); return () => undefined; } },
}));
vi.mock('#lib/offline/db', () => ({ getAllDownloads: async () => { if (h.downloads === 'error') throw new Error('no IndexedDB'); return h.downloads; } }));
vi.mock('#lib/offline/manager', () => ({ removeAll: h.removeAll }));
vi.mock('#lib/ui/confirm', () => ({ confirm: async (o: Record<string, unknown>) => { h.confirmCalls.push(o); return h.confirmAnswer; } }));
vi.mock('#lib/push', () => ({ disablePush: h.disablePush }));
vi.mock('#lib/gate', () => ({ clearHint: h.clearHint }));

const { logout } = await import('./session');

let loc: { pathname: string; href: string };
let logoutStatus: number;
beforeEach(() => {
  h.downloads = [];
  h.confirmAnswer = false;
  h.confirmCalls = [];
  h.removeAll.mockClear();
  h.disablePush.mockReset().mockResolvedValue(undefined);
  h.clearHint.mockClear();
  h.cast = null;
  h.calls = [];
  h.stop.mockClear();
  logoutStatus = 204;
  loc = { pathname: '/account', href: '/account' };
  vi.stubGlobal('location', loc);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { h.calls.push(`POST ${url}`); return new Response(null, { status: logoutStatus }); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('logout', () => {
  it('stops a running cast before the server logout', async () => {
    h.cast = { castId: 'c' };
    await logout(false);
    expect(h.calls).toEqual(['cast.stop', 'POST /auth/logout']);
  });

  it('does not touch the cast engine when nothing is cast', async () => {
    await logout(false);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('still logs out when stopping the cast fails', async () => {
    h.cast = { castId: 'c' };
    h.stop.mockRejectedValueOnce(new Error('boom'));
    await logout(false);
    expect(h.calls).toEqual(['POST /auth/logout']);
    expect(loc.href).toBe('/auth/login');
  });

  it('without downloads: no question, drops push, ends the session and goes to the login', async () => {
    await logout(false);
    expect(h.confirmCalls).toHaveLength(0);
    expect(h.disablePush).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(h.clearHint).toHaveBeenCalled();
    expect(loc.href).toBe('/auth/login');
  });

  it('with downloads it asks; "delete" wipes them, "keep" leaves them', async () => {
    h.downloads = [{ id: 'a' }];
    await logout(false);
    expect(h.confirmCalls).toHaveLength(1);
    expect(h.confirmCalls[0]).toMatchObject({ danger: true });
    expect(h.removeAll).not.toHaveBeenCalled();
    h.confirmAnswer = true;
    await logout(false);
    expect(h.removeAll).toHaveBeenCalledTimes(1);
  });

  it('a TV goes back to pairing; unreadable IndexedDB does not block the logout', async () => {
    h.downloads = 'error';
    await logout(true);
    expect(loc.href).toBe('/tv');
  });

  it('a hanging push unsubscribe is given up after 3 s', async () => {
    vi.useFakeTimers();
    h.disablePush.mockReturnValue(new Promise(() => undefined));
    const p = logout(false);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(loc.href).toBe('/auth/login');
  });

  it('the early-render hint is cleared even when the logout request fails', async () => {
    logoutStatus = 500;
    await expect(logout(false)).rejects.toThrow();
    expect(h.clearHint).toHaveBeenCalled();
  });
});
