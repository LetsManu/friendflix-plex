import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioFxEngine, fxBlocked, fxFromPref, fxPlan, fxToPref, loadFx, saveFx } from './audiofx';

/** minimal fake of the Web Audio API: records connections */
function fakeAC(opts: { startState?: AudioContextState; resumeWorks?: boolean; sourceThrows?: boolean; secondSourceThrows?: boolean } = {}) {
  const log: string[] = [];
  let made = 0, sources = 0;
  class Node { constructor(public name: string) {} connect(n: Node) { log.push(`${this.name}->${n.name}`); return n; } disconnect() { log.push(`x ${this.name}`); } }
  const param = () => ({ value: 0 });
  class Ctx {
    state: AudioContextState = opts.startState ?? 'running';
    destination = new Node('out');
    constructor() { made++; }
    async resume() { if (opts.resumeWorks !== false) this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaElementSource() { sources++; if (opts.sourceThrows || (opts.secondSourceThrows && sources > 1)) throw new Error('InvalidStateError'); return new Node('src'); }
    createBiquadFilter() { return Object.assign(new Node('bq'), { type: '', frequency: param(), Q: param(), gain: param() }); }
    createDynamicsCompressor() { return Object.assign(new Node('comp'), { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
    createGain() { return Object.assign(new Node('gain'), { gain: param() }); }
  }
  return { AC: Ctx as unknown as new () => AudioContext, log, made: () => made, sources: () => sources };
}
const video = {} as HTMLMediaElement;

describe('audio processing plans', () => {
  it('clear voices lifts the speech band and compresses lightly; night mode compresses hard, adds make-up gain and a limiter', () => {
    expect(fxPlan({ voice: false, night: false })).toEqual([]);
    const v = fxPlan({ voice: true, night: false });
    const peak = v.find((n) => n.kind === 'biquad' && n.type === 'peaking') as { frequency: number; gain: number };
    expect(peak.frequency).toBeGreaterThanOrEqual(1000); expect(peak.frequency).toBeLessThanOrEqual(4000); expect(peak.gain).toBeGreaterThan(0);
    expect(v.some((n) => n.kind === 'compressor' && n.ratio <= 4)).toBe(true);
    const n = fxPlan({ voice: false, night: true });
    expect(n.map((x) => x.kind)).toEqual(['compressor', 'gain', 'compressor']);
    expect((n[2] as { ratio: number }).ratio).toBeGreaterThanOrEqual(20); // limiter last
    expect(fxPlan({ voice: true, night: true }).at(-1)).toMatchObject({ kind: 'compressor', ratio: 20 });
  });
});

describe('fxBlocked', () => {
  const base = { casting: false, nativeHls: false, src: '/media/Videos/x/stream.mp4', crossOrigin: 'use-credentials', origin: 'https://ff.example', hasWebAudio: true };
  it('runs on same-origin and hls.js (blob:) media', () => {
    expect(fxBlocked(base)).toBeNull();
    expect(fxBlocked({ ...base, src: 'blob:https://ff.example/1', crossOrigin: null })).toBeNull();
  });
  it('not while casting, not on native HLS, not without Web Audio, not on cross-origin media without CORS', () => {
    expect(fxBlocked({ ...base, casting: true })).toBe('casting');
    expect(fxBlocked({ ...base, nativeHls: true })).toBe('unsupported');
    expect(fxBlocked({ ...base, hasWebAudio: false })).toBe('unsupported');
    expect(fxBlocked({ ...base, src: 'https://cdn.other/x.mp4', crossOrigin: null })).toBe('unsupported');
    expect(fxBlocked({ ...base, src: 'https://cdn.other/x.mp4' })).toBeNull(); // CORS requested
  });
});

describe('AudioFxEngine', () => {
  it('does not touch the element while everything is off', async () => {
    const f = fakeAC();
    const e = new AudioFxEngine(video, f.AC);
    expect(await e.apply({ voice: false, night: false })).toBe('off');
    expect(f.made()).toBe(0); expect(e.routed).toBe(false);
  });
  it('routes through the chain and bypasses it again when switched off', async () => {
    const f = fakeAC();
    const e = new AudioFxEngine(video, f.AC);
    expect(await e.apply({ voice: false, night: true })).toBe('ok');
    expect(f.log.filter((l) => l.includes('->'))).toEqual(['src->comp', 'comp->gain', 'gain->comp', 'comp->out']);
    f.log.length = 0;
    expect(await e.apply({ voice: false, night: false })).toBe('off');
    expect(f.log.filter((l) => l.includes('->'))).toEqual(['src->out']);
    expect(e.routed).toBe(true);
    expect(f.made()).toBe(1);
  });
  it('never routes into a suspended context (no gesture yet): the film would go silent', async () => {
    const f = fakeAC({ startState: 'suspended', resumeWorks: false });
    const e = new AudioFxEngine(video, f.AC);
    expect(await e.apply({ voice: true, night: false })).toBe('suspended');
    expect(e.routed).toBe(false);
    const ok = fakeAC({ startState: 'suspended' });
    expect(await new AudioFxEngine(video, ok.AC).apply({ voice: true, night: false })).toBe('ok'); // resume() on a gesture works
  });
  it('unsupported without Web Audio or when the element cannot be captured', async () => {
    expect(await new AudioFxEngine(video, undefined).apply({ voice: true, night: false })).toBe('unsupported');
    const f = fakeAC({ sourceThrows: true });
    const e = new AudioFxEngine(video, f.AC);
    expect(await e.apply({ voice: true, night: false })).toBe('unsupported');
    expect(await e.apply({ voice: true, night: false })).toBe('unsupported'); // and stays so
  });
  it('overlapping calls (tap gesture + play event) capture the element once and FX can still be switched off', async () => {
    // a suspended context: the first call awaits resume(), the second one would race past the `!src` check
    const f = fakeAC({ startState: 'suspended', secondSourceThrows: true });
    const e = new AudioFxEngine(video, f.AC);
    const [a, b] = await Promise.all([e.apply({ voice: true, night: false }), e.apply({ voice: true, night: false })]);
    expect([a, b]).toEqual(['ok', 'ok']);
    expect(f.sources()).toBe(1);
    expect(e.routed).toBe(true);
    f.log.length = 0;
    expect(await e.apply({ voice: false, night: false })).toBe('off');
    expect(f.log.filter((l) => l.includes('->'))).toEqual(['src->out']); // bypassed, not stuck on the chain
  });
});

describe('remembered per profile', () => {
  it('server pref <-> toggles round-trip; unknown values are off', () => {
    for (const p of ['off', 'voices', 'night', 'both'] as const) expect(fxToPref(fxFromPref(p))).toBe(p);
    expect(fxFromPref('both')).toEqual({ voice: true, night: true });
    expect(fxFromPref(undefined)).toEqual({ voice: false, night: false });
    expect(fxFromPref('loud')).toEqual({ voice: false, night: false });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('stores per profile and survives a broken storage', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    saveFx('p1', { voice: true, night: false });
    expect(loadFx('p1')).toEqual({ voice: true, night: false });
    expect(loadFx('p2')).toEqual({ voice: false, night: false });
    saveFx('p1', { voice: false, night: false });
    expect(localStorage.getItem('ff_audiofx:p1')).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } });
    expect(loadFx('p1')).toEqual({ voice: false, night: false });
    expect(() => saveFx('p1', { voice: true, night: true })).not.toThrow();
  });
});
