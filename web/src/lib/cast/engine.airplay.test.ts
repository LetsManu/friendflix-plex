// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get, writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, secToTicks, type Item } from '#lib/api';
import type { CastInfo } from '#lib/cast';
import { tr } from '#lib/i18n';
import { createAirPlay, SETTLE_MS, WIRELESS_EVENT, WIRELESS_OFF_GRACE_MS, type AirPlayTimers, type AirPlayVideo } from '#lib/player/airplay';
import { clearAirLog, readAirLog, srcKind } from '#lib/player/airplayLog';
import { DEFAULT_PREFS } from '#lib/stores';
import { CAST_VIDEO_ATTR, createCastEngine, ENDED_HIDE_MS, ENDED_IDLE_MS, PROGRESS_MS, type CastSession, type EngineDeps, type PlayerHandoff } from './engine';

const T0 = 1_000_000;
const ci = (castId: string, over: Partial<CastInfo> = {}): CastInfo => ({
  castId, expiresAt: T0 + 60 * 60_000, playSessionId: `ps-${castId}`, mediaSourceId: `ms-${castId}`, runtimeTicks: secToTicks(1800), startTime: 0,
  contentUrl: `/media/c/${castId}/master.m3u8`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'T', subtitles: [], ...over,
});
const items: Record<string, Partial<Item>> = {
  ep2: { id: 'ep2', name: 'Second', type: 'Episode', seriesId: 's1', seriesName: 'Bright Valley', indexNumber: 2, parentIndexNumber: 1 },
  film: { id: 'film', name: 'Film', type: 'Movie' },
  other: { id: 'other', name: 'Other', type: 'Movie' },
};

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** `document.body` stand-in: records the elements appended to it */
class FakeBody {
  children: FakeVideo[] = [];
  appendChild = vi.fn((el: FakeVideo) => { el.parent?.drop(el); el.parent = this; this.children.push(el); return el; });
  drop(el: FakeVideo) { this.children = this.children.filter((c) => c !== el); }
}
/** a <video> stand-in: media and AirPlay events are simulated by dispatching them */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = false;
  duration = Number.NaN;
  error: { code: number; message: string } | null = null;
  src = 'blob:hlsjs';
  parent: FakeBody | null = { drop: () => undefined } as unknown as FakeBody; // inside the Player's stage
  attrs = new Map<string, string>();
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  play = vi.fn(async () => { if (!this.paused) return; this.paused = false; this.fire('play'); });
  pause = vi.fn(() => { if (this.paused) return; this.paused = true; this.fire('pause'); });
  load = vi.fn();
  remove = vi.fn(() => { this.parent?.drop(this); this.parent = null; });
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); if (n === 'src') this.src = ''; }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  fire(type: string) { this.dispatchEvent(new Event(type)); }
  wireless(on: boolean) { this.webkitCurrentPlaybackTargetIsWireless = on; this.fire(WIRELESS_EVENT); }
}

/** the stream probe and the variant fallback fetch the token's playlists: 404 (no network in unit tests) */
const probeFetch = vi.fn(async (_u: string, _o?: unknown) => new Response('', { status: 404 }));
beforeEach(() => { probeFetch.mockClear(); vi.stubGlobal('fetch', probeFetch); });
afterEach(() => { vi.unstubAllGlobals(); clearAirLog(); });

