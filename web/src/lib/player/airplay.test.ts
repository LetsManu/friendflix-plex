import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastInfo } from '#lib/cast';
import { airPlaySupported, ARM_MS, AUTO_MAX, AUTO_WINDOW_MS, AVAILABILITY_EVENT, createAirPlay, SETTLE_MS, WIRELESS_EVENT, WIRELESS_OFF_GRACE_MS, type AirPlayDeps, type AirPlayState } from './airplay';
import { clearAirLog, readAirLog } from './airplayLog';

/** a <video> stand-in: Safari's AirPlay events are simulated by dispatching them */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  private _src = 'blob:hlsjs';
  get src() { return this._src; }
  set src(v: string) { this._src = v; this.srcChanged(); }
  /** hook for WebKit's reaction to a src change */
  protected srcChanged() { /* nothing */ }
  attrs = new Map<string, string>([['crossorigin', 'use-credentials']]);
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  play = vi.fn(async () => { this.paused = false; });
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  wireless(on: boolean) { this.webkitCurrentPlaybackTargetIsWireless = on; this.dispatchEvent(new Event(WIRELESS_EVENT)); }
}
const available = (t: EventTarget, on: boolean) => t.dispatchEvent(Object.assign(new Event(AVAILABILITY_EVENT), { availability: on ? 'available' : 'not-available' }));

const CI: CastInfo = {
  castId: 'c'.repeat(32), expiresAt: Date.now() + 3600_000, playSessionId: 'ps', mediaSourceId: 'ms', startTime: 754,
  contentUrl: 'https://ff.example/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
};
const CI2: CastInfo = { ...CI, castId: 'd'.repeat(32), contentUrl: 'https://ff.example/media/c/TOKEN2/Videos/x/master.m3u8' };
const flush = () => new Promise((r) => setTimeout(r, 0));
/** the stream probe fetches the token's playlists: default stub = 404 (no network in unit tests) */
const probeFetch = vi.fn(async (_u: string, _o?: unknown) => new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }));
beforeEach(() => { probeFetch.mockClear(); vi.stubGlobal('fetch', probeFetch); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearAirLog(); });
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });

function setup(over: Partial<AirPlayDeps> = {}, probe?: EventTarget) {
  const v = new FakeVideo();
  const states: AirPlayState[] = [];
  const deps = {
    request: vi.fn(async () => CI),
    revoke: vi.fn(),
    detach: vi.fn(),
    started: vi.fn(),
    restore: vi.fn(),
    fail: vi.fn(),
    change: vi.fn((s: AirPlayState) => { states.push(s); }),
    ...over,
  } satisfies AirPlayDeps;
  const c = createAirPlay(v, deps, probe);
  return { v, c, deps, states };
}
/** button tap (token stream on the element, picker) + the picker's choice (the TV) */
async function airplayOn(v: FakeVideo, c: ReturnType<typeof setup>['c']) {
  c.pick();
  await flush();
  v.wireless(true);
  await flush();
}

describe('feature detection', () => {
  it('needs webkitShowPlaybackTargetPicker (Chromium has none)', () => {
    expect(airPlaySupported(new FakeVideo())).toBe(true);
    expect(airPlaySupported({} as never)).toBe(false);
    expect(airPlaySupported(null)).toBe(false);
  });
});

