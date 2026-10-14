// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AirPlay event log for diagnosis on the device (shown on /diagnose, "AirPlay-Protokoll"): a ring buffer of the last
 * AIRLOG_MAX controller events, kept in sessionStorage AND localStorage (the iOS home-screen app may reload or be killed).
 * Never stores URLs, tokens or cast ids: the element's src is only classified (token / cookie / blob / none / other) and
 * free text (event, note, state) is scrubbed of anything URL- or token-like.
 */
export type SrcKind = 'token' | 'cookie' | 'blob' | 'none' | 'other';

export interface AirLogEntry {
  /** ms since the first entry of this log */
  t: number;
  ev: string;
  wireless?: boolean;
  src: SrcKind;
  /** compact controller flags, e.g. `vART` */
  state: string;
  note?: string;
}

interface Stored { start: number; entries: AirLogEntry[] }

export const AIRLOG_KEY = 'ff.airplayLog';
export const AIRLOG_MAX = 80;
/** per-entry note cap: 160 for free text, NOTE_MAX_TRUSTED for notes the caller built from an allowlist (stream probe) */
export const NOTE_MAX = 160;
export const NOTE_MAX_TRUSTED = 600;

/** what the element plays, without the URL itself */
export function srcKind(src: string | null | undefined): SrcKind {
  if (!src) return 'none';
  if (src.startsWith('blob:')) return 'blob';
  if (src.includes('/media/c/')) return 'token';
  if (src.includes('/media/')) return 'cookie';
  return 'other';
}

/** no URLs, paths below /media/, blob URLs or long id-like strings (tokens, cast ids) */
const scrub = (s: string) => s
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
  .replace(/blob:\S*/gi, '[url]')
  .replace(/\/media\/\S*/g, '[url]')
  .replace(/[A-Za-z0-9_-]{20,}/g, '[id]')
  .slice(0, 160);

/** trusted notes (sanitized by the caller): URLs and long opaque strings still go, but tag names like EXT-X-INDEPENDENT-SEGMENTS survive */
const scrubTrusted = (s: string) => s
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
  .replace(/blob:\S*/gi, '[url]')
  .replace(/\/media\/\S*/g, '[url]')
  .replace(/[A-Za-z0-9_-]{32,}/g, '[id]')
  .slice(0, NOTE_MAX_TRUSTED);

let mem: Stored = { start: 0, entries: [] };

const stores = (): Storage[] => {
  const out: Storage[] = [];
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try { const s = (globalThis as Record<string, unknown>)[name] as Storage | undefined; if (s) out.push(s); } catch { /* blocked */ }
  }
  return out;
};

function valid(x: unknown): x is Stored {
  return Boolean(x) && typeof (x as Stored).start === 'number' && Array.isArray((x as Stored).entries);
}

function load(): Stored {
  for (const s of stores()) {
    try {
      const raw = s.getItem(AIRLOG_KEY);
      if (!raw) continue;
      const x: unknown = JSON.parse(raw);
      if (valid(x)) return x;
    } catch { /* garbage or blocked: next store */ }
  }
  return mem;
}

function save(x: Stored) {
  mem = x;
  const raw = JSON.stringify(x);
  for (const s of stores()) { try { s.setItem(AIRLOG_KEY, raw); } catch { /* quota / private mode */ } }
}

export function airLog(ev: string, o: { wireless?: boolean; src: string | null | undefined; state: string; note?: string; trusted?: boolean }) {
  try {
    const cur = load();
    const now = Date.now();
    const start = cur.entries.length ? cur.start : now;
    const e: AirLogEntry = { t: Math.max(0, now - start), ev: scrub(ev), src: srcKind(o.src), state: scrub(o.state) };
    if (o.wireless !== undefined) e.wireless = o.wireless;
    if (o.note) e.note = o.trusted ? scrubTrusted(o.note) : scrub(o.note);
    // property order as declared (t, ev, wireless?, src, state, note?)
    const ordered: AirLogEntry = { t: e.t, ev: e.ev, ...(e.wireless !== undefined ? { wireless: e.wireless } : {}), src: e.src, state: e.state, ...(e.note ? { note: e.note } : {}) };
    save({ start, entries: [...cur.entries, ordered].slice(-AIRLOG_MAX) });
  } catch { /* logging never breaks playback */ }
}

export function readAirLog(): AirLogEntry[] {
  try { return load().entries.slice(); } catch { return []; }
}

/** the start time (epoch ms) of the current log, 0 when empty */
export function airLogStart(): number {
  try { const x = load(); return x.entries.length ? x.start : 0; } catch { return 0; }
}

export function clearAirLog() {
  mem = { start: 0, entries: [] };
  for (const s of stores()) { try { s.removeItem(AIRLOG_KEY); } catch { /* blocked */ } }
}

/** one line per entry, for copying into a bug report */
export function formatAirLog(entries: AirLogEntry[], start = 0): string {
  const head = start ? [`AirPlay log, start ${new Date(start).toISOString()}`] : [];
  return [...head, ...entries.map((e) => [
    `+${(e.t / 1000).toFixed(3)}s`, e.ev, e.wireless === undefined ? '' : `w=${e.wireless ? 1 : 0}`, `src=${e.src}`, `state=${e.state || '-'}`, e.note ?? '',
  ].filter(Boolean).join(' '))].join('\n');
}
