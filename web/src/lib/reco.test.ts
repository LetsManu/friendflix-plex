// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COUNT, ORIGIN_TTL_MS, RecoBatcher, isLinkClick, itemIdOfHref, markOrigin, recoPlayStarted, recoReporter, recoTrack, rememberOrigin, type RecoEvent } from './reco';

const apiMock = vi.hoisted(() => vi.fn(async (_path: string, _o?: unknown) => undefined));
vi.mock('#lib/api', () => ({ api: apiMock }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RecoBatcher', () => {
  it('sums counts per row and engine and posts once after the delay', async () => {
    const post = vi.fn(async (_e: RecoEvent[]) => undefined);
    const b = new RecoBatcher(post, 1000);
    b.add({ row: 'because', engine: 'v1' }, 'impressions');
    b.add({ row: 'because', engine: 'v1' }, 'clicks');
    b.add({ row: 'because', engine: 'v1' }, 'clicks');
    b.add({ row: 'because_more', engine: 'v1' }, 'impressions');
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toEqual([
      { row: 'because', engine: 'v1', impressions: 1, clicks: 2, plays: 0, dismisses: 0 },
      { row: 'because_more', engine: 'v1', impressions: 1, clicks: 0, plays: 0, dismisses: 0 },
    ]);
  });
  it('sends nothing when empty, caps counts and survives a failing post', async () => {
    const post = vi.fn(async (_e: RecoEvent[]) => { throw new Error('offline'); });
    const b = new RecoBatcher(post, 1000);
    await b.flush();
    expect(post).not.toHaveBeenCalled();
    for (let i = 0; i < MAX_COUNT + 10; i++) b.add({ row: 'because', engine: 'v1' }, 'clicks');
    await expect(b.flush()).resolves.toBeUndefined();
    expect(post.mock.calls[0]![0][0]!.clicks).toBe(MAX_COUNT);
    await b.flush();
    expect(post).toHaveBeenCalledTimes(1); // counts were dropped, not retried
  });
});

describe('isLinkClick', () => {
  it('is true for a target inside a link only', () => {
    const inside = { target: { closest: (sel: string) => (sel === 'a[href]' ? {} : null) } } as unknown as Event;
    const outside = { target: { closest: () => null } } as unknown as Event;
    expect(isLinkClick(inside)).toBe(true);
    expect(isLinkClick(outside)).toBe(false);
    expect(isLinkClick({ target: null } as unknown as Event)).toBe(false);
  });
});

describe('recoTrack', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reports one impression when half of the row is visible, then one click per followed link, and posts counts only', async () => {
    let cb: (e: Array<{ isIntersecting: boolean }>) => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(c: typeof cb) { cb = c; } observe() {} disconnect = disconnect; });
    let click: (e: Event) => void = () => undefined;
    const node = { addEventListener: (_t: string, f: (e: Event) => void) => { click = f; }, removeEventListener: vi.fn() } as unknown as HTMLElement;
    const act = recoTrack(node, { row: 'because', engine: 'v1' });
    cb([{ isIntersecting: false }]);
    cb([{ isIntersecting: true }]);
    expect(disconnect).toHaveBeenCalled();
    click({ target: { closest: () => ({}) } } as unknown as Event);
    click({ target: { closest: () => null } } as unknown as Event);
    await recoReporter().flush();
    expect(apiMock).toHaveBeenCalledWith('/api/reco/events', { method: 'POST', body: { events: [{ row: 'because', engine: 'v1', impressions: 1, clicks: 1, plays: 0, dismisses: 0 }] }, keepalive: true });
    act.destroy();
    expect((node.removeEventListener as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
  it('does nothing without a tag', () => {
    const node = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement;
    recoTrack(node, undefined).destroy();
    expect(node.addEventListener).not.toHaveBeenCalled();
  });
});

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const memory = () => { const m = new Map<string, string>(); return { m, setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) }; };
const linkTo = (href: string) => ({ target: { closest: () => ({ getAttribute: () => href }) } }) as unknown as Event;
const sent = async () => { apiMock.mockClear(); await recoReporter().flush(); const c = apiMock.mock.calls.at(-1); return c ? (c[1] as { body: { events: RecoEvent[] } }).body.events : []; };

describe('itemIdOfHref', () => {
  it('reads /item/<id> and /watch/<id> only', () => {
    expect(itemIdOfHref(`/item/${A}`)).toEqual({ id: A, play: false });
    expect(itemIdOfHref(`/watch/${A}?x=1`)).toEqual({ id: A, play: true });
    expect(itemIdOfHref('/item/abc')).toBeNull();
    expect(itemIdOfHref(`/lists/${A}`)).toBeNull();
    expect(itemIdOfHref(`https://x.example.com/item/${A}`)).toBeNull();
    expect(itemIdOfHref(null)).toBeNull();
  });
});

describe('plays from a recommendation', () => {
  beforeEach(async () => { vi.useRealTimers(); await recoReporter().flush(); apiMock.mockClear(); });
  it('a click on /item/<id> is remembered; the playback of that title counts one play for the row and engine, once', async () => {
    const store = memory();
    rememberOrigin({ row: 'because', engine: 'v2' }, linkTo(`/item/${A}`), store);
    expect(recoPlayStarted([B], store)).toBe(false); // another title
    expect(recoPlayStarted([B, A], store)).toBe(true); // the title (or its series)
    expect(recoPlayStarted([A], store)).toBe(false); // used up
    expect(await sent()).toEqual([{ row: 'because', engine: 'v2', impressions: 0, clicks: 0, plays: 1, dismisses: 0 }]);
  });
  it('a link straight to /watch/<id> is a play at once; other links are not', async () => {
    rememberOrigin({ row: 'postplay', engine: 'v1' }, linkTo(`/watch/${A}`), memory());
    rememberOrigin({ row: 'postplay', engine: 'v1' }, linkTo('/lists/1'), memory());
    expect(await sent()).toEqual([{ row: 'postplay', engine: 'v1', impressions: 0, clicks: 0, plays: 1, dismisses: 0 }]);
  });
  it('a stale mark, broken storage and a missing mark never count', async () => {
    const store = memory();
    markOrigin({ row: 'transition', engine: 'v2' }, A, store);
    expect(recoPlayStarted([A], store, Date.now() + ORIGIN_TTL_MS + 1000)).toBe(false);
    expect(recoPlayStarted([A], memory())).toBe(false);
    expect(recoPlayStarted([A], { getItem: () => { throw new Error('blocked'); }, removeItem: () => undefined })).toBe(false);
    expect(() => markOrigin({ row: 'because', engine: 'v1' }, A, { setItem: () => { throw new Error('blocked'); } })).not.toThrow();
    expect(await sent()).toEqual([]);
  });
});