describe('AirPlay controller', () => {
  it('allows AirPlay on the element and shows the button only while a receiver is available', () => {
    const { v, c, states } = setup();
    expect(v.getAttribute('x-webkit-airplay')).toBe('allow');
    expect(c.state.available).toBe(false);
    available(v, true);
    expect(states.at(-1)).toMatchObject({ available: true, active: false });
    available(v, false);
    expect(states.at(-1)?.available).toBe(false);
  });

  it('availability also comes from the probe element (hls.js blocks remote playback on the main video)', () => {
    const probe = new EventTarget();
    const { v, c } = setup({}, probe);
    available(probe, true);
    expect(c.state.available).toBe(true);
    available(v, false); // the main element says no: the probe still knows a receiver
    expect(c.state.available).toBe(true);
    available(probe, false);
    expect(c.state.available).toBe(false);
  });

  it('tap: token first (detach, request at the position, token URL on the element), THEN the picker; ready until a TV is chosen', async () => {
    const { v, c, deps, states } = setup();
    v.currentTime = 754.2; v.paused = false;
    c.pick();
    expect(c.state).toMatchObject({ busy: true, ready: false, active: false });
    expect(v.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled(); // never with the cookie / MSE URL
    await flush();
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith(754.2);
    expect(deps.started).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI.contentUrl);
    expect(v.getAttribute('crossorigin')).toBeNull(); // the token URL needs no credentials
    expect(v.play).toHaveBeenCalled();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.request).mock.invocationCallOrder[0]).toBeLessThan(v.webkitShowPlaybackTargetPicker.mock.invocationCallOrder[0]!);
    expect(v.webkitShowPlaybackTargetPicker.mock.contexts[0]).toBe(v);
    expect(c.state).toMatchObject({ busy: false, ready: true, active: false, error: false });
    expect(c.info).toBe(CI);
    expect(states.some((s) => s.ready)).toBe(true);
    v.currentTime = 0; // a new src starts at 0 ...
    v.dispatchEvent(new Event('loadedmetadata'));
    expect(v.currentTime).toBe(754.2); // ... and resumes where the phone was
  });

  it('the picker throws (no gesture any more): still ready, the prompt opens it from a fresh tap', async () => {
    const { v, c } = setup();
    v.webkitShowPlaybackTargetPicker.mockImplementationOnce(() => { throw new Error('gesture'); });
    c.pick();
    await flush();
    expect(c.state.ready).toBe(true);
    c.pick(); // the prompt's / the button's tap while ready: opens the picker synchronously, no new token
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(2);
  });

  it('a tap while ready opens the picker synchronously without a new request', async () => {
    const { v, c, deps } = setup();
    c.pick();
    await flush();
    v.webkitShowPlaybackTargetPicker.mockClear();
    c.pick();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
  });

  it('double tap while the token loads: one request, one picker', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    c.pick();
    c.pick();
    await flush();
    c.pick();
    expect(c.state.busy).toBe(true);
    resolve(CI);
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
  });

  it('wireless after the picker: active right away, no src swap and no new token', async () => {
    const { v, c, deps } = setup();
    v.paused = false;
    c.pick();
    await flush();
    v.src = CI.contentUrl; // what the element holds (Safari may normalise it; we compare against info)
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, ready: false, busy: false, error: false });
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(c.info).toBe(CI);
    expect(v.src).toBe(CI.contentUrl);
  });

  it(`no TV within ${ARM_MS / 1000} s: token revoked, back to the normal stream at the position`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    v.currentTime = 50; v.paused = false;
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state.ready).toBe(true);
    v.currentTime = 62;
    await vi.advanceTimersByTimeAsync(ARM_MS - 100);
    expect(deps.restore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(62, true, CI);
    expect(v.getAttribute('crossorigin')).toBe('use-credentials');
    expect(c.info).toBeNull();
    expect(c.state).toMatchObject({ ready: false, active: false, busy: false });
  });

  it('ARM_MS is 90 s (the picker and the TV may take a while)', () => {
    expect(ARM_MS).toBe(90_000);
  });

  it('a tap while ready restarts the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { c, deps } = setup();
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ARM_MS - 10_000);
    c.pick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.restore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ARM_MS);
    expect(deps.restore).toHaveBeenCalledOnce();
  });

  it('the arm timer is cleared once a TV is chosen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(ARM_MS * 2);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(c.state.active).toBe(true);
  });

  it('token request fails before any TV is chosen: toast + normal stream, no active / error state, no picker', async () => {
    const err = Object.assign(new Error('x'), { body: { error: 'max_streams', max: 1 } });
    const { v, c, deps } = setup({ request: vi.fn(async (): Promise<CastInfo> => { throw err; }) });
    v.currentTime = 42; v.paused = false;
    c.pick();
    await flush();
    expect(deps.fail).toHaveBeenCalledWith(err);
    expect(deps.restore).toHaveBeenCalledWith(42, true, null);
    expect(deps.started).not.toHaveBeenCalled();
    expect(v.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: false, ready: false, busy: false, error: false });
    expect(c.info).toBeNull();
  });

  it('wireless while the token still loads (e.g. picked elsewhere): active as soon as the token URL is on the element, no picker', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    c.pick();
    await flush();
    v.wireless(true);
    resolve(CI);
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(v.src).toBe(CI.contentUrl);
    expect(c.state).toMatchObject({ active: true, ready: false, busy: false });
    expect(v.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled();
  });

  it('wireless without a token URL on the element (Control Center route): falls back to fetching one and switching', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    v.currentTime = 300; v.paused = false;
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, busy: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith(300);
    expect(deps.started).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI.contentUrl);
    expect(c.state).toMatchObject({ active: true, busy: false, error: false });
  });

  it('a playback error on the phone while ready: toast, token revoked, normal stream', async () => {
    const { v, c, deps } = setup();
    v.currentTime = 70;
    c.pick();
    await flush();
    c.videoError();
    await flush();
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(70, false, CI);
    expect(c.state).toMatchObject({ ready: false, active: false, error: false });
  });

  it('refresh() while ready (other audio track): new token on the element, still ready, old one revoked', async () => {
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    c.pick();
    await flush();
    await c.refresh();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.info).toBe(CI2);
    expect(c.state).toMatchObject({ ready: true, active: false, busy: false });
    v.wireless(true);
    expect(c.state.active).toBe(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refresh() fails while ready: toast + error state (Retry), no restore, src untouched, the old token stays', async () => {
    const request = vi.fn(async () => CI);
    const { v, c, deps } = setup({ request });
    c.pick();
    await flush();
    request.mockImplementationOnce(async () => { throw new Error('net'); });
    await c.refresh();
    await flush();
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.restore).not.toHaveBeenCalled();
    expect(v.src).toBe(CI.contentUrl);
    expect(c.state).toMatchObject({ ready: true, active: false, error: true });
    request.mockImplementationOnce(async () => CI2);
    await c.retry();
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.state).toMatchObject({ ready: true, active: false, error: false });
  });

  it('a paused video stays paused on the TV', async () => {
    const { v, c } = setup();
    v.currentTime = 30;
    await airplayOn(v, c);
    expect(v.play).not.toHaveBeenCalled();
  });

  it('sustained wireless off: revokes the token and restores the normal stream at the position', async () => {
    fake();
    const { v, c, deps } = setup();
    v.currentTime = 100; v.paused = false;
    await airplayOn(v, c);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    v.currentTime = 812;
    v.wireless(false);
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS - 100);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state.active).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(812, true, CI);
    expect(v.getAttribute('crossorigin')).toBe('use-credentials');
    expect(c.info).toBeNull();
    expect(c.state).toMatchObject({ active: false, busy: false, error: false });
  });

  it('Control Center route: AirPlay ended while the token was still being requested: the late token is revoked, never used', async () => {
    let resolve!: (ci: CastInfo) => void;
    fake();
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    v.wireless(true);
    await flush();
    v.wireless(false);
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS + 10);
    expect(deps.restore).toHaveBeenCalledOnce();
    expect(c.state.active).toBe(false);
    resolve(CI);
    await flush();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.started).not.toHaveBeenCalled();
    expect(v.src).not.toBe(CI.contentUrl);
  });

  it('Control Center route: request fails while the TV is the target: error state with Retry, no fallback to the cookie stream', async () => {
    const err = Object.assign(new Error('x'), { body: { error: 'max_streams', max: 1 } });
    const request = vi.fn(async (): Promise<CastInfo> => { throw err; });
    const { v, c, deps } = setup({ request });
    v.currentTime = 42; v.paused = false;
    v.wireless(true);
    await flush();
    expect(deps.fail).toHaveBeenCalledWith(err);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: true, busy: false, error: true });
    // Retry succeeds
    request.mockImplementationOnce(async () => CI);
    await c.retry();
    expect(c.state).toMatchObject({ active: true, error: false });
    expect(v.src).toBe(CI.contentUrl);
  });

  it('refresh fails: the old token stays (not revoked), error state; Retry then swaps tokens', async () => {
    const request = vi.fn(async () => CI);
    const { v, c, deps } = setup({ request });
    await airplayOn(v, c);
    request.mockImplementationOnce(async () => { throw new Error('net'); });
    await c.refresh();
    expect(c.state.error).toBe(true);
    expect(c.info).toBe(CI);
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(v.src).toBe(CI.contentUrl);
    request.mockImplementationOnce(async () => CI2);
    await c.retry();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.state.error).toBe(false);
  });

  it('a playback error on the TV: error state + toast, Retry requests a new token', async () => {
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    await airplayOn(v, c);
    c.videoError();
    expect(c.state.error).toBe(true);
    expect(deps.fail).toHaveBeenCalledOnce();
    c.videoError(); // once
    expect(deps.fail).toHaveBeenCalledOnce();
    await c.retry();
    expect(request).toHaveBeenCalledTimes(2);
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
  });

  it('videoError() outside AirPlay or while switching does nothing', async () => {
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>(() => undefined)) });
    c.videoError();
    c.pick(); // busy (token loading)
    c.videoError();
    v.wireless(true); // still busy
    c.videoError();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('refresh(): new token at the current position, the old one revoked (audio track / quality / renewal)', async () => {
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    v.currentTime = 10;
    await airplayOn(v, c);
    v.currentTime = 500;
    await c.refresh();
    expect(request).toHaveBeenLastCalledWith(500);
    expect(deps.detach).toHaveBeenCalledTimes(2); // the old session's stop report
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.info).toBe(CI2);
  });

  it('refresh() does nothing without AirPlay', async () => {
    const { c, deps } = setup();
    await c.refresh();
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('destroy() removes the listeners, stops the arm timer and revokes a live token', async () => {
    const { v, c, deps, states } = setup();
    await airplayOn(v, c);
    c.destroy();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    const n = states.length;
    available(v, true);
    v.wireless(false);
    expect(states).toHaveLength(n);
    expect(deps.restore).not.toHaveBeenCalled();
  });
});

