/**
 * "Klare Stimmen" / "Nachtmodus": Web Audio processing of the player's own <video> (never of the Chromecast receiver).
 *
 * - Clear voices: cut the rumble (low shelf), lift the speech band (~1–4 kHz) and a light compressor so the lifted dialogue
 *   does not clip.
 * - Night mode: a strong compressor (quiet parts up, explosions down), make-up gain and a hard limiter at the end.
 *
 * Caveats handled here: createMediaElementSource() can be called only once per element and from then on ALL its sound goes
 * through the AudioContext. So the graph is created only when the context really runs (a suspended context = silence), never for
 * cross-origin media without CORS (silence as well) and never for Safari's native HLS (WebKit delivers no samples there).
 * Switching both modes off keeps the routing but bypasses every node.
 */

export interface AudioFx { voice: boolean; night: boolean }
export const FX_OFF: AudioFx = { voice: false, night: false };
export const fxActive = (fx: AudioFx) => fx.voice || fx.night;

export type FxNode =
  | { kind: 'biquad'; type: BiquadFilterType; frequency: number; Q?: number; gain?: number }
  | { kind: 'compressor'; threshold: number; knee: number; ratio: number; attack: number; release: number }
  | { kind: 'gain'; gain: number };

/** the processing chain for a combination (data only; empty = bypass) */
export function fxPlan(fx: AudioFx): FxNode[] {
  const out: FxNode[] = [];
  if (fx.voice) {
    out.push(
      { kind: 'biquad', type: 'lowshelf', frequency: 180, gain: -4 },
      { kind: 'biquad', type: 'peaking', frequency: 2500, Q: 0.8, gain: 6 }, // ~1.4–4 kHz: consonants, intelligibility
      { kind: 'biquad', type: 'highshelf', frequency: 8000, gain: -2 },
      { kind: 'compressor', threshold: -24, knee: 12, ratio: 3, attack: 0.01, release: 0.25 },
    );
  }
  if (fx.night) {
    out.push(
      { kind: 'compressor', threshold: -42, knee: 18, ratio: 8, attack: 0.004, release: 0.3 },
      { kind: 'gain', gain: 2.2 }, // make-up: the quiet dialogue comes back up
      { kind: 'compressor', threshold: -4, knee: 0, ratio: 20, attack: 0.001, release: 0.1 }, // limiter
    );
  } else if (fx.voice) {
    out.push({ kind: 'gain', gain: 1.25 });
  }
  return out;
}

/** why the processing cannot run here (null = it can): casting, Safari native HLS, cross-origin media without CORS, no Web Audio */
export type FxBlock = 'casting' | 'unsupported' | null;
export function fxBlocked(o: { casting: boolean; nativeHls: boolean; src: string; crossOrigin: string | null; origin: string; hasWebAudio: boolean }): FxBlock {
  if (o.casting) return 'casting';
  if (!o.hasWebAudio || o.nativeHls) return 'unsupported';
  if (o.src && !o.src.startsWith('blob:')) {
    let origin: string;
    try { origin = new URL(o.src, o.origin).origin; } catch { return 'unsupported'; }
    if (origin !== o.origin && !o.crossOrigin) return 'unsupported';
  }
  return null;
}

// ---- remembered per profile: the server pref `audioFx` (follows the profile) + this localStorage copy for a fast start ----
export type FxPref = 'off' | 'voices' | 'night' | 'both';
export const fxFromPref = (p: unknown): AudioFx => ({ voice: p === 'voices' || p === 'both', night: p === 'night' || p === 'both' });
export const fxToPref = (fx: AudioFx): FxPref => (fx.voice && fx.night ? 'both' : fx.voice ? 'voices' : fx.night ? 'night' : 'off');
const KEY = 'ff_audiofx';
const keyFor = (profile: string | null | undefined) => `${KEY}:${profile || 'default'}`;
export function loadFx(profile: string | null | undefined): AudioFx {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(profile)) ?? 'null') as Partial<AudioFx> | null;
    return { voice: raw?.voice === true, night: raw?.night === true };
  } catch { return { ...FX_OFF }; }
}
export function saveFx(profile: string | null | undefined, fx: AudioFx): void {
  try { if (fxActive(fx)) localStorage.setItem(keyFor(profile), JSON.stringify(fx)); else localStorage.removeItem(keyFor(profile)); } catch { /* private mode: not remembered */ }
}