/** fake deps (api, manual timers, a fake body) and an AirPlay controller playing on the TV, as the Player hands it over */
async function setup(o: { started?: boolean } = {}) {
  const calls: Array<{ path: string; init: { method?: string; body?: any; keepalive?: boolean } }> = [];
  const order: string[] = [];
  let n = 0;
  const posts: Array<() => Promise<CastInfo>> = [];
  const api = vi.fn(async (path: string, init: { method?: string; body?: any; keepalive?: boolean } = {}) => {
    calls.push({ path, init });
    order.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/cast/session') { const next = posts.shift(); return next ? next() : ci(`n${++n}`); }
    if (path === '/api/items/ep1/next') return { item: items.ep2 };
    return null;
  });
  let now = T0;
  let timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let tid = 0;
  const timerDeps = {
    set: vi.fn((fn: () => void, ms: number) => { const t = { fn, at: now + ms, id: ++tid }; timers.push(t); return t.id; }),
    clear: vi.fn((id: unknown) => { timers = timers.filter((t) => t.id !== id); }),
    now: () => now,
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
      await flush();
    }
    now = end;
  };
  const hides = new Set<() => void>();
  const toast = vi.fn();
  const body = new FakeBody();
  const deps: EngineDeps = {
    api: api as unknown as EngineDeps['api'],
    item: vi.fn(async (id: string) => { const it = items[id]; if (!it) throw new Error('404'); return it as Item; }),
    cast: { castState: writable({}), onCastEvent: vi.fn(), loadOnCast: vi.fn(), castPlayPause: vi.fn(), castSeek: vi.fn(), castStop: vi.fn(), castSetSubtitle: vi.fn() } as unknown as EngineDeps['cast'],
    air: vi.fn() as unknown as EngineDeps['air'],
    body: () => body as unknown as HTMLElement,
    onPageHide: vi.fn((fn: () => void) => { hides.add(fn); return () => { hides.delete(fn); }; }),
    toast, prefs: () => ({ ...DEFAULT_PREFS }), timers: timerDeps,
  };
  const out = writable<CastSession | null>(null);
  const engine = createCastEngine(deps, out);

  // the Player's side: tap on the AirPlay button (token a1 on the element), the TV picked, settle window over
  const video = new FakeVideo();
  const probe = new FakeVideo();
  video.currentTime = 60;
  const player = { request: vi.fn(async () => ci('a1')), revoke: vi.fn(), detach: vi.fn(), started: vi.fn(), restore: vi.fn(), fail: vi.fn(), change: vi.fn() };
  const air = createAirPlay(video as unknown as AirPlayVideo, player, probe, timerDeps as unknown as AirPlayTimers);
  air.pick();
  await flush();
  video.wireless(true);
  await advance(SETTLE_MS);
  expect(air.state).toMatchObject({ active: true, error: false });
  const spy = {
    rebind: vi.spyOn(air, 'rebind'), pick: vi.spyOn(air, 'pick'), retry: vi.spyOn(air, 'retry'), refresh: vi.spyOn(air, 'refresh'),
    switchItem: vi.spyOn(air, 'switchItem'), destroy: vi.spyOn(air, 'destroy'), videoError: vi.spyOn(air, 'videoError'),
  };
  const handoff: PlayerHandoff = {
    kind: 'airplay', itemId: 'film', title: 'Film', subtitle: '', isEpisode: false, position: 60, duration: 1800, paused: false,
    cast: air.info!, started: o.started ?? true, audioIndex: 1, subIndex: -1, maxBitrate: 8_000_000, sleepAfterEpisode: false,
    video: video as unknown as HTMLVideoElement, air, probe: probe as unknown as HTMLVideoElement,
  };
  const srcBefore = video.src;
  return {
    engine, out, deps, calls, order, posts, api, toast, hides, body, video, probe, air, player, spy, handoff, srcBefore,
    advance, pending: () => timers.length,
    adopt: async (over: Partial<PlayerHandoff> = {}) => { engine.adopt({ ...handoff, ...over }); await flush(); },
    reports: () => calls.filter((c) => c.path.startsWith('/api/playback/')).map((c) => c.path.slice('/api/playback/'.length)),
    deletes: () => calls.filter((c) => c.init.method === 'DELETE').map((c) => c.path.slice('/api/cast/session/'.length)),
    tokenPosts: () => calls.filter((c) => c.path === '/api/cast/session'),
    engineLog: () => readAirLog().filter((e) => e.ev === 'engine').map((e) => e.note),
  };
}
type Env = Awaited<ReturnType<typeof setup>>;
/** sustained route loss: wireless off for longer than the grace */
async function routeLost(env: Env) {
  env.video.wireless(false);
  await env.advance(WIRELESS_OFF_GRACE_MS);
}