/**
 * Field bug (iPhone PWA -> LG webOS): WebKit resets the wireless route state when `src` changes (bug 158226) and reports
 * the still picked route again right after. The old controller reacted to every flip: off -> stop + restore (src change), on
 * without our token -> new token (src change) -> off -> ... and after the first 429 a tight request loop (314 POSTs in 30 min).
 */
class FlakyRouteVideo extends FakeVideo {
  /** while true: every src assignment makes WebKit report "not wireless" for `offMs`, then "wireless" again (route still picked) */
  routePicked = false;
  offMs = 200;
  protected override srcChanged() {
    if (!this.routePicked) return;
    queueMicrotask(() => this.wireless(false));
    setTimeout(() => { if (this.routePicked) this.wireless(true); }, this.offMs);
  }
}
function setupFlaky(over: Partial<AirPlayDeps> = {}) {
  const v = new FlakyRouteVideo();
  const states: AirPlayState[] = [];
  const deps = {
    request: vi.fn(async () => CI), revoke: vi.fn(), detach: vi.fn(), started: vi.fn(), fail: vi.fn(),
    // the player's restore puts the normal stream (hls.js blob) back on the element: a src change like any other
    restore: vi.fn(() => { v.src = 'blob:hlsjs2'; }),
    change: vi.fn((s: AirPlayState) => { states.push(s); }),
    ...over,
  } satisfies AirPlayDeps;
  const c = createAirPlay(v, deps);
  return { v, c, deps, states };
}

