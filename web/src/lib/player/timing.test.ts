// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createTiming, deviceClass, effectiveType, formatTiming, readLocalTimings, sendTiming, TIMING_ENDPOINT, TIMING_LOCAL_KEY, TIMING_LOCAL_MAX, type TimingReport } from './timing';

const clock = () => { const c = { t: 1000, now: () => c.t, at: (ms: number) => { c.t = 1000 + ms; } }; return c; };
function fakeStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('createTiming', () => {
  it('records the phases relative to the start of loading (hls.js path)', () => {
    const c = clock(), t = createTiming(c.now);
    t.begin();
    expect(t.active).toBe(true);
    c.at(320); t.info(8_000_000);
    t.mode('hls');
    c.at(900); t.manifest(6);
    c.at(2600); t.frag(3_900_000.4, 1499.6);
    c.at(2700); t.frag(1, 1); // only the first fragment
    c.at(3100); t.frame();
    c.at(3300); t.playing(); // a second "first frame" does not move it
    const r = t.finish({ device: 'phone', effectiveType: '4g' })!;
    expect(r).toEqual({
      device: 'phone', mode: 'hls', qualitySwitch: false, bitrate: 8_000_000, targetDuration: 6, infoMs: 320, manifestMs: 900, firstFragMs: 2600,
      firstFragBytes: 3_900_000, firstFragDlMs: 1500, firstFrameMs: 3100, seeks: 0, seekMedianMs: null, seekMaxMs: null, stalls: 0, stallMs: 0, effectiveType: '4g',
    });
    expect(t.active).toBe(false);
    expect(t.finish({ device: 'phone' })).toBeNull(); // once per session
  });

  it('a retry keeps the clock and the first values; direct play has no playlist or fragment', () => {
    const c = clock(), t = createTiming(c.now);
    t.begin();
    c.at(200); t.info(0);
    c.at(5000); t.info(4_000_000); // second /info of the same session (retry)
    t.mode('direct'); t.mode('hls');
    c.at(5400); t.playing();
    expect(t.finish({ device: 'pc' })).toMatchObject({ mode: 'direct', bitrate: null, infoMs: 200, manifestMs: null, firstFragMs: null, firstFrameMs: 5400, effectiveType: null });
  });

  it('ignores calls outside a session, bad targetDuration and odd fragment stats', () => {
    const c = clock(), t = createTiming(c.now);
    t.info(1); t.mode('hls'); t.manifest(6); t.frag(1, 1); t.frame(); t.waiting(false); t.seeking(); t.seeked(true); t.playing();
    expect(t.finish({ device: 'tv' })).toBeNull();
    t.begin(true);
    c.at(100); t.manifest(Number.NaN);
    c.at(200); t.manifest(4); // only the first playlist
    t.frag(Number.NaN, Number.POSITIVE_INFINITY);
    expect(t.finish({ device: 'tv' })).toMatchObject({ qualitySwitch: true, manifestMs: 100, targetDuration: null, firstFragBytes: null, firstFragDlMs: null, mode: null });
  });

  it('stalls: only after the first frame, not during a seek, counted once until playing', () => {
    const c = clock(), t = createTiming(c.now);
    t.begin();
    c.at(100); t.waiting(false); // start buffering, part of the start
    c.at(500); t.frame();
    c.at(1000); t.waiting(false);
    c.at(1200); t.waiting(false); // same stall
    c.at(3000); t.playing();
    c.at(4000); t.waiting(true); // seeking flag: not a stall
    c.at(5000); t.waiting(false);
    c.at(5500); t.seeking(); // jumping out of a stall ends it (500 ms) and starts a seek
    c.at(5600); t.waiting(false); // during the seek
    c.at(6500); t.playing();
    c.at(7000); t.waiting(false); // open at the end: closed by finish
    c.at(7250);
    expect(t.finish({ device: 'phone' })).toMatchObject({ stalls: 3, stallMs: 2000 + 500 + 250, seeks: 1, seekMedianMs: 1000, seekMaxMs: 1000 });
  });

  it('seeks: seeking -> playing, or -> seeked while paused; median and max; seeks before the first frame do not count', () => {
    const c = clock(), t = createTiming(c.now);
    t.begin();
    t.seeking(); // the start position
    c.at(100); t.playing();
    c.at(1000); t.seeking(); c.at(1100); t.seeking(); c.at(1400); t.playing(); // 400 (a scrub = one seek)
    c.at(2000); t.seeking(); c.at(2100); t.seeked(false); c.at(4000); t.playing(); // 2000
    c.at(5000); t.seeking(); c.at(5300); t.seeked(true); // paused: 300
    c.at(6000); t.seeked(true); // nothing open
    c.at(7000); t.seeking(); c.at(7100); t.playing(); // 100
    c.at(8000); t.seeking(); // open at the end: counted, not timed
    expect(t.finish({ device: 'pc' })).toMatchObject({ seeks: 5, seekMedianMs: 350, seekMaxMs: 2000 });
  });

  it('begin resets a running session; drop discards it', () => {
    const c = clock(), t = createTiming(c.now);
    t.begin(); c.at(100); t.info(1); t.frame(); t.waiting(false);
    c.at(1000); t.begin(true);
    c.at(1300); t.frame();
    expect(t.finish({ device: 'pc' })).toMatchObject({ qualitySwitch: true, infoMs: null, firstFrameMs: 300, stalls: 0 });
    t.begin(); t.drop();
    expect(t.active).toBe(false);
    expect(t.finish({ device: 'pc' })).toBeNull();
  });

  it('uses performance.now by default', () => {
    const t = createTiming();
    t.begin(); t.frame();
    expect(t.finish({ device: 'pc' })!.firstFrameMs).toBeGreaterThanOrEqual(0);
  });
});