describe('cast engine: AirPlay adopt', () => {
  it('adopt moves the element into body unchanged and rebinds the controller', async () => {
    const env = await setup();
    await env.adopt();
    expect(env.body.children).toEqual([env.video, env.probe]);
    expect(env.body.appendChild).toHaveBeenCalledTimes(2);
    expect(env.video.src).toBe(env.srcBefore);
    expect(srcKind(env.video.src)).toBe('token');
    expect(env.video.getAttribute(CAST_VIDEO_ATTR)).toBe('');
    expect(CAST_VIDEO_ATTR).toBe('data-cast-engine');
    for (const el of [env.video, env.probe]) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.getAttribute('style')).toBe('position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none');
    }
    expect(env.probe.getAttribute(CAST_VIDEO_ATTR)).toBeNull();
    expect(env.spy.rebind).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toMatchObject({ kind: 'airplay', device: tr('player.castBar.airplayDevice'), itemId: 'film', title: 'Film', state: 'playing', position: 60 });
    expect(get(env.engine.airState)).toMatchObject({ active: true, error: false });
    expect(env.engineLog()).toEqual(['adopt']);
    expect(env.calls).toEqual([]);
  });

  it('an AirPlay hand-off without element and controller is ignored', async () => {
    const env = await setup();
    env.engine.adopt({ ...env.handoff, video: undefined, air: undefined });
    expect(get(env.out)).toBeNull();
    expect(env.spy.rebind).not.toHaveBeenCalled();
  });

  it('start on the first playing after the token, progress on pause / play and every 10 s, element mirrored', async () => {
    const env = await setup({ started: false });
    await env.adopt();
    expect(get(env.out)?.state).toBe('connecting');
    env.video.duration = 1790;
    env.video.fire('durationchange');
    env.video.fire('waiting');
    expect(get(env.out)).toMatchObject({ buffering: true, duration: 1790, position: 60 });
    env.video.currentTime = 62;
    env.video.fire('playing');
    expect(env.reports()).toEqual(['start']);
    expect(env.calls[0]!.init.body).toEqual({ itemId: 'film', playSessionId: 'ps-a1', mediaSourceId: 'ms-a1', positionTicks: secToTicks(62), isPaused: false, audioIndex: 1, playMethod: 'Transcode' });
    expect(get(env.out)).toMatchObject({ state: 'playing', buffering: false, position: 62 });
    env.video.fire('playing');
    env.video.currentTime = 70;
    env.video.fire('timeupdate');
    expect(get(env.out)?.position).toBe(70);
    expect(env.reports()).toEqual(['start']);
    env.engine.playPause();
    expect(env.video.pause).toHaveBeenCalledTimes(1);
    expect(env.reports()).toEqual(['start', 'progress']);
    expect(env.calls[1]!.init.body).toMatchObject({ isPaused: true, positionTicks: secToTicks(70) });
    env.engine.playPause();
    expect(env.video.play).toHaveBeenCalled();
    expect(env.reports()).toEqual(['start', 'progress', 'progress']);
    await env.advance(PROGRESS_MS);
    expect(env.reports()).toEqual(['start', 'progress', 'progress', 'progress']);
    env.engine.seek(300);
    expect(env.video.currentTime).toBe(300);
    expect(get(env.out)?.position).toBe(300);
    expect(env.reports().at(-1)).toBe('progress');
    env.engine.skip(5000);
    expect(env.video.currentTime).toBe(1790);
    env.engine.setSubtitle(2); // the receiver only shows tracks inside the stream
    expect(env.deps.cast.castSetSubtitle).not.toHaveBeenCalled();
    expect(env.deps.cast.castSeek).not.toHaveBeenCalled();
    expect(env.deps.cast.castPlayPause).not.toHaveBeenCalled();
  });
});

