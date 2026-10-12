/**
 * FriendFlix sonic logo, synthesized at runtime with the Web Audio API (no audio files).
 *
 * Shape (about 3.4 s, in step with Intro.svelte): a slow, deep "bloom" swell (E1 sub sine with E2/B2 overtones so small
 * speakers still carry it, plus a breath of low-passed noise), a legato four-note minor climb E3 -> G3 -> B3 -> E4 on warm
 * detuned pads, a low open chord when the logo lands, then a short closing swell (E minor add9 saw stack under an opening
 * filter) that rises while the soft ring expands and fades out with the overlay. No separate hit, no whoosh, no two-note
 * pattern. Everything runs through a feedback-delay "room" and a limiter.
 */

const NOTE = { E1: 41.2, E2: 82.41, B2: 123.47, E3: 164.81, G3: 196.0, B3: 246.94, E4: 329.63, Fs4: 369.99, G4: 392.0, B4: 493.88 } as const;
const MASTER_LEVEL = 0.38;
/** seconds from the start until the last sound has faded */
export const SONIC_LENGTH = 3.4;

interface Running { master: GainNode; stops: OscillatorNode[]; endTimer: ReturnType<typeof setTimeout> }

let ctx: AudioContext | null = null;
let running: Running | null = null;

/** Lazily creates the AudioContext (needs a user gesture to run on most browsers). Never throws. */
function getContext(): AudioContext | null {
  try {
    if (ctx && ctx.state !== 'closed') return ctx;
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor({ latencyHint: 'interactive' });
    return ctx;
  } catch { return null; }
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Short feedback-delay room (no convolver): three parallel damped combs. Returns the input node. */
function buildRoom(c: AudioContext, out: AudioNode): GainNode {
  const input = c.createGain();
  const wet = c.createGain();
  wet.gain.value = 0.45;
  wet.connect(out);
  for (const [time, fb] of [[0.079, 0.55], [0.113, 0.5], [0.161, 0.46]] as const) {
    const delay = c.createDelay(0.5);
    delay.delayTime.value = time;
    const feedback = c.createGain();
    feedback.gain.value = fb;
    const damp = c.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2200;
    input.connect(delay);
    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);
    damp.connect(wet);
  }
  return input;
}