describe('AirPlay: no token request loop', () => {
  it('constants: 4 s grace for wireless off, 1.5 s settle after our src change, breaker 3 / 60 s', () => {
    expect(WIRELESS_OFF_GRACE_MS).toBe(4000);
    expect(SETTLE_MS).toBe(1500);
    expect(AUTO_MAX).toBe(3);
    expect(AUTO_WINDOW_MS).toBe(60_000);
  });

  it('tap + TV picked, WebKit flips wireless off/on around our src change: one request, no stop, no restore', async () => {
    fake();
    const { v, c, deps } = setupFlaky();
    v.paused = false;
    v.routePicked = true; // the picker's choice (the flips start with our src assignment)
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: true, busy: false, error: false });
    expect(v.src).toBe(CI.contentUrl);
  });

  it('route chosen outside our button, flips around every src change: exactly ONE automatic request', async () => {
    fake();
    const { v, c, deps } = setupFlaky();
    v.routePicked = true;
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: true, error: false });
  });

  it('the element is "on our token" by own tracking, not by URL comparison (Safari may report a different src string)', async () => {
    fake();
    const { v, c, deps } = setup();
    c.pick();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    v.src = 'https://FF.EXAMPLE:443/media/c/TOKEN/Videos/x/master.m3u8?normalised'; // whatever WebKit reports
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.state.active).toBe(true);
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it('429 while the route is wireless: error state, no restore, no src change, no further requests (even with flips)', async () => {
    fake();
    const err = Object.assign(new Error('429'), { status: 429, body: { error: 'rate_limited' } });
    const { v, c, deps } = setupFlaky({ request: vi.fn(async (): Promise<CastInfo> => { throw err; }) });
    v.routePicked = true;
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state).toMatchObject({ active: true, error: true, busy: false });
    const srcNow = v.src;
    // WebKit keeps flipping briefly (no src change of ours, so do it by hand)
    for (let i = 0; i < 5; i++) {
      v.wireless(false);
      await vi.advanceTimersByTimeAsync(500);
      v.wireless(true);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.restore).not.toHaveBeenCalled();
    expect(v.src).toBe(srcNow);
    expect(c.state).toMatchObject({ active: true, error: true });
  });

  it('token-first request fails while the route is already wireless: error state, no restore', async () => {
    const { v, c, deps } = setup({ request: vi.fn(async (): Promise<CastInfo> => { throw new Error('429'); }) });
    v.webkitCurrentPlaybackTargetIsWireless = true;
    c.pick();
    await flush();
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: true, error: true, busy: false });
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it('debounce: wireless off then on again within the grace: no stop, no restore, no new token', async () => {
    fake();
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    v.wireless(false);
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS - 500);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS * 3);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(c.state.active).toBe(true);
  });

  it('the grace timer re-checks the actual property (an "on" event may be missing)', async () => {
    fake();
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    v.wireless(false);
    v.webkitCurrentPlaybackTargetIsWireless = true; // back on without an event
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS + 100);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state.active).toBe(true);
  });

  it('settle: wireless off right after our own src change is ignored; the actual state is checked once after the window', async () => {
    fake();
    const { v, c, deps } = setup();
    await airplayOn(v, c); // active
    const request = vi.mocked(deps.request);
    request.mockResolvedValueOnce(CI2);
    await c.refresh(); // our src change
    v.wireless(false); // WebKit's reset
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS * 2);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: true, error: false });
    expect(c.info).toBe(CI2);
  });

  it('route really off after the window: stop after the grace (behaves as before)', async () => {
    fake();
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    v.wireless(false); // during the settle window: ignored ...
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10); // ... the re-check sees "off" -> grace
    expect(deps.restore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS);
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledOnce();
    expect(c.state).toMatchObject({ active: false, error: false });
  });

  it('long off phases after each src change (sustained > grace): stop once, then error instead of a second automatic token', async () => {
    fake();
    const { v, c, deps } = setupFlaky();
    v.offMs = WIRELESS_OFF_GRACE_MS + 2_000;
    v.routePicked = true;
    v.wireless(true); // outside route: automatic request #1
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.restore).toHaveBeenCalledOnce();
    expect(c.state).toMatchObject({ active: true, error: true, busy: false });
    // Retry is a user tap: allowed
    await c.retry();
    expect(deps.request).toHaveBeenCalledTimes(2);
  });

  it(`breaker: at most ${AUTO_MAX} automatic requests per ${AUTO_WINDOW_MS / 1000} s, then error with Retry (no request)`, async () => {
    fake();
    const { v, c, deps } = setupFlaky();
    // the route really comes and goes (Control Center), each episode gets its one automatic request
    for (let i = 0; i < AUTO_MAX + 1; i++) {
      v.wireless(true);
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
      v.wireless(false);
      await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS + SETTLE_MS + 20);
    }
    expect(deps.request).toHaveBeenCalledTimes(AUTO_MAX);
    expect(readAirLog().some((e) => e.ev === 'breaker')).toBe(true);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.request).toHaveBeenCalledTimes(AUTO_MAX);
    expect(c.state).toMatchObject({ active: true, error: true });
    await c.retry(); // a tap still works
    expect(deps.request).toHaveBeenCalledTimes(AUTO_MAX + 1);
    expect(c.state).toMatchObject({ active: true, error: false });
  });

  it('user taps do not count against the breaker', async () => {
    fake();
    const { v, c, deps } = setup();
    for (let i = 0; i < AUTO_MAX + 2; i++) {
      c.pick();
      await vi.advanceTimersByTimeAsync(0);
      expect(c.state.ready).toBe(true);
      c.videoError(); // phone's token stream fails: normal stream (stop)
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    }
    expect(deps.request).toHaveBeenCalledTimes(AUTO_MAX + 2);
    expect(v.src).toBe(CI.contentUrl);
  });

  it('logs the decisions without URLs or cast ids', async () => {
    fake();
    const { v, c } = setupFlaky();
    v.routePicked = true;
    available(v, true);
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(10_000);
    c.videoError(5);
    const log = readAirLog();
    const evs = log.map((e) => e.ev);
    for (const ev of ['availability', 'pick', 'token-start', 'token-ok', 'src', 'wireless', 'video-error']) expect(evs).toContain(ev);
    expect(log.some((e) => e.ev === 'wireless' && e.note?.includes('ignored'))).toBe(true);
    expect(log.some((e) => e.src === 'token')).toBe(true);
    const raw = JSON.stringify(log);
    for (const bad of ['TOKEN', 'ff.example', 'c'.repeat(32), '/media/']) expect(raw).not.toContain(bad);
  });

  it('a failed request is logged with its status code', async () => {
    const err = Object.assign(new Error('x'), { status: 429 });
    const { c } = setup({ request: vi.fn(async (): Promise<CastInfo> => { throw err; }) });
    c.pick();
    await flush();
    expect(readAirLog().find((e) => e.ev === 'token-fail')?.note).toContain('429');
  });

  it('a slow restore keeps the settle window open: flips while the normal stream re-attaches never start a request', async () => {
    fake();
    let done!: () => void;
    const { v, c, deps } = setup({ restore: vi.fn(() => new Promise<void>((r) => (done = r))) });
    v.wireless(true); // outside route: the one automatic request
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    v.wireless(false);
    await vi.advanceTimersByTimeAsync(WIRELESS_OFF_GRACE_MS + 10); // sustained: stop, restore starts (slow)
    expect(deps.restore).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 4); // restore still running: window kept open
    v.src = 'blob:hlsjs2';
    v.wireless(true); // WebKit reports the route again: ignored (settle)
    expect(deps.request).toHaveBeenCalledOnce();
    done();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10); // re-check: still wireless, same episode -> error, no request
    expect(deps.request).toHaveBeenCalledOnce();
    expect(c.state).toMatchObject({ active: true, error: true });
  });
});