describe('cast engine: AirPlay change device', () => {
  it('pick() opens the picker of the controller the engine owns, synchronously', async () => {
    const env = await setup();
    await env.adopt({ audioTracks: [{ index: 1, title: 'Deutsch', isDefault: true }, { index: 2, title: 'English', isDefault: false }] });
    const before = env.video.webkitShowPlaybackTargetPicker.mock.calls.length;
    env.engine.pick();
    expect(env.spy.pick).toHaveBeenCalledTimes(1);
    expect(env.video.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(before + 1);
    expect(get(env.out)?.audioTracks.map((a) => a.index)).toEqual([1, 2]);
  });

  it('pick() after the session ended does nothing', async () => {
    const env = await setup();
    await env.adopt();
    await env.engine.stop();
    env.engine.pick();
    expect(env.spy.pick).not.toHaveBeenCalled();
  });
});

describe('cast engine: AirPlay title switch', () => {
  it('airplay: switch sends stop for the old title and asks a token for the new item', async () => {
    const env = await setup();
    await env.adopt();
    await env.engine.playOnTv('ep2', 0);
    expect(env.order).toEqual(['POST /api/playback/stop', 'POST /api/cast/session', 'DELETE /api/cast/session/a1']);
    expect(env.tokenPosts()[0]!.init.body).toEqual({ itemId: 'ep2', startTicks: 0, audioIndex: undefined, maxBitrate: 8_000_000, via: 'airplay' });
    expect(env.spy.switchItem).toHaveBeenCalledWith(0);
    expect(env.video.src).toBe('/media/c/n1/master.m3u8');
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', isEpisode: true, state: 'connecting', position: 0 });
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-n1' });
    expect(get(env.out)?.state).toBe('playing');
    expect(env.engineLog()).toEqual(['adopt', 'switch']);
  });

  it('airplay: last switch wins', async () => {
    const env = await setup();
    await env.adopt();
    const first = deferred<CastInfo>(), second = deferred<CastInfo>();
    env.posts.push(() => first.promise, () => second.promise);
    const p1 = env.engine.playOnTv('ep2', 0);
    await flush();
    expect(env.tokenPosts()).toHaveLength(1);
    const p2 = env.engine.playOnTv('other', 30);
    await flush();
    first.resolve(ci('x1'));
    await flush();
    expect(env.video.src).toBe('/media/c/x1/master.m3u8');
    env.video.fire('playing'); // the loser plays briefly: no start for it
    expect(env.reports()).toEqual(['stop']);
    expect(get(env.out)?.itemId).toBe('other');
    second.resolve(ci('n1'));
    await Promise.all([p1, p2]);
    expect(env.tokenPosts().map((c) => c.init.body.itemId)).toEqual(['ep2', 'other']);
    expect(env.tokenPosts()[1]!.init.body.startTicks).toBe(secToTicks(30));
    expect(env.deletes()).toEqual(['a1', 'x1']);
    expect(env.air.info?.castId).toBe('n1');
    expect(get(env.out)).toMatchObject({ itemId: 'other', title: 'Other', state: 'connecting' });
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'other', playSessionId: 'ps-n1' });
  });

  it('a failed switch: player toast, reconnect, no retry; a tap retries once', async () => {
    const env = await setup();
    await env.adopt();
    env.posts.push(() => Promise.reject(new ApiError(429, { error: 'max_streams', max: 2 })));
    await env.engine.playOnTv('ep2', 120);
    expect(env.toast).toHaveBeenCalledWith('error', tr('player.error.maxStreams', { n: 2 }));
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'reconnect', buffering: false, paused: true });
    // the old title's stop was reported: its token must not keep playing unreported on the TV
    expect(env.video.pause).toHaveBeenCalled();
    expect(env.video.paused).toBe(true);
    await env.advance(5 * 60_000);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.deletes()).toEqual([]);
    env.engine.reconnect();
    expect(env.spy.retry).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
    expect(env.tokenPosts()[1]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: secToTicks(120) });
    expect(env.deletes()).toEqual(['a1']);
    env.video.fire('playing');
    expect(get(env.out)).toMatchObject({ state: 'playing', itemId: 'ep2' });
    expect(env.reports()).toEqual(['stop', 'start']);
  });

  it('item metadata that cannot be loaded falls back to the cast info', async () => {
    const env = await setup();
    await env.adopt();
    env.posts.push(async () => ci('n9', { title: 'Pilot', seriesName: 'Show' }));
    await env.engine.playOnTv('gone', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'gone', title: 'Show', subtitle: 'Pilot', posterId: 'gone', isEpisode: true });
  });

  it('a switch the controller does not take (busy elsewhere) leaves reconnect', async () => {
    const env = await setup();
    await env.adopt();
    env.spy.switchItem.mockResolvedValueOnce(undefined);
    await env.engine.playOnTv('ep2', 0);
    expect(env.tokenPosts()).toHaveLength(0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'reconnect', buffering: false });
  });

  it('a switch the controller does not take pauses the old title (its stop is reported)', async () => {
    const env = await setup();
    await env.adopt();
    expect(env.video.paused).toBe(false);
    env.spy.switchItem.mockResolvedValueOnce(undefined);
    await env.engine.playOnTv('ep2', 0);
    expect(env.reports()).toEqual(['stop']);
    expect(env.video.pause).toHaveBeenCalled();
    expect(env.video.paused).toBe(true);
    expect(get(env.out)).toMatchObject({ state: 'reconnect', paused: true });
  });

  it('tap after a switch the controller did not take loads the remembered title', async () => {
    const env = await setup();
    await env.adopt();
    env.spy.switchItem.mockResolvedValueOnce(undefined);
    await env.engine.playOnTv('ep2', 0);
    expect(get(env.out)?.state).toBe('reconnect');
    env.engine.reconnect();
    expect(env.spy.switchItem).toHaveBeenCalledTimes(2);
    await flush();
    expect(env.tokenPosts().map((c) => c.init.body.itemId)).toEqual(['ep2']);
    expect(env.video.src).toBe('/media/c/n1/master.m3u8');
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-n1' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'playing' });
  });

  it('the same hand-off again keeps the element and the token', async () => {
    const env = await setup();
    await env.adopt();
    await env.adopt();
    expect(env.spy.destroy).not.toHaveBeenCalled();
    expect(env.calls).toEqual([]);
    expect(env.body.children).toEqual([env.video, env.probe]);
    expect(env.spy.rebind).toHaveBeenCalledTimes(2);
    expect(get(env.out)).toMatchObject({ kind: 'airplay', state: 'playing' });
  });

  it('other token errors use the AirPlay texts', async () => {
    const env = await setup();
    await env.adopt();
    env.posts.push(() => Promise.reject(new ApiError(403, { error: 'transcoding_disabled' })));
    await env.engine.playOnTv('ep2', 0);
    expect(env.toast).toHaveBeenLastCalledWith('error', tr('player.airplay.needsTranscode'));
  });

  it('refresh(): a new token for the same title with the new audio track', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 400;
    env.video.fire('timeupdate');
    await env.engine.refresh({ audioIndex: 3 });
    expect(env.spy.refresh).toHaveBeenCalledTimes(1);
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'film', audioIndex: 3, startTicks: secToTicks(400), via: 'airplay' });
    expect(env.deletes()).toEqual(['a1']);
    expect(get(env.out)?.title).toBe('Film');
  });

  it('a new token for the same title (audio switch) keeps the hand-off\'s subtitle list; another title takes its token\'s', async () => {
    const env = await setup();
    const subs = [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }];
    await env.adopt({ subtitles: subs });
    env.posts.push(async () => ci('r1', { subtitles: [] }));
    await env.engine.refresh({ audioIndex: 2 });
    expect(get(env.out)).toMatchObject({ subtitles: subs, audioIndex: 2 });
    env.posts.push(async () => ci('o1', { subtitles: [{ index: 7, title: 'English', language: 'eng', url: '/media/c/o1/7.vtt' }] }));
    await env.engine.playOnTv('other', 0);
    expect(get(env.out)?.subtitles).toEqual([{ index: 7, title: 'English', language: 'eng' }]);
  });

  it('a renewal keeps a paused TV paused', async () => {
    const env = await setup();
    env.posts.push(async () => ci('r1', { expiresAt: T0 + 9 * 60 * 60_000 }));
    await env.adopt({ cast: { ...env.air.info!, expiresAt: T0 + 5 * 60_000 } });
    env.engine.playPause();
    expect(env.video.paused).toBe(true);
    env.video.play.mockClear();
    await env.advance(PROGRESS_MS);
    expect(env.air.info?.castId).toBe('r1');
    expect(env.video.play).not.toHaveBeenCalled();
    expect(get(env.out)).toMatchObject({ state: 'playing', paused: true, buffering: false });
    const start = env.calls.filter((c) => c.path === '/api/playback/start').at(-1)!;
    expect(start.init.body).toMatchObject({ playSessionId: 'ps-r1', isPaused: true });
    env.engine.playPause(); // the bar's play button drives the new token
    expect(env.video.play).toHaveBeenCalledTimes(1);
  });

  it('renews the token before it expires', async () => {
    const env = await setup();
    env.posts.push(async () => ci('r1', { expiresAt: T0 + 9 * 60 * 60_000 }));
    await env.adopt({ cast: { ...env.air.info!, expiresAt: T0 + 5 * 60_000 } });
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.air.info?.castId).toBe('r1');
  });
});