/** Builds and schedules the whole logo on `c`, starting now. */
function build(c: AudioContext): Running {
  const t0 = c.currentTime + 0.03;
  const stops: OscillatorNode[] = [];

  // output chain: bus -> limiter -> master -> speakers
  const master = c.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(MASTER_LEVEL, t0 + 0.04);
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 8;
  limiter.ratio.value = 14;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(master);
  master.connect(c.destination);
  const bus = c.createGain();
  bus.connect(limiter);
  const room = buildRoom(c, bus);

  const osc = (type: OscillatorType, freq: number, detune = 0) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    stops.push(o);
    return o;
  };
  const env = (peak: number, at: number, attack: number, decay: number) => {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    return g;
  };

  // 1. bloom: E1 sub sine settling from a little above, E2 / B2 overtones for small speakers, a breath of low noise
  {
    const g = env(0.85, t0, 0.28, 2.0);
    const sub = osc('sine', NOTE.E1);
    sub.frequency.setValueAtTime(49, t0);
    sub.frequency.exponentialRampToValueAtTime(NOTE.E1, t0 + 0.5);
    const over = osc('sine', NOTE.E2);
    const og = c.createGain();
    og.gain.value = 0.38;
    const fifth = osc('triangle', NOTE.B2);
    const fg = c.createGain();
    fg.gain.value = 0.1;
    sub.connect(g); over.connect(og); og.connect(g); fifth.connect(fg); fg.connect(g);
    g.connect(bus);
    for (const o of [sub, over, fifth]) { o.start(t0); o.stop(t0 + 2.3); }

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 2);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(110, t0);
    lp.frequency.exponentialRampToValueAtTime(480, t0 + 1.2);
    const ng = env(0.13, t0 + 0.05, 0.6, 1.2);
    src.connect(lp); lp.connect(ng); ng.connect(bus); ng.connect(room);
    src.start(t0); src.stop(t0 + 2);
  }

  // 2. legato minor climb: detuned saw + triangle pads with a sub-octave sine, through one slowly opening low-pass
  const padFilter = c.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.Q.value = 0.8;
  padFilter.frequency.setValueAtTime(260, t0 + 0.3);
  padFilter.frequency.exponentialRampToValueAtTime(2400, t0 + 1.6);
  const padOut = c.createGain();
  padOut.gain.value = 1;
  padFilter.connect(padOut);
  padOut.connect(bus);
  const padSend = c.createGain();
  padSend.gain.value = 0.6;
  padOut.connect(padSend);
  padSend.connect(room);

  const pad = (freq: number, at: number, attack: number, decay: number, peak: number) => {
    // sustained body before the tail (a plain exponential decay drops ~8 dB per 100 ms and makes the line step)
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(peak * 0.5, at + attack + decay * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    const a = osc('sawtooth', freq, -7);
    const b = osc('triangle', freq, 7);
    const s = osc('sine', freq / 2);
    const ga = c.createGain(); ga.gain.value = 0.4;
    const gb = c.createGain(); gb.gain.value = 0.8;
    const gs = c.createGain(); gs.gain.value = 0.45;
    a.connect(ga); b.connect(gb); s.connect(gs); ga.connect(g); gb.connect(g); gs.connect(g);
    g.connect(padFilter);
    const end = at + attack + decay + 0.05;
    for (const o of [a, b, s]) { o.start(at); o.stop(end); }
  };
  // each note rings into the next (decay > spacing), so the line glides instead of stepping
  pad(NOTE.E3, t0 + 0.4, 0.07, 0.95, 0.3);
  pad(NOTE.G3, t0 + 0.7, 0.07, 0.95, 0.31);
  pad(NOTE.B3, t0 + 1.0, 0.07, 0.9, 0.32);
  pad(NOTE.E4, t0 + 1.2, 0.08, 1.0, 0.24);

  // 3. the logo lands: low open chord (roots + fifths, no third) with a slow shimmer, handing over to the swell
  {
    const at = t0 + 1.2;
    const chord = c.createGain();
    chord.gain.setValueAtTime(0.0001, at);
    chord.gain.exponentialRampToValueAtTime(1, at + 0.14);
    chord.gain.exponentialRampToValueAtTime(0.45, at + 0.9); // long body first, then the tail under the swell
    chord.gain.exponentialRampToValueAtTime(0.0001, at + 2.2);
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(3200, at);
    tone.frequency.exponentialRampToValueAtTime(1100, at + 2.2);
    chord.connect(tone);
    tone.connect(bus);
    const send = c.createGain();
    send.gain.value = 0.65;
    tone.connect(send);
    send.connect(room);

    const shimmer = osc('sine', 3.8); // slow tremolo LFO
    const depth = c.createGain();
    depth.gain.value = 0.12;
    const am = c.createGain();
    am.gain.value = 0.88;
    shimmer.connect(depth); depth.connect(am.gain);
    am.connect(chord);
    shimmer.start(at); shimmer.stop(at + 2.35);

    const voices: Array<[number, number]> = [[NOTE.E2, 0.24], [NOTE.B2, 0.15], [NOTE.E3, 0.14], [NOTE.B3, 0.1], [NOTE.E4, 0.07], [NOTE.B4, 0.025]];
    for (const [f, level] of voices) {
      for (const cents of [-5, 5]) {
        const o = osc(f < 300 ? 'triangle' : 'sine', f, cents);
        const vg = c.createGain();
        vg.gain.value = level;
        o.connect(vg); vg.connect(am);
        o.start(at); o.stop(at + 2.35);
      }
    }
  }

  // 4. closing swell while the ring expands: E minor add9 saw stack, a short crescendo under an opening filter, then it fades with the overlay
  {
    const at = t0 + 1.5;
    const peakAt = t0 + 2.45;
    const end = t0 + SONIC_LENGTH;
    const swell = c.createGain();
    swell.gain.setValueAtTime(0.0001, at);
    swell.gain.exponentialRampToValueAtTime(0.5, at + 0.5);
    swell.gain.exponentialRampToValueAtTime(1, peakAt);
    swell.gain.exponentialRampToValueAtTime(0.0001, end);
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 1.1;
    tone.frequency.setValueAtTime(240, at);
    tone.frequency.exponentialRampToValueAtTime(2600, peakAt);
    tone.frequency.exponentialRampToValueAtTime(700, end);
    swell.connect(tone);
    tone.connect(bus);
    const send = c.createGain();
    send.gain.value = 0.7;
    tone.connect(send);
    send.connect(room);

    const voices: Array<[number, number]> = [[NOTE.E2, 0.34], [NOTE.B2, 0.26], [NOTE.E3, 0.22], [NOTE.G3, 0.18], [NOTE.B3, 0.15], [NOTE.Fs4, 0.09], [NOTE.G4, 0.07]];
    for (const [f, level] of voices) {
      for (const cents of [-9, 0, 9]) {
        const o = osc('sawtooth', f, cents);
        const vg = c.createGain();
        vg.gain.value = level / 3;
        o.connect(vg); vg.connect(swell);
        o.start(at); o.stop(end + 0.05);
      }
    }
  }

  const endTimer = setTimeout(() => { if (running?.master === master) cleanup(); }, (SONIC_LENGTH + 0.3) * 1000);
  return { master, stops, endTimer };
}

function cleanup() {
  if (!running) return;
  clearTimeout(running.endTimer);
  try { running.master.disconnect(); } catch { /* already gone */ }
  running = null;
}

/**
 * Starts the sonic logo. Resolves as soon as it is scheduled (it does not wait for the sound to end) and never
 * throws: no Web Audio, a blocked/suspended context or any runtime error simply means silence.
 */
export async function playSonicLogo(): Promise<void> {
  try {
    const c = getContext();
    if (!c) return;
    if (c.state === 'suspended') await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 250))]);
    if ((c.state as AudioContextState) !== 'running') return;
    if (running) void stopSonicLogo(40);
    running = build(c);
  } catch { running = null; }
}

/** Fades the sonic logo out (gain ramp, no click) and resolves once it is silent. Safe to call at any time. */
export function stopSonicLogo(fadeMs = 150): Promise<void> {
  const r = running;
  const c = ctx;
  if (!r || !c) return Promise.resolve();
  running = null;
  clearTimeout(r.endTimer);
  try {
    const now = c.currentTime;
    const g = r.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fadeMs / 1000);
    for (const o of r.stops) { try { o.stop(now + fadeMs / 1000 + 0.02); } catch { /* not started or already stopped */ } }
  } catch { /* ignore */ }
  return new Promise((res) => setTimeout(() => { try { r.master.disconnect(); } catch { /* ignore */ } res(); }, fadeMs + 30));
}
