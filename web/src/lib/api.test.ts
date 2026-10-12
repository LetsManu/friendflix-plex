import { describe, expect, it } from 'vitest';
import { backdrop, cachedDetail, cachedItem, CARD_WIDTHS, clearItemCache, img, primeDetail, primeItem, setCachedThumb, srcset, type Item } from './api';

const ID = 'a'.repeat(32);

describe('srcset', () => {
  it('builds w-descriptors using the same URLs as img()/backdrop()', () => {
    expect(srcset('Primary', ID, [320, 520])).toBe(`${img(ID, 320)} 320w, ${img(ID, 520)} 520w`);
    expect(srcset('Backdrop', ID, [800, 1280])).toBe(`${backdrop(ID, 800)} 800w, ${backdrop(ID, 1280)} 1280w`);
  });
  it('sorts, de-duplicates and drops invalid widths', () => {
    expect(srcset('Primary', ID, [520, 320, 520, 0, -4, NaN])).toBe(`${img(ID, 320)} 320w, ${img(ID, 520)} 520w`);
    expect(srcset('Primary', ID, [])).toBe('');
  });
  it('card default src (520) is one of the srcset candidates', () => {
    expect(srcset('Backdrop', ID, CARD_WIDTHS)).toContain(backdrop(ID, 520) + ' 520w');
    expect(srcset('Primary', ID, CARD_WIDTHS)).toContain(img(ID, 520) + ' 520w');
  });
});

describe('item cache', () => {
  const it0 = (id: string, extra: Partial<Item> = {}): Item => ({ id, name: 'T ' + id, type: 'Movie', genres: [], image: true, backdrop: true, logo: false, played: false, favorite: false, positionTicks: 0, ...extra });
  it('primes from card data and expires after 10 minutes', () => {
    clearItemCache();
    primeItem(it0('a'), 1000);
    expect(cachedItem('a', 1000 + 60_000)?.name).toBe('T a');
    expect(cachedDetail('a', 1000)).toBeUndefined(); // card data only, no detail
    expect(cachedItem('a', 1000 + 11 * 60_000)).toBeUndefined();
    expect(cachedItem('a', 1000)).toBeUndefined(); // expired entries are dropped
  });
  it('ignores junk and keeps a fuller detail when a card primes again', () => {
    clearItemCache();
    primeItem(null); primeItem(undefined); primeItem({} as Item); primeItem({ id: '', name: 'x' } as Item);
    expect(cachedItem('')).toBeUndefined();
    primeDetail({ item: it0('b', { langs: { audio: ['deu'], subs: [] }, overview: 'lang' }), inWatchlist: true, thumb: 2 }, 0);
    primeItem(it0('b', { positionTicks: 50 }), 10);
    const d = cachedDetail('b', 20)!;
    expect(d.thumb).toBe(2);
    expect(d.inWatchlist).toBe(true);
    expect(d.item.positionTicks).toBe(50); // fresher card fields win
    expect(d.item.langs).toEqual({ audio: ['deu'], subs: [] }); // detail-only fields survive
    expect(d.item.overview).toBe('lang');
  });
  it('setCachedThumb patches a cached detail without extending its lifetime', () => {
    clearItemCache();
    setCachedThumb('x', 1); // nothing cached: no-op
    expect(cachedDetail('x', 0)).toBeUndefined();
    primeDetail({ item: it0('c'), thumb: 0 }, 0);
    setCachedThumb('c', 2);
    expect(cachedDetail('c', 1000)?.thumb).toBe(2);
    expect(cachedDetail('c', 11 * 60_000)).toBeUndefined();
    primeItem(it0('d'), 0);
    setCachedThumb('d', 1); // card-only entry stays without detail
    expect(cachedDetail('d', 0)).toBeUndefined();
  });
  it('is bounded (LRU)', () => {
    clearItemCache();
    for (let i = 0; i < 450; i++) primeItem(it0('i' + i), 0);
    expect(cachedItem('i0', 0)).toBeUndefined();
    expect(cachedItem('i449', 0)).toBeDefined();
  });
});