describe('stream probe', () => {
  const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2"\nmain.m3u8?api_key=SECRETKEY123\n';
  const VARIANT = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6,\nseg0.ts?api_key=SECRETKEY123\n#EXT-X-ENDLIST\n';
  const okFetch = () => probeFetch.mockImplementation(async (u: string) => new Response(u.includes('master') ? MASTER : VARIANT, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  const evs = () => readAirLog().map((e) => e.ev);

  it('after token-ok: master and first variant are fetched without credentials and logged sanitized', async () => {
    okFetch();
    const { v, c } = setup();
    c.pick();
    await flush(); await flush();
    expect(probeFetch.mock.calls.map((x) => x[0])).toEqual([CI.contentUrl, 'https://ff.example/media/c/TOKEN/Videos/x/main.m3u8?api_key=SECRETKEY123']);
    expect(probeFetch.mock.calls[0]![1]).toEqual({ credentials: 'omit', cache: 'no-store' });
    const log = readAirLog();
    expect(log.map((e) => e.ev)).toEqual(expect.arrayContaining(['token-ok', 'probe-master', 'probe-variant']));
    const pm = log.find((e) => e.ev === 'probe-master')!, pv = log.find((e) => e.ev === 'probe-variant')!;
    expect(pm.note).toMatch(/^HTTP 200 application\/vnd\.apple\.mpegurl \d+ B \| EXTM3U \| EXT-X-STREAM-INF BANDWIDTH=1 CODECS="avc1\.640028,mp4a\.40\.2" \| uri:rel \.m3u8$/);
    expect(pv.note).toMatch(/VERSION=3 \| ENDLIST \| EXTINF x1 \| first uri:rel \.ts$/);
    expect(JSON.stringify(log)).not.toMatch(/SECRETKEY|api_key|TOKEN|main\.m3u8|seg0/);
    expect(v.src).toBe(CI.contentUrl); // the probe changed nothing on the element
  });

  it('runs once per token: tap, then refresh and retry each probe their new token only', async () => {
    okFetch();
    const request = vi.fn().mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2).mockResolvedValue(CI2);
    const { v, c } = setup({ request });
    await airplayOn(v, c);
    await flush();
    expect(probeFetch.mock.calls.filter((x) => x[0] === CI.contentUrl)).toHaveLength(1);
    await c.refresh();
    await flush(); await flush();
    expect(probeFetch.mock.calls.filter((x) => x[0] === CI2.contentUrl)).toHaveLength(1);
    expect(probeFetch.mock.calls.filter((x) => x[0] === CI.contentUrl)).toHaveLength(1);
  });

  it('probes automatic requests (route chosen outside the button)', async () => {
    const { v } = setup();
    v.wireless(true);
    await flush(); await flush();
    expect(probeFetch.mock.calls.map((x) => x[0])).toContain(CI.contentUrl);
    expect(evs()).toContain('probe-master');
  });

  it('a failing probe (network / CORS) is logged and harmless', async () => {
    probeFetch.mockImplementation(async () => { throw new TypeError('Load failed'); });
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    await flush();
    expect(c.state.active).toBe(true);
    expect(c.state.error).toBe(false);
    expect(deps.fail).not.toHaveBeenCalled();
    expect(readAirLog().find((e) => e.ev === 'probe-master-fail')?.note).toBe('error TypeError');
  });

  it('a non-200 master is logged with the status', async () => {
    probeFetch.mockImplementation(async () => new Response('x', { status: 403, headers: { 'content-type': 'text/plain' } }));
    const { c } = setup();
    c.pick();
    await flush(); await flush();
    expect(readAirLog().find((e) => e.ev === 'probe-master')?.note).toBe('HTTP 403 text/plain 1 B (not 200)');
  });

  it('is skipped when the controller is dead, and silent when it dies meanwhile', async () => {
    const { c } = setup();
    c.destroy();
    clearAirLog();
    c.pick();
    await flush();
    expect(probeFetch).not.toHaveBeenCalled();

    let release!: () => void;
    probeFetch.mockImplementation(() => new Promise<Response>((r) => { release = () => r(new Response(MASTER, { status: 200 })); }));
    const b = setup();
    b.c.pick();
    await flush(); await flush();
    b.c.destroy();
    clearAirLog();
    release();
    await flush(); await flush();
    expect(readAirLog()).toEqual([]);
  });

  it('video-error logs the MediaError message without URLs, /media paths or ids', async () => {
    const { v, c } = setup();
    await airplayOn(v, c);
    clearAirLog();
    c.videoError(4, `The operation couldn't be completed (CoreMediaErrorDomain -12927) https://ff.example/media/c/TOKEN/Videos/x/master.m3u8?api_key=SECRETKEY123 /media/c/TOKEN2/y`);
    const e = readAirLog().find((x) => x.ev === 'video-error')!;
    expect(e.note).toBe("code 4 w=true msg The operation couldn't be completed (CoreMediaErrorDomain -12927) <url> <url>");
    expect(JSON.stringify(e)).not.toMatch(/SECRETKEY|TOKEN|ff\.example/);
  });

  it('video-error without a message keeps the short form', async () => {
    const { v, c } = setup();
    await airplayOn(v, c);
    clearAirLog();
    c.videoError(4);
    expect(readAirLog().find((x) => x.ev === 'video-error')?.note).toBe('code 4 w=true');
  });
});

describe('variant fallback (MEDIA_ERR_SRC_NOT_SUPPORTED on the master)', () => {
  const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2"\nmain.m3u8?MediaSourceId=ms&PlaySessionId=ps\n#EXT-X-STREAM-INF:BANDWIDTH=2\nother.m3u8\n';
  const VARIANT_URL = 'https://ff.example/media/c/TOKEN/Videos/x/main.m3u8?MediaSourceId=ms&PlaySessionId=ps';
  const serve = (master = MASTER) => probeFetch.mockImplementation(async (u: string) => new Response(u.includes('master') ? master : '#EXTM3U\n', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  const evs = () => readAirLog().map((e) => e.ev);

  it('active (TV): code 4 -> the first variant playlist goes on the element, no master, no error state, no new token', async () => {
    serve();
    const { v, c, deps } = setup();
    v.paused = false;
    v.currentTime = 300;
    await airplayOn(v, c);
    await flush();
    probeFetch.mockClear();
    v.play.mockClear();
    c.videoError(4);
    await flush(); await flush();
    expect(probeFetch).toHaveBeenCalledWith(CI.contentUrl, expect.objectContaining({ credentials: 'omit' }));
    expect(v.src).toBe(VARIANT_URL);
    expect(c.state).toMatchObject({ active: true, error: false, busy: false });
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(v.play).toHaveBeenCalled(); // resumes like play()
    v.currentTime = 0;
    v.dispatchEvent(new Event('loadedmetadata'));
    expect(v.currentTime).toBe(300);
    expect(evs()).toContain('fallback-variant');
    expect(JSON.stringify(readAirLog())).not.toMatch(/main\.m3u8|TOKEN|ff\.example|MediaSourceId/);
  });

  it('ready (phone plays the token): code 4 -> variant instead of the normal stream', async () => {
    serve();
    const { v, c, deps } = setup();
    c.pick();
    await flush(); await flush();
    c.videoError(4);
    await flush(); await flush();
    expect(v.src).toBe(VARIANT_URL);
    expect(c.state).toMatchObject({ ready: true, active: false, error: false });
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('the variant URL counts as our token stream (wireless on -> active, no automatic request)', async () => {
    serve();
    const { v, c, deps } = setup();
    c.pick();
    await flush(); await flush();
    c.videoError(4);
    await flush(); await flush();
    expect(v.src).toBe(VARIANT_URL);
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, error: false });
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it('once per token: the variant also fails -> the existing error behaviour (TV: error state + toast)', async () => {
    serve();
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    c.videoError(4);
    await flush(); await flush();
    expect(v.src).toBe(VARIANT_URL);
    c.videoError(4);
    expect(c.state.error).toBe(true);
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(evs().filter((e) => e === 'fallback-variant')).toHaveLength(1);
  });

  it('a new token (retry / refresh) starts again with its master, and may fall back once more', async () => {
    serve();
    const CI2v = 'https://ff.example/media/c/TOKEN2/Videos/x/main.m3u8?MediaSourceId=ms&PlaySessionId=ps';
    const request = vi.fn().mockResolvedValueOnce(CI).mockResolvedValue(CI2);
    const { v, c } = setup({ request });
    await airplayOn(v, c);
    c.videoError(4);
    await flush(); await flush();
    c.videoError(4); // variant failed too: error
    expect(c.state.error).toBe(true);
    await c.retry();
    expect(v.src).toBe(CI2.contentUrl);
    c.videoError(4);
    await flush(); await flush();
    expect(v.src).toBe(CI2v);
    expect(c.state.error).toBe(false);
  });

  it('master unreachable / without a variant / variant outside the token path: existing behaviour', async () => {
    for (const body of [null, '#EXTM3U\n', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.example/v.m3u8\n', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n../../../../Videos/x/main.m3u8\n']) {
      if (body === null) probeFetch.mockImplementation(async () => { throw new TypeError('Load failed'); });
      else serve(body);
      const { v, c, deps } = setup();
      await airplayOn(v, c);
      c.videoError(4);
      await flush(); await flush();
      expect(v.src, String(body)).toBe(CI.contentUrl);
      expect(c.state.error).toBe(true);
      expect(deps.fail).toHaveBeenCalledOnce();
      c.destroy();
    }
  });

  it('only code 4 on a token stream: other codes and the normal stream keep the existing behaviour', async () => {
    serve();
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    c.videoError(3);
    await flush(); await flush();
    expect(v.src).toBe(CI.contentUrl);
    expect(c.state.error).toBe(true);
    expect(deps.fail).toHaveBeenCalledOnce();
    const b = setup();
    b.c.videoError(4); // not AirPlaying
    await flush();
    expect(b.v.src).toBe('blob:hlsjs');
    expect(probeFetch.mock.calls.filter((x) => x[0] === CI.contentUrl).length).toBeLessThanOrEqual(1); // only the token probe
  });

  it('AirPlay ends while the master is fetched: the variant is never put on the element', async () => {
    let release!: () => void;
    const { v, c, deps } = setup();
    await airplayOn(v, c);
    await flush();
    probeFetch.mockImplementation(() => new Promise<Response>((r) => { release = () => r(new Response(MASTER, { status: 200 })); }));
    c.videoError(4);
    c.destroy();
    release();
    await flush(); await flush();
    expect(v.src).toBe(CI.contentUrl);
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('logs the raw wireless flag on every video-error (w=)', async () => {
    const { v, c } = setup();
    c.pick();
    await flush();
    c.videoError(4);
    expect(readAirLog().find((e) => e.ev === 'video-error')?.note).toMatch(/^code 4 w=false/);
    const b = setup();
    delete (b.v as Partial<FakeVideo>).webkitCurrentPlaybackTargetIsWireless;
    Object.defineProperty(b.v, 'webkitCurrentPlaybackTargetIsWireless', { value: undefined });
    clearAirLog();
    b.c.videoError(2);
    expect(readAirLog().find((e) => e.ev === 'video-error')?.note).toBe('code 2 w=undefined');
    void v;
  });
});
