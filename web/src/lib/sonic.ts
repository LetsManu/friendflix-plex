/**
 * FriendFlix sonic logo, synthesized at runtime with the Web Audio API (no audio files).
 *
 * Shape (about 2.9 s): one soft low "bloom" swell (sub sine + light low-passed noise), a rising three-note
 * motif E4 -> B4 -> E5 on warm detuned pads under an opening filter, resolving into a shimmering open chord
 * (E3 B3 E4 B4 E5) that rings out for ~1.8 s. There is deliberately no two-hit pattern: a single swell, then a
 * melodic climb. Everything runs through a small feedback-delay "room" and a limiter.
 */

const NOTE = { E3: 164.81, B3: 246.94, E4: 329.63, B4: 493.88, E5: 659.25, B5: 987.77, E6: 1318.51 } as const;
const MASTER_LEVEL = 0.35;
/** seconds from the start until the last sound has faded */
export const SONIC_LENGTH = 2.95;

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
  wet.gain.value = 0.42;
  wet.connect(out);
  for (const [time, fb] of [[0.067, 0.5], [0.097, 0.46], [0.143, 0.42]] as const) {
    const delay = c.createDelay(0.5);
    delay.delayTime.value = time;
    const feedback = c.createGain();
    feedback.gain.value = fb;
    const damp = c.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2800;
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

  // 1. bloom: sub sine with a gentle pitch settle, an octave overtone for small speakers, a breath of low noise
  {
    const g = env(0.9, t0, 0.05, 1.2);
    const sub = osc('sine', 55);
    sub.frequency.setValueAtTime(64, t0);
    sub.frequency.exponentialRampToValueAtTime(55, t0 + 0.3);
    const over = osc('sine', 110);
    const og = c.createGain();
    og.gain.value = 0.22;
    sub.connect(g); over.connect(og); og.connect(g);
    g.connect(bus);
    sub.start(t0); sub.stop(t0 + 1.4); over.start(t0); over.stop(t0 + 1.4);

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 1.4);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(160, t0);
    lp.frequency.exponentialRampToValueAtTime(720, t0 + 0.9);
    const ng = env(0.16, t0 + 0.05, 0.4, 0.85);
    src.connect(lp); lp.connect(ng); ng.connect(bus); ng.connect(room);
    src.start(t0); src.stop(t0 + 1.4);
  }

  // 2. rising motif: soft detuned saw + triangle pads through one opening low-pass
  const padFilter = c.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.Q.value = 0.9;
  padFilter.frequency.setValueAtTime(380, t0 + 0.2);
  padFilter.frequency.exponentialRampToValueAtTime(4200, t0 + 1.5);
  const padOut = c.createGain();
  padOut.gain.value = 1;
  padFilter.connect(padOut);
  padOut.connect(bus);
  const padSend = c.createGain();
  padSend.gain.value = 0.55;
  padOut.connect(padSend);
  padSend.connect(room);

  const pad = (freq: number, at: number, attack: number, decay: number, peak: number) => {
    const g = env(peak, at, attack, decay);
    const a = osc('sawtooth', freq, -8);
    const b = osc('triangle', freq, 8);
    const ga = c.createGain(); ga.gain.value = 0.45;
    const gb = c.createGain(); gb.gain.value = 0.8;
    a.connect(ga); b.connect(gb); ga.connect(g); gb.connect(g);
    g.connect(padFilter);
    const end = at + attack + decay + 0.05;
    a.start(at); a.stop(end); b.start(at); b.stop(end);
  };
  pad(NOTE.E4, t0 + 0.36, 0.05, 0.5, 0.2);
  pad(NOTE.B4, t0 + 0.68, 0.05, 0.5, 0.2);
  pad(NOTE.E5, t0 + 1.0, 0.05, 0.55, 0.2);

  // 3. open chord (root + fifths) with a slow shimmer; rings out ~1.8 s
  {
    const at = t0 + 1.02;
    const chord = c.createGain();
    chord.gain.setValueAtTime(0.0001, at);
    chord.gain.exponentialRampToValueAtTime(1, at + 0.09);
    chord.gain.exponentialRampToValueAtTime(0.0001, at + 1.85);
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(5200, at);
    tone.frequency.exponentialRampToValueAtTime(1800, at + 1.8);
    chord.connect(tone);
    tone.connect(bus);
    const send = c.createGain();
    send.gain.value = 0.6;
    tone.connect(send);
    send.connect(room);

    const shimmer = osc('sine', 5.2); // tremolo LFO
    const depth = c.createGain();
    depth.gain.value = 0.18;
    const am = c.createGain();
    am.gain.value = 0.82;
    shimmer.connect(depth); depth.connect(am.gain);
    am.connect(chord);
    shimmer.start(at); shimmer.stop(at + 1.95);

    const voices: Array<[number, number]> = [[NOTE.E3, 0.2], [NOTE.B3, 0.12], [NOTE.E4, 0.13], [NOTE.B4, 0.1], [NOTE.E5, 0.08], [NOTE.B5, 0.035], [NOTE.E6, 0.02]];
    for (const [f, level] of voices) {
      for (const cents of [-6, 6]) {
        const o = osc(f < 400 ? 'triangle' : 'sine', f, cents);
        const vg = c.createGain();
        vg.gain.value = level;
        o.connect(vg); vg.connect(am);
        o.start(at); o.stop(at + 1.95);
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
