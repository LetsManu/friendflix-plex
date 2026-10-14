// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Start-time measurement of one playback session (Player.svelte): ms since the start of loading until the playback info,
 * the (variant) playlist, the first media fragment and the first frame, plus seeks (seeking -> playing) and stalls (waiting
 * after the first frame). Sent once per session on stop / pagehide / end (POST /api/playback/timing, keepalive fetch with
 * the csrf header) and kept on this device (last TIMING_LOCAL_MAX, shown on /diagnose). Never throws, never blocks playback.
 */
export type Device = 'phone' | 'pc' | 'tv';
export type Mode = 'direct' | 'hls';

export interface TimingReport {
  device: Device;
  mode: Mode | null;
  /** this session only exists because of a quality switch: not a start */
  qualitySwitch: boolean;
  bitrate: number | null;
  targetDuration: number | null;
  infoMs: number | null;
  manifestMs: number | null;
  firstFragMs: number | null;
  firstFragBytes: number | null;
  firstFragDlMs: number | null;
  firstFrameMs: number | null;
  seeks: number;
  seekMedianMs: number | null;
  seekMaxMs: number | null;
  stalls: number;
  stallMs: number;
  effectiveType: string | null;
}
export interface StoredTiming extends TimingReport { at: number }

export const TIMING_ENDPOINT = '/api/playback/timing';
export const TIMING_LOCAL_KEY = 'ff.playTimings';
export const TIMING_LOCAL_MAX = 5;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const ms = (x: number) => Math.max(0, Math.round(x));

export function createTiming(now: () => number = () => performance.now()) {
  let t0 = 0, on = false, qualitySwitch = false, mode: Mode | null = null, bitrate: number | null = null, targetDuration: number | null = null;
  let infoAt: number | null = null, manifestAt: number | null = null, fragAt: number | null = null, frameAt: number | null = null;
  let fragBytes: number | null = null, fragDl: number | null = null;
  let seekAt: number | null = null, seeks: number[] = [], seekCount = 0, stallAt: number | null = null, stalls = 0, stallMs = 0;
  const rel = () => ms(now() - t0);
  const closeStall = () => { if (stallAt !== null) { stallMs += ms(now() - stallAt); stallAt = null; } };
  const frame = () => { if (on && frameAt === null) frameAt = rel(); };

  return {
    /** start of loading: a new session (`qualitySwitch` = a re-start for a quality change, never counted as a start) */
    begin(isSwitch = false) {
      t0 = now(); on = true; qualitySwitch = isSwitch; mode = null; bitrate = null; targetDuration = null;
      infoAt = manifestAt = fragAt = frameAt = fragBytes = fragDl = seekAt = stallAt = null; seeks = []; seekCount = 0; stalls = 0; stallMs = 0;
    },
    get active() { return on; },
    /** playback info received with the requested bitrate (first answer of the session only: a retry keeps the clock) */
    info(bps?: number) { if (on && infoAt === null) { infoAt = rel(); bitrate = bps && bps > 0 ? Math.round(bps) : null; } },
    mode(m: Mode) { if (on && mode === null) mode = m; },
    /** playlist loaded (hls.js LEVEL_LOADED, native: loadedmetadata); `target` = EXT-X-TARGETDURATION */
    manifest(target?: number) {
      if (!on || manifestAt !== null) return;
      manifestAt = rel();
      if (target && Number.isFinite(target) && target > 0) targetDuration = target;
    },
    /** first media fragment: its bytes and download ms */
    frag(bytes: number, dlMs: number) {
      if (!on || fragAt !== null) return;
      fragAt = rel(); fragBytes = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : null; fragDl = Number.isFinite(dlMs) ? ms(dlMs) : null;
    },
    /** loadeddata / playing */
    frame,
    /** before the first frame every waiting is part of the start; during a seek it belongs to the seek */
    waiting(seeking: boolean) {
      if (!on || frameAt === null || seeking || seekAt !== null || stallAt !== null) return;
      stallAt = now(); stalls++;
    },
    seeking() {
      if (!on || frameAt === null) return;
      closeStall(); // the viewer jumped out of a stall: it ends here
      if (seekAt === null) { seekAt = now(); seekCount++; }
    },
    /** a seek while paused ends at seeked (no playing follows) */
    seeked(paused: boolean) { if (on && paused && seekAt !== null) { seeks.push(ms(now() - seekAt)); seekAt = null; } },
    playing() {
      if (!on) return;
      frame();
      closeStall();
      if (seekAt !== null) { seeks.push(ms(now() - seekAt)); seekAt = null; }
    },
    /** ends the session: the report once (null when none runs or it was dropped) */
    finish(env: { device: Device; effectiveType?: string | null }): TimingReport | null {
      if (!on) return null;
      closeStall();
      on = false;
      const med = median(seeks);
      return {
        device: env.device, mode, qualitySwitch, bitrate, targetDuration, infoMs: infoAt, manifestMs: manifestAt, firstFragMs: fragAt,
        firstFragBytes: fragBytes, firstFragDlMs: fragDl, firstFrameMs: frameAt, seeks: seekCount, seekMedianMs: med === null ? null : ms(med),
        seekMaxMs: seeks.length ? Math.max(...seeks) : null, stalls, stallMs, effectiveType: env.effectiveType ?? null,
      };
    },
    /** party / cast / AirPlay: this session is not reported */
    drop() { on = false; },
  };
}
export type Timing = ReturnType<typeof createTiming>;