describe('cast engine: AirPlay route loss and reconnect', () => {
  it('sustained route loss -> reconnect, paused, no cookie URL', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 300;
    env.video.fire('timeupdate');
    await routeLost(env);
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(300));
    expect(env.deletes()).toEqual(['a1']);
    expect(env.video.pause).toHaveBeenCalled();
    expect(srcKind(env.video.src)).not.toBe('cookie');
    expect(env.player.restore).not.toHaveBeenCalled();
    expect(get(env.out)).toMatchObject({ state: 'reconnect', position: 300, paused: true, buffering: false });
    expect(env.engineLog()).toEqual(['adopt', 'reconnect: route lost']);
  });

  it('reconnect() calls pick synchronously and resumes on active', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 300;
    env.video.fire('timeupdate');
    await routeLost(env);
    env.engine.reconnect();
    expect(env.spy.pick).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'film', startTicks: secToTicks(300), via: 'airplay' });
    expect(get(env.engine.airState)).toMatchObject({ ready: true, active: false });
    const pickerCalls = env.video.webkitShowPlaybackTargetPicker.mock.calls.length;
    env.engine.reconnect(); // the bar's second tap: the picker opens inside this gesture
    expect(env.video.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(pickerCalls + 1);
    expect(env.tokenPosts()).toHaveLength(1);
    const plays = env.video.play.mock.calls.length;
    env.video.wireless(true);
    expect(env.video.play).toHaveBeenCalledTimes(plays + 1);
    expect(get(env.out)?.state).toBe('connecting');
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ playSessionId: 'ps-n1' });
    expect(get(env.out)?.state).toBe('playing');
    expect(env.engineLog()).toEqual(['adopt', 'reconnect: route lost', 'reconnect: tap', 'reconnect: tap']);
  });

  it('reconnect() outside the reconnect state does nothing', async () => {
    const env = await setup();
    await env.adopt();
    env.engine.reconnect();
    expect(env.spy.pick).not.toHaveBeenCalled();
    expect(env.spy.retry).not.toHaveBeenCalled();
  });

  it('playOnTv without the route: reconnect, the item is remembered and loaded (server resume) on the tap', async () => {
    const env = await setup();
    await env.adopt();
    await routeLost(env);
    await env.engine.playOnTv('ep2');
    expect(env.tokenPosts()).toHaveLength(0);
    expect(env.spy.switchItem).not.toHaveBeenCalled();
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', state: 'reconnect' });
    env.posts.push(async () => ci('r1', { startTime: 754 }));
    env.engine.reconnect();
    expect(env.spy.pick).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: undefined, via: 'airplay' });
    expect(get(env.out)?.position).toBe(754);
    env.video.fire('loadedmetadata');
    expect(env.video.currentTime).toBe(754);
  });

  it('playOnTv during ready: the TV gets the new title once it is picked', async () => {
    const env = await setup();
    await env.adopt();
    await routeLost(env);
    env.engine.reconnect();
    await flush();
    expect(get(env.engine.airState)).toMatchObject({ ready: true, active: false });
    await env.engine.playOnTv('ep2', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'reconnect' });
    env.engine.reconnect(); // picker (ready)
    env.video.wireless(true); // the TV is picked: it first gets the ready token (film)
    await flush();
    expect(env.tokenPosts().map((c) => c.init.body.itemId)).toEqual(['film', 'ep2']);
    expect(env.video.src).toBe('/media/c/n2/master.m3u8');
    expect(env.deletes()).toEqual(['a1', 'n1']);
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-n2' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'playing' });
  });

  it('a route loss after the end changes nothing', async () => {
    const env = await setup();
    await env.adopt();
    env.video.fire('ended');
    await routeLost(env);
    expect(get(env.out)?.state).toBe('ended');
  });
});

