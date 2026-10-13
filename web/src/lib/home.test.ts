import { describe, expect, it } from 'vitest';
import { createSwr, failedParts, firstNonEmptyTab, HOME_PARTS, pageCount, pageIndex, swrLoad } from './home';

describe('row paging', () => {
  it('counts pages', () => {
    expect(pageCount(0, 1000)).toBe(1);
    expect(pageCount(500, 1000)).toBe(2);
    expect(pageCount(1000, 1000)).toBe(2);
    expect(pageCount(1001, 1000)).toBe(2); // rounding slack
    expect(pageCount(1500, 1000)).toBe(3);
    expect(pageCount(100, 0)).toBe(1);
  });
  it('current page', () => {
    expect(pageIndex(0, 1500, 1000)).toBe(0);
    expect(pageIndex(1000, 1500, 1000)).toBe(1);
    expect(pageIndex(1500, 1500, 1000)).toBe(2);
    expect(pageIndex(1495, 1500, 1000)).toBe(2);
    expect(pageIndex(0, 0, 1000)).toBe(0);
  });
});

describe('swr cache', () => {
  it('serves fresh entries without fetching, stale ones and refreshes', async () => {
    let t = 0;
    const c = createSwr<unknown>(1000, () => t);
    const seen: number[] = [];
    let calls = 0;
    const f = async () => ++calls;
    await swrLoad(c, 'k', f, (v) => seen.push(v));
    expect(seen).toEqual([1]);
    t = 500;
    await swrLoad(c, 'k', f, (v) => seen.push(v));
    expect(seen).toEqual([1, 1]); expect(calls).toBe(1);
    t = 2000;
    await swrLoad(c, 'k', f, (v) => seen.push(v));
    expect(seen).toEqual([1, 1, 1, 2]); expect(calls).toBe(2);
    await swrLoad(c, 'k', f, (v) => seen.push(v), 0); // ttl 0: cached value first, always revalidated
    expect(seen).toEqual([1, 1, 1, 2, 2, 3]);
    c.clear(); expect(c.get('k')).toBeUndefined();
  });
  it('propagates fetch errors (cached value stays applied)', async () => {
    const c = createSwr<unknown>(0);
    c.set('k', 7);
    const seen: unknown[] = [];
    await expect(swrLoad(c, 'k', () => Promise.reject(new Error('x')), (v) => seen.push(v))).rejects.toThrow();
    expect(seen).toEqual([7]);
  });
  it('onError only fires when nothing was applied from the cache (a failed background refresh keeps stale content)', async () => {
    const c = createSwr<unknown>(0);
    const seen: unknown[] = [];
    let errors = 0;
    const fail = () => Promise.reject(new Error('x'));
    await swrLoad(c, 'empty', fail, (v) => seen.push(v), undefined, () => errors++); // nothing cached: onError
    expect(errors).toBe(1);
    c.set('k', 7);
    await swrLoad(c, 'k', fail, (v) => seen.push(v), 0, () => errors++); // stale value shown: keep it, no onError
    expect(errors).toBe(1);
    expect(seen).toEqual([7]);
    await expect(swrLoad(c, 'k', fail, (v) => seen.push(v), 0, () => errors++)).resolves.toBeUndefined();
  });
});

describe('firstNonEmptyTab', () => {
  const tabs = ['soon', 'week', 'added'] as const;
  it('picks the first tab with content', () => {
    expect(firstNonEmptyTab(tabs, { soon: [], week: [1], added: [1] })).toBe('week');
    expect(firstNonEmptyTab(tabs, { soon: [1], week: null })).toBe('soon');
    expect(firstNonEmptyTab(tabs, { soon: [], week: [], added: [] })).toBe('soon');
  });
  it('waits while an earlier tab is loading', () => {
    expect(firstNonEmptyTab(tabs, { soon: null, week: [1] })).toBeNull();
    expect(firstNonEmptyTab(tabs, { soon: [], week: null, added: [1] })).toBeNull();
  });
});

describe('GET /api/home response', () => {
  const ok = { hero: null, resume: [], nextup: [], leaving: [], recs: { items: [], recIds: [], friends: [] }, because: { because: null, items: [], more: [] }, hubs: [], themed: [] };
  it('nothing failed when every part is there', () => {
    expect([...failedParts({ parts: ok, failed: [] })]).toEqual([]);
  });
  it('names listed in `failed` are loaded the old way', () => {
    expect([...failedParts({ parts: ok, failed: ['recs', 'hubs'] })].sort()).toEqual(['hubs', 'recs']);
  });
  it('a missing or malformed part counts as failed, unknown names are ignored', () => {
    const { resume: _r, ...rest } = ok;
    const bad = failedParts({ parts: { ...rest, recs: { items: [] }, hubs: null } as never, failed: ['x'] });
    expect([...bad].sort()).toEqual(['hubs', 'recs', 'resume']);
    expect([...failedParts(null as never)].length).toBe(HOME_PARTS.length);
  });
  it('hero may be null (empty library) without being a failure', () => {
    expect(failedParts({ parts: { ...ok, hero: null }, failed: [] }).has('hero')).toBe(false);
  });
});
