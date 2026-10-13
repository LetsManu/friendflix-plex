import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// node test environment: the bits of a browser the module touches
const store = new Map<string, string>();
vi.stubGlobal('window', globalThis);
vi.stubGlobal('location', new URL('http://ff.test/'));
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
const api = vi.fn();
let profile: string | null = 'p1';
vi.mock('#lib/api', () => ({ api: (...a: unknown[]) => api(...a), getActiveProfile: () => profile }));
vi.mock('$app/navigation', () => ({ preloadCode: () => Promise.resolve() }));
vi.mock('./hls', () => ({ loadHls: () => Promise.resolve() }));
const markPlayArt = vi.fn();
vi.mock('./transition', async (orig) => ({ ...(await orig<typeof import('./transition')>()), markPlayArt: (...a: unknown[]) => markPlayArt(...a) }));
const { HOLD_TIMEOUT_MS, holdPrefetch, playPrefetch, prefetchPlayback, takePrefetched, watchTarget, _resetPrefetch, PREFETCH_TTL_MS } = await import('./prefetch');
const { firstPlaybackRequest, playbackInfoBody, bodyKey } = await import('./infobody');
const { entryFadeMs, playTransition } = await import('./transition');
const { prefs, DEFAULT_PREFS } = await import('#lib/stores');
const { serverCaps, capsFrom } = await import('#lib/capabilities');

/** the body the player sends on its first request (no saved quality, no stored estimate -> 4 Mbit/s, network) */
const playerBody = (itemId: string) => firstPlaybackRequest(itemId, DEFAULT_PREFS).body;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  api.mockReset(); _resetPrefetch(); profile = 'p1'; prefs.set({ ...DEFAULT_PREFS }); serverCaps.set(capsFrom(undefined));
  store.clear();
});
afterEach(() => vi.useRealTimers());

describe('prefetchPlayback / takePrefetched', () => {
  it('posts the body the player sends first', () => {
    api.mockResolvedValue({ playSessionId: 'x' });
    prefetchPlayback('m1');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/playback/info', { method: 'POST', body: { itemId: 'm1', maxBitrate: 4_000_000, reasonHint: 'network' } });
  });

  it('never prefetches when the server starts its transcode in playback info (playbackPrefetch=false, Plex)', () => {
    api.mockResolvedValue({ playSessionId: 'x' });
    serverCaps.set(capsFrom({ playbackPrefetch: false }));
    prefetchPlayback('m1');
    expect(api).not.toHaveBeenCalled();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    serverCaps.set(capsFrom({}));
    prefetchPlayback('m1');
    expect(api).toHaveBeenCalledTimes(1); // absent = allowed (Jellyfin, older backends)
  });

  it('takePrefetched returns the promise once', async () => {
    api.mockResolvedValue({ playSessionId: 'x' });
    prefetchPlayback('m1');
    prefetchPlayback('m1'); // the same item again: no second request
    expect(api).toHaveBeenCalledTimes(1);
    const p = takePrefetched('m1', playerBody('m1'));
    expect(p).not.toBeNull();
    expect(await p).toEqual({ playSessionId: 'x' });
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
  });

  it('expired after 30 s', () => {
    vi.useFakeTimers();
    api.mockResolvedValue({});
    prefetchPlayback('m1');
    vi.advanceTimersByTime(PREFETCH_TTL_MS);
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
  });

  it('body mismatch → null', () => {
    api.mockResolvedValue({});
    prefetchPlayback('m1');
    expect(takePrefetched('m1', { ...playerBody('m1'), audioLang: 'jpn' })).toBeNull();
    prefetchPlayback('m2');
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull(); // other item
    profile = 'p2';
    expect(takePrefetched('m2', playerBody('m2'))).toBeNull(); // the profile switched in between
  });

  it('error drops the entry', async () => {
    api.mockRejectedValue(Object.assign(new Error('API 429'), { status: 429 }));
    prefetchPlayback('m1');
    await flush();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    api.mockResolvedValue({});
    prefetchPlayback('m1'); // after an error a new hover asks again
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a new item replaces the old entry (one in flight)', () => {
    api.mockReturnValue(new Promise(() => undefined));
    prefetchPlayback('m1'); prefetchPlayback('m2');
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    expect(takePrefetched('m2', playerBody('m2'))).not.toBeNull();
  });

  it('follows the saved quality, audio and start of the link', () => {
    api.mockResolvedValue({});
    prefs.set({ ...DEFAULT_PREFS, quality: 8_000_000, audioLang: 'ger' });
    prefetchPlayback('m1', { audio: 'eng', startSec: 90 });
    expect(api.mock.calls[0]![1].body).toEqual({ itemId: 'm1', startTicks: 900_000_000, maxBitrate: 8_000_000, reasonHint: 'manual', audioLang: 'eng' });
    expect(takePrefetched('m1', firstPlaybackRequest('m1', { quality: 8_000_000, audioLang: 'ger' }, 'eng', 90).body)).not.toBeNull();
  });
});

