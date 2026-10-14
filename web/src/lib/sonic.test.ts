// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** AudioParam double: keeps the plain value and every automation call. */
class Param {
  value = 0;
  calls: Array<[string, number, number]> = [];
  setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); this.value = v; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); }
  cancelScheduledValues(t: number) { this.calls.push(['cancel', 0, t]); }
}
/** Generic audio node double: carries every AudioParam the logo uses. */
class Node {
  kind: string;
  connections: unknown[] = [];
  disconnected = false;
  started?: number;
  stopped?: number;
  type = '';
  buffer: unknown = null;
  readonly gain = new Param(); readonly frequency = new Param(); readonly detune = new Param(); readonly Q = new Param(); readonly delayTime = new Param();
  readonly threshold = new Param(); readonly knee = new Param(); readonly ratio = new Param(); readonly attack = new Param(); readonly release = new Param();
  constructor(kind: string) { this.kind = kind; }
  connect(n: unknown) { this.connections.push(n); return n; }
  disconnect() { this.disconnected = true; }
  start(t = 0) { this.started = t; }
  stop(t = 0) { if (this.stopThrows) throw new Error('InvalidStateError'); this.stopped = t; }
  stopThrows = false;
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeTo: AudioContextState = 'running';
  static throwOnCreate = false;
  state: AudioContextState;
  currentTime = 10;
  sampleRate = 8000;
  destination = new Node('destination');
  nodes: Node[] = [];
  constructor(public opts: unknown) {
    if (FakeAudioContext.throwOnCreate) throw new Error('NotAllowedError');
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }
  static initialState: AudioContextState = 'running';
  resume = vi.fn(async () => { this.state = FakeAudioContext.resumeTo; });
  private mk(kind: string) { const n = new Node(kind); this.nodes.push(n); return n; }
  createGain() { return this.mk('gain'); }
  createOscillator() { return this.mk('osc'); }
  createBiquadFilter() { return this.mk('biquad'); }
  createDelay() { return this.mk('delay'); }
  createDynamicsCompressor() { return this.mk('compressor'); }
  createBufferSource() { return this.mk('buffer'); }
  createBuffer(_ch: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
}
const master = (c: FakeAudioContext) => c.nodes.find((n) => n.connections.includes(c.destination))!;

type Sonic = typeof import('./sonic');
let S: Sonic;
beforeEach(async () => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = 'running';
  FakeAudioContext.resumeTo = 'running';
  FakeAudioContext.throwOnCreate = false;
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  vi.resetModules();
  S = await import('./sonic');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('playSonicLogo', () => {
  it('schedules the whole logo through one master gain into the speakers, within SONIC_LENGTH', async () => {
    await S.playSonicLogo();
    const c = FakeAudioContext.instances[0]!;
    expect(c.opts).toEqual({ latencyHint: 'interactive' });
    const m = master(c);
    expect(m.kind).toBe('gain');
    // fade-in from silence (no click) to a level well below clipping
    expect(m.gain.calls[0]).toEqual(['set', 0, expect.closeTo(10.03, 5)]);
    expect(m.gain.calls[1]![1]).toBeLessThan(0.5);
    const oscs = c.nodes.filter((n) => n.kind === 'osc');
    expect(oscs.length).toBeGreaterThan(10);
    const t0 = 10.03;
    // every voice starts after t0 and is stopped before the cleanup timer disconnects the master (now + SONIC_LENGTH + 0.3 s)
    for (const o of oscs) {
      expect(o.started).toBeGreaterThanOrEqual(t0);
      expect(o.stopped).toBeLessThanOrEqual(10 + S.SONIC_LENGTH + 0.3);
    }
    // the noise "breath" is a filled buffer of values in [-1, 1]
    const src = c.nodes.find((n) => n.kind === 'buffer')!;
    expect(src.started).toBeGreaterThanOrEqual(t0);
  });

  it('cleans up (disconnects the master) shortly after the logo ended', async () => {
    await S.playSonicLogo();
    const m = master(FakeAudioContext.instances[0]!);
    vi.advanceTimersByTime((S.SONIC_LENGTH + 0.3) * 1000 - 1);
    expect(m.disconnected).toBe(false);
    vi.advanceTimersByTime(1);
    expect(m.disconnected).toBe(true);
  });

  it('reuses one AudioContext; a second start fades the running logo out first', async () => {
    await S.playSonicLogo();
    const c = FakeAudioContext.instances[0]!;
    const first = master(c);
    await S.playSonicLogo();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(first.gain.calls.some(([k, v]) => k === 'lin' && v === 0)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(first.disconnected).toBe(true);
  });

  it('resumes a suspended context; stays silent when it does not start running', async () => {
    FakeAudioContext.initialState = 'suspended';
    FakeAudioContext.resumeTo = 'suspended'; // autoplay policy: no user gesture yet
    await S.playSonicLogo();
    const c = FakeAudioContext.instances[0]!;
    expect(c.resume).toHaveBeenCalled();
    expect(c.nodes).toHaveLength(0);
    FakeAudioContext.resumeTo = 'running';
    await S.playSonicLogo();
    expect(c.nodes.length).toBeGreaterThan(0);
  });

  it('never throws: no Web Audio, a blocked constructor or the webkit prefix', async () => {
    vi.stubGlobal('window', {});
    await expect(S.playSonicLogo()).resolves.toBeUndefined();
    FakeAudioContext.throwOnCreate = true;
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    await expect(S.playSonicLogo()).resolves.toBeUndefined();
    FakeAudioContext.throwOnCreate = false;
    vi.stubGlobal('window', { webkitAudioContext: FakeAudioContext });
    await S.playSonicLogo();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('a closed context is replaced by a new one', async () => {
    await S.playSonicLogo();
    FakeAudioContext.instances[0]!.state = 'closed';
    await S.playSonicLogo();
    expect(FakeAudioContext.instances).toHaveLength(2);
  });
});

describe('stopSonicLogo', () => {
  it('is a no-op when nothing plays', async () => {
    await expect(S.stopSonicLogo()).resolves.toBeUndefined();
  });

  it('ramps the master to zero over the fade time, stops the oscillators, then disconnects', async () => {
    await S.playSonicLogo();
    const c = FakeAudioContext.instances[0]!;
    const m = master(c);
    c.nodes.find((n) => n.kind === 'osc')!.stopThrows = true; // an already stopped oscillator must not break the fade
    c.currentTime = 11;
    const done = S.stopSonicLogo(200);
    expect(m.gain.calls.slice(-3)).toEqual([['cancel', 0, 11], ['set', expect.any(Number), 11], ['lin', 0, 11.2]]);
    const oscs = c.nodes.filter((n) => n.kind === 'osc' && !n.stopThrows);
    expect(oscs.every((o) => o.stopped === 11 + 0.2 + 0.02)).toBe(true);
    expect(m.disconnected).toBe(false);
    vi.advanceTimersByTime(230);
    await done;
    expect(m.disconnected).toBe(true);
    // the end-of-logo timer was cleared: nothing else happens later
    await expect(S.stopSonicLogo()).resolves.toBeUndefined();
  });
});