/** the app's device classes: TV mode wins, a coarse pointer is a phone (or tablet), the rest a pc */
export const deviceClass = (o: { coarse: boolean; tv: boolean }): Device => (o.tv ? 'tv' : o.coarse ? 'phone' : 'pc');

/** Network Information API (Chromium only; iOS Safari has none) */
export function effectiveType(nav: unknown): string | null {
  try {
    const t = (nav as { connection?: { effectiveType?: unknown } } | undefined)?.connection?.effectiveType;
    return typeof t === 'string' && t ? t.slice(0, 10) : null;
  } catch { return null; }
}

export interface TimingEnv {
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  csrf: string;
  profile?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
}

/** this device's last reports, newest first (empty when storage is blocked or broken) */
export function readLocalTimings(storage?: Pick<Storage, 'getItem'> | null): StoredTiming[] {
  try {
    const raw = (storage === undefined ? globalThis.localStorage : storage)?.getItem(TIMING_LOCAL_KEY);
    const a: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? (a.filter((x) => x && typeof x === 'object' && typeof x.at === 'number') as StoredTiming[]).slice(0, TIMING_LOCAL_MAX) : [];
  } catch { return []; }
}

/** keepalive fetch (survives the page unload; a beacon cannot carry the csrf header) + local copy; every error is swallowed */
export function sendTiming(r: TimingReport, env: TimingEnv): void {
  try {
    const storage = env.storage === undefined ? globalThis.localStorage : env.storage;
    storage?.setItem(TIMING_LOCAL_KEY, JSON.stringify([{ ...r, at: (env.now ?? Date.now)() }, ...readLocalTimings(storage)].slice(0, TIMING_LOCAL_MAX)));
  } catch { /* storage blocked / full */ }
  try {
    const f = env.fetch ?? globalThis.fetch;
    void f?.(TIMING_ENDPOINT, {
      method: 'POST', keepalive: true, credentials: 'same-origin', body: JSON.stringify(r),
      headers: { 'content-type': 'application/json', 'x-csrf-token': env.csrf, ...(env.profile ? { 'x-ff-profile': env.profile } : {}) },
    })?.catch?.(() => undefined);
  } catch { /* no fetch / refused */ }
}

/** one line per stored report for /diagnose (copyable text) */
export function formatTiming(s: StoredTiming): string {
  const v = (x: number | null, unit = 'ms') => (x === null ? '–' : `${x} ${unit}`);
  const kb = s.firstFragBytes === null ? '–' : `${Math.round(s.firstFragBytes / 1024)} KB`;
  return [
    `${new Date(s.at).toISOString().slice(0, 19).replace('T', ' ')} ${s.device} ${s.mode ?? '?'}${s.qualitySwitch ? ' (switch)' : ''}${s.bitrate ? ` ${Math.round(s.bitrate / 100_000) / 10} Mbit/s` : ''}${s.effectiveType ? ` ${s.effectiveType}` : ''}`,
    `  info ${v(s.infoMs)} · playlist ${v(s.manifestMs)} · 1st frag ${v(s.firstFragMs)} (${kb} in ${v(s.firstFragDlMs)}) · 1st frame ${v(s.firstFrameMs)}${s.targetDuration ? ` · segment ${s.targetDuration} s` : ''}`,
    `  seeks ${s.seeks} (median ${v(s.seekMedianMs)}, max ${v(s.seekMaxMs)}) · stalls ${s.stalls} (${v(s.stallMs)})`,
  ].join('\n');
}