type Ctor = new () => AudioContext;
export type FxResult = 'ok' | 'off' | 'suspended' | 'unsupported';

/** Owns the AudioContext + graph of one <video>. apply() is safe to call any number of times. */
export class AudioFxEngine {
  private ctx: AudioContext | null = null;
  private src: MediaElementAudioSourceNode | null = null;
  private nodes: AudioNode[] = [];
  private dead = false;
  constructor(private readonly video: HTMLMediaElement, private readonly AC: Ctor | undefined = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext) : undefined) {}

  /** the element's sound already runs through Web Audio (it stays that way for the element's lifetime) */
  get routed() { return Boolean(this.src); }

  /**
   * Calls are serialised through one in-flight promise: two overlapping calls (a tap gesture + the play event) would otherwise both
   * pass the `!this.src` check while awaiting resume() and the second createMediaElementSource() would throw InvalidStateError.
   */
  apply(fx: AudioFx): Promise<FxResult> {
    const run = this.queue.then(() => this.applyNow(fx));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private queue: Promise<unknown> = Promise.resolve();

  private async applyNow(fx: AudioFx): Promise<FxResult> {
    if (this.dead) return 'unsupported';
    if (!fxActive(fx) && !this.src) return 'off'; // nothing to do, and no reason to take the sound over
    if (!this.src) {
      if (!this.AC) return 'unsupported';
      try { this.ctx ??= new this.AC(); } catch { return 'unsupported'; }
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* stays suspended */ } }
      if (this.dead || !this.ctx) return 'unsupported'; // destroyed while waiting
      if (this.ctx.state !== 'running') return 'suspended'; // no user gesture yet: routing now would mute the film
      if (!this.src) { // re-check after the await: belt and braces next to the queue
        try { this.src = this.ctx.createMediaElementSource(this.video); } catch {
          // the element is already captured: only "dead" when WE do not own a source (another engine / browser refuses);
          // with a source in hand the graph is live and must stay switchable (else FX could never be turned off again)
          if (!this.src) { this.dead = true; return 'unsupported'; }
        }
      }
    } else if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* tried */ }
    }
    if (this.dead || !this.ctx || !this.src) return 'unsupported';
    this.rebuild(fx);
    return fxActive(fx) ? 'ok' : 'off';
  }

  /** after a pause / tab switch some browsers suspend the context: wake it on play */
  resume(): void { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined); }

  private rebuild(fx: AudioFx) {
    const ctx = this.ctx!, src = this.src!;
    try { src.disconnect(); } catch { /* not connected */ }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    this.nodes = fxPlan(fx).map((p) => {
      if (p.kind === 'biquad') {
        const b = ctx.createBiquadFilter();
        b.type = p.type; b.frequency.value = p.frequency;
        if (p.Q !== undefined) b.Q.value = p.Q;
        if (p.gain !== undefined) b.gain.value = p.gain;
        return b;
      }
      if (p.kind === 'compressor') {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = p.threshold; c.knee.value = p.knee; c.ratio.value = p.ratio; c.attack.value = p.attack; c.release.value = p.release;
        return c;
      }
      const g = ctx.createGain();
      g.gain.value = p.gain;
      return g;
    });
    let prev: AudioNode = src;
    for (const n of this.nodes) { prev.connect(n); prev = n; }
    prev.connect(ctx.destination);
  }

  destroy(): void {
    this.dead = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    try { this.src?.disconnect(); } catch { /* ignore */ }
    this.ctx?.close().catch(() => undefined);
    this.ctx = null; this.src = null; this.nodes = [];
  }
}