describe('holdPrefetch (the leaving player\'s stop report)', () => {
  it('a prefetch during the hold makes no request; after the stop settles it does', async () => {
    api.mockResolvedValue({});
    let settle!: () => void;
    holdPrefetch(new Promise<void>((r) => (settle = r)));
    prefetchPlayback('m1');
    await flush();
    expect(api).not.toHaveBeenCalled();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    settle();
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(takePrefetched('m1', playerBody('m1'))).not.toBeNull();
  });

  it('clears a cached entry when the hold starts; a failed stop also releases it', async () => {
    api.mockResolvedValue({});
    prefetchPlayback('m1');
    holdPrefetch(Promise.reject(new Error('offline')));
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    await flush();
    prefetchPlayback('m1');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a stop that never settles releases the hold after 4 s', async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({});
    holdPrefetch(new Promise(() => undefined));
    prefetchPlayback('m1');
    await vi.advanceTimersByTimeAsync(HOLD_TIMEOUT_MS - 100);
    expect(api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('a newer hold is not released by the timeout of an older one', async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({});
    holdPrefetch(new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(3000);
    holdPrefetch(new Promise(() => undefined)); // the next player left meanwhile
    prefetchPlayback('m1');
    await vi.advanceTimersByTimeAsync(1500); // the first hold timed out, the second still runs
    expect(api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('playPrefetch click', () => {
  /** minimal element: listeners, href, no scope (artwork null) */
  const fakeLink = (href: string) => {
    const on = new Map<string, (e: unknown) => void>();
    const node = { getAttribute: () => href, closest: () => null, addEventListener: (k: string, f: (e: unknown) => void) => on.set(k, f), removeEventListener: () => undefined };
    playPrefetch(node as unknown as HTMLElement);
    return (e: Partial<MouseEvent>) => on.get('click')!({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...e });
  };
  beforeEach(() => markPlayArt.mockReset());
  it('a plain click marks the artwork for the transition', () => {
    fakeLink('/watch/m1')({});
    expect(markPlayArt).toHaveBeenCalledTimes(1);
  });
  it('ctrl/meta/shift/middle clicks and prevented clicks do not', () => {
    const click = fakeLink('/watch/m1');
    for (const e of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, { defaultPrevented: true }]) click(e);
    expect(markPlayArt).not.toHaveBeenCalled();
  });
});

describe('infobody', () => {
  it('drops undefined fields and asks for the original at Infinity', () => {
    expect(playbackInfoBody({ itemId: 'a', bps: Infinity, hint: 'network' })).toEqual({ itemId: 'a', reasonHint: 'network' });
    expect(bodyKey({ b: 1, a: undefined, c: 2 })).toBe(bodyKey({ c: 2, b: 1 }));
  });
  it('uses the remembered bandwidth estimate for the first rung', () => {
    localStorage.setItem('ff_bw', JSON.stringify({ bps: 30_000_000, at: Date.now() }));
    expect(firstPlaybackRequest('a', DEFAULT_PREFS).body.maxBitrate).toBeGreaterThan(4_000_000);
  });
  it('Auto on a fast link asks for original (70% of the estimate, above the top rung), shared by prefetch and player', () => {
    localStorage.setItem('ff_bw', JSON.stringify({ bps: 100_000_000, at: Date.now() }));
    const fr = firstPlaybackRequest('a', DEFAULT_PREFS);
    expect(fr.body).toEqual({ itemId: 'a', maxBitrate: 70_000_000, reasonHint: 'network' });
    expect(fr.bps).toBe(70_000_000);
    api.mockResolvedValue({});
    prefetchPlayback('a');
    expect(api).toHaveBeenCalledWith('/api/playback/info', { method: 'POST', body: fr.body });
    expect(takePrefetched('a', fr.body)).not.toBeNull();
  });
  it('a slow link stays on the ladder', () => {
    localStorage.setItem('ff_bw', JSON.stringify({ bps: 10_000_000, at: Date.now() }));
    expect(firstPlaybackRequest('a', DEFAULT_PREFS).body.maxBitrate).toBe(4_000_000);
  });
});

describe('watchTarget', () => {
  it('reads player links only', () => {
    expect(watchTarget('/watch/abc?audio=jpn&t=42')).toEqual({ id: 'abc', audio: 'jpn', startSec: 42 });
    expect(watchTarget('/watch/abc')).toEqual({ id: 'abc', audio: undefined, startSec: undefined });
    expect(watchTarget('/item/abc')).toBeNull();
    expect(watchTarget(null)).toBeNull();
  });
});

describe('transition choice', () => {
  it('TV none, reduced motion or no API fade, else view transition', () => {
    expect(playTransition({ tv: true, reduced: false, hasApi: true })).toBe('none');
    expect(playTransition({ tv: false, reduced: true, hasApi: true })).toBe('fade');
    expect(playTransition({ tv: false, reduced: false, hasApi: false })).toBe('fade');
    expect(playTransition({ tv: false, reduced: false, hasApi: true })).toBe('view');
  });
  it('entry fade: 0 on TV / during a view transition, 120 reduced, 200 otherwise', () => {
    expect(entryFadeMs({ tv: true, reduced: false, viewTransition: false })).toBe(0);
    expect(entryFadeMs({ tv: false, reduced: false, viewTransition: true })).toBe(0);
    expect(entryFadeMs({ tv: false, reduced: true, viewTransition: false })).toBe(120);
    expect(entryFadeMs({ tv: false, reduced: false, viewTransition: false })).toBe(200);
  });
});