describe('cast engine: AirPlay end and stop', () => {
  it('stop(): controller destroyed, src removed, element removed, null', async () => {
    const env = await setup();
    await env.adopt();
    await env.engine.stop();
    expect(env.reports()).toEqual(['stop']);
    expect(env.spy.destroy).toHaveBeenCalledTimes(1);
    expect(env.deletes()).toEqual(['a1']);
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/a1']);
    expect(env.video.getAttribute('src')).toBeNull();
    expect(env.video.src).toBe('');
    expect(env.video.load).toHaveBeenCalledTimes(1);
    expect(env.body.children).toEqual([]);
    expect(env.video.remove).toHaveBeenCalled();
    expect(env.probe.remove).toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
    expect(get(env.engine.airState)).toBeNull();
    expect(env.pending()).toBe(0);
    expect(env.engineLog()).toEqual(['adopt', 'stop']);
    env.video.fire('playing');
    env.video.fire('pause');
    expect(env.reports()).toEqual(['stop']);
  });

  it('stop() while a switch waits for its token: the new token is revoked, no start', async () => {
    const env = await setup();
    await env.adopt();
    const late = deferred<CastInfo>();
    env.posts.push(() => late.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    await env.engine.stop();
    late.resolve(ci('x1'));
    await p;
    await flush();
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['a1', 'x1']);
    expect(get(env.out)).toBeNull();
  });

  it('ended element: stop report once', async () => {
    const env = await setup();
    await env.adopt();
    env.video.fire('ended');
    env.video.fire('ended');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(1800));
    expect(get(env.out)).toMatchObject({ state: 'ended', position: 1800 });
    expect(env.deletes()).toEqual(['a1']); // revoked at the end, after its stop
    expect(env.order.slice(0, 2)).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/a1']);
    await env.advance(ENDED_HIDE_MS);
    expect(get(env.out)).toBeNull();
    expect(env.deletes()).toEqual(['a1']); // not a second time when the controller goes
    expect(env.body.children).toEqual([]);
    expect(env.reports()).toEqual(['stop']);
  });

  it('episode end: the next episode follows on the same element after the countdown', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.fire('ended');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2', label: 'S1:E2 · Second' } });
    expect(get(env.out)?.next?.startsAt).not.toBeNull();
    await env.advance(10_000);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2', via: 'airplay' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
    expect(env.body.children).toContain(env.video);
  });

  it('cancelled next episode: token revoked at the end, session closed after ENDED_IDLE_MS, no second stop or revoke', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.fire('ended');
    await flush();
    expect(env.deletes()).toEqual(['a1']);
    env.engine.cancelNext();
    await env.advance(ENDED_IDLE_MS - 1);
    expect(get(env.out)?.state).toBe('ended');
    await env.advance(1);
    expect(get(env.out)).toBeNull();
    expect(env.body.children).toEqual([]);
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['a1']);
  });

  it('next() after a cancelled countdown: the ended token is not revoked again', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.fire('ended');
    await flush();
    env.engine.cancelNext();
    await env.engine.next();
    await flush();
    expect(env.air.info?.castId).toBe('n1');
    expect(env.deletes()).toEqual(['a1']);
  });

  it('a title switch after the end keeps the element', async () => {
    const env = await setup();
    await env.adopt();
    env.video.fire('ended');
    await env.engine.playOnTv('ep2', 0);
    await env.advance(ENDED_HIDE_MS);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
    expect(env.body.children).toContain(env.video);
  });

  it('airplay pagehide: keepalive stop and token revoked', async () => {
    const env = await setup();
    await env.adopt();
    env.hides.forEach((fn) => fn());
    expect(env.calls.map((c) => [c.init.method, c.path, c.init.keepalive])).toEqual([
      ['POST', '/api/playback/stop', true], ['DELETE', '/api/cast/session/a1', true],
    ]);
    expect(env.spy.destroy).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    expect(env.hides.size).toBe(0);
  });

  it('variant fallback failed on the TV: failed toast, failed state; release() drops the element', async () => {
    const env = await setup();
    await env.adopt();
    env.video.error = { code: 1, message: '' };
    env.video.fire('error'); // aborted: not a failure
    expect(env.spy.videoError).not.toHaveBeenCalled();
    env.video.error = { code: 4, message: '' };
    env.video.fire('error');
    expect(env.spy.videoError).toHaveBeenCalledWith(4, '');
    await flush();
    expect(env.toast).toHaveBeenCalledWith('error', tr('player.castBar.failed', { title: 'Film', device: tr('player.castBar.airplayDevice') }));
    expect(get(env.out)).toMatchObject({ state: 'failed' });
    expect(env.reports()).toEqual(['stop']);
    env.engine.release();
    expect(get(env.out)).toBeNull();
    expect(env.body.children).toEqual([]);
    await flush();
    expect(env.deletes()).toEqual(['a1']);
  });

  it('a Chromecast hand-off replaces the AirPlay session and drops its element', async () => {
    const env = await setup();
    await env.adopt();
    env.engine.adopt({ ...env.handoff, kind: 'chromecast', cast: ci('c9'), video: undefined, air: undefined, probe: undefined });
    await flush();
    expect(env.body.children).toEqual([]);
    expect(env.spy.destroy).toHaveBeenCalledTimes(1);
    expect(env.deletes()).toEqual(['a1']);
    expect(get(env.out)).toMatchObject({ kind: 'chromecast' });
  });
});