describe('helpers', () => {
  it('deviceClass: tv > coarse pointer > pc', () => {
    expect(deviceClass({ coarse: true, tv: true })).toBe('tv');
    expect(deviceClass({ coarse: true, tv: false })).toBe('phone');
    expect(deviceClass({ coarse: false, tv: false })).toBe('pc');
  });
  it('effectiveType reads navigator.connection when present', () => {
    expect(effectiveType({ connection: { effectiveType: '3g' } })).toBe('3g');
    expect(effectiveType({ connection: { effectiveType: '' } })).toBeNull();
    expect(effectiveType({ connection: { effectiveType: 3 } })).toBeNull();
    expect(effectiveType({})).toBeNull();
    expect(effectiveType(undefined)).toBeNull();
    expect(effectiveType({ get connection() { throw new Error('x'); } })).toBeNull();
  });
});

const report = (over: Partial<TimingReport> = {}): TimingReport => ({
  device: 'phone', mode: 'hls', qualitySwitch: false, bitrate: 8_000_000, targetDuration: 6, infoMs: 300, manifestMs: 700, firstFragMs: 2500, firstFragBytes: 4_096_000,
  firstFragDlMs: 1500, firstFrameMs: 3000, seeks: 2, seekMedianMs: 900, seekMaxMs: 1500, stalls: 1, stallMs: 2000, effectiveType: '4g', ...over,
});

describe('sendTiming / local copy', () => {
  it('posts a keepalive fetch with the csrf (and profile) header and keeps the last 5 locally, newest first', async () => {
    const st = fakeStorage(), fetch = vi.fn(async () => ({}));
    for (let i = 0; i < 7; i++) sendTiming(report({ infoMs: i }), { fetch, csrf: 'C', profile: 'P', storage: st, now: () => 1_700_000_000_000 + i });
    expect(fetch).toHaveBeenCalledTimes(7);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TIMING_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': 'C', 'x-ff-profile': 'P' } });
    expect(JSON.parse(init.body as string)).toEqual(report({ infoMs: 0 }));
    const local = readLocalTimings(st);
    expect(local).toHaveLength(TIMING_LOCAL_MAX);
    expect(local.map((x) => x.infoMs)).toEqual([6, 5, 4, 3, 2]);
    expect(local[0]!.at).toBe(1_700_000_000_006);
  });

  it('never throws: failing fetch, throwing fetch, blocked or broken storage', async () => {
    const reject = vi.fn(() => Promise.reject(new Error('offline')));
    expect(() => sendTiming(report(), { fetch: reject, csrf: '', storage: null })).not.toThrow();
    await Promise.resolve();
    const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => sendTiming(report(), { fetch: () => { throw new Error('x'); }, csrf: '', storage: boom })).not.toThrow();
    expect(readLocalTimings(boom)).toEqual([]);
    expect(readLocalTimings(null)).toEqual([]);
    const st = fakeStorage();
    st.m.set(TIMING_LOCAL_KEY, '{"no":"array"}'); expect(readLocalTimings(st)).toEqual([]);
    st.m.set(TIMING_LOCAL_KEY, 'not json'); expect(readLocalTimings(st)).toEqual([]);
    st.m.set(TIMING_LOCAL_KEY, JSON.stringify([null, { at: 'x' }, { ...report(), at: 5 }])); expect(readLocalTimings(st)).toHaveLength(1);
  });

  it('falls back to the global fetch and localStorage', () => {
    const st = fakeStorage(), fetch = vi.fn(async () => ({}));
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('localStorage', st);
    try {
      sendTiming(report(), { csrf: 'C' });
      expect(fetch).toHaveBeenCalledOnce();
      expect((fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers['x-ff-profile']).toBeUndefined();
      expect(readLocalTimings()).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('formatTiming: one readable block per report', () => {
    const s = formatTiming({ ...report(), at: Date.UTC(2026, 9, 14, 8, 30, 5) });
    expect(s).toContain('2026-10-14 08:30:05 phone hls 8 Mbit/s 4g');
    expect(s).toContain('1st frag 2500 ms (4000 KB in 1500 ms) · 1st frame 3000 ms · segment 6 s');
    expect(s).toContain('seeks 2 (median 900 ms, max 1500 ms) · stalls 1 (2000 ms)');
    const bare = formatTiming({ ...report({ mode: null, qualitySwitch: true, bitrate: null, effectiveType: null, targetDuration: null, firstFragBytes: null, infoMs: null }), at: 0 });
    expect(bare).toContain('phone ? (switch)\n');
    expect(bare).toContain('info – ·');
    expect(bare).toContain('(– in');
    expect(bare).not.toContain('segment');
  });
});
