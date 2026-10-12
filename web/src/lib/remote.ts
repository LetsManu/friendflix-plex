import { get, writable } from 'svelte/store';

/** What the TV reports to the phone. */
export interface TvStatus { itemId?: string; title?: string; position?: number; duration?: number; paused?: boolean; audio?: Track[]; subs?: Track[]; audioSel?: number; subSel?: number }
export interface Track { i: number; t: string }
/** Commands the phone sends to the TV (the server validates the same shapes). */
export type ToTv =
  | { t: 'cast'; itemId: string; startSec?: number }
  | { t: 'ctl'; action: 'play' | 'pause' | 'toggle' | 'seekBy' | 'stop' | 'home' | 'next' | 'audio' | 'sub'; value?: number };

/** phone: is a TV of this user connected right now? */
export const tvOnline = writable(false);
/** phone: what the TV is currently doing (null = unknown / idle) */
export const tvStatus = writable<TvStatus | null>(null);
/** TV: written by the player, read by the heartbeat that reports to the phone */
export const nowPlaying = writable<TvStatus | null>(null);

interface Link { send(m: unknown): Promise<boolean>; sendNow(m: unknown): boolean; close(): void }

/**
 * WebSocket to the remote-control hub with automatic reconnect (1 s .. 15 s backoff).
 * It stops for good when the server says "unauthorized" (4401) or "replaced by another TV" (4000).
 */
function connect(role: 'tv' | 'remote', onMessage: (m: any) => void, onFatal?: (code: number) => void): Link {
  let ws: WebSocket | null = null, closed = false, delay = 1000, retry: ReturnType<typeof setTimeout> | undefined;
  const waiters: Array<() => void> = [];
  const open = () => {
    if (closed) return;
    const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/remote?role=${role}`);
    ws = s;
    s.onopen = () => { delay = 1000; waiters.splice(0).forEach((f) => f()); };
    s.onmessage = (e) => { try { onMessage(JSON.parse(String(e.data))); } catch { /* ignore garbage */ } };
    s.onclose = (e) => {
      if (ws === s) ws = null;
      if (closed) return;
      if (e.code === 4401 || e.code === 4000) { closed = true; onFatal?.(e.code); return; }
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  open();
  const sendNow = (m: unknown) => { if (ws?.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; };
  return {
    sendNow,
    send: (m) => new Promise<boolean>((resolve) => {
      if (sendNow(m)) return resolve(true);
      const give = setTimeout(() => { const i = waiters.indexOf(go); if (i >= 0) waiters.splice(i, 1); resolve(false); }, 4000);
      const go = () => { clearTimeout(give); resolve(sendNow(m)); };
      waiters.push(go);
    }),
    close: () => { closed = true; clearTimeout(retry); ws?.close(); ws = null; },
  };
}

// ---------------------------------------------------------------- phone side

let phone: Link | null = null, holds = 0, idle: ReturnType<typeof setTimeout> | undefined;
function onPhoneMessage(m: { t: string; tvOnline?: boolean } & TvStatus) {
  if (m.t === 'hello' || m.t === 'peers') { tvOnline.set(Boolean(m.tvOnline)); if (!m.tvOnline) tvStatus.set(null); }
  else if (m.t === 'status') { const { t: _t, ...s } = m; tvStatus.set(s); }
}
/** Keeps the phone's connection open until the returned function is called (then closes it after a short grace period). */
export function holdRemote(): () => void {
  clearTimeout(idle);
  phone ??= connect('remote', onPhoneMessage);
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holds > 0) return;
    idle = setTimeout(() => { if (holds === 0) { phone?.close(); phone = null; tvOnline.set(false); tvStatus.set(null); } }, 4000);
  };
}
/** Sends one command; opens the connection on demand. Resolves false when the TV hub could not be reached. */
export async function sendToTv(m: ToTv): Promise<boolean> {
  const release = holdRemote();
  const ok = await phone!.send(m);
  setTimeout(release, 3000);
  return ok;
}
export const castToTv = (itemId: string, startSec?: number) => sendToTv({ t: 'cast', itemId, startSec });

/** Cheap one-off check (no websocket) used on detail pages to decide whether to offer "play on TV". */
export async function refreshTvOnline(): Promise<boolean> {
  if (document.documentElement.classList.contains('tv')) return false; // the TV itself never offers "play on TV"
  try {
    const r = await fetch('/api/tv/status', { credentials: 'same-origin' });
    const on = r.ok && Boolean((await r.json()).tvOnline);
    tvOnline.set(on);
    return on;
  } catch { return false; }
}

// ---------------------------------------------------------------- TV side

/** only what the server's schema accepts (a NaN duration while loading would get the whole message dropped) */
function clean(s: TvStatus | null): TvStatus {
  const o: TvStatus = {};
  if (s?.itemId) o.itemId = s.itemId;
  if (s?.title) o.title = s.title.slice(0, 200);
  if (typeof s?.position === 'number' && Number.isFinite(s.position) && s.position >= 0) o.position = Math.floor(s.position);
  if (typeof s?.duration === 'number' && Number.isFinite(s.duration) && s.duration >= 0) o.duration = Math.floor(s.duration);
  if (typeof s?.paused === 'boolean') o.paused = s.paused;
  const tr = (l?: Track[], n = 10) => (l ?? []).slice(0, n).map((x) => ({ i: x.i, t: String(x.t).slice(0, 40) }));
  if (s?.audio?.length) { o.audio = tr(s.audio); if (s.audioSel !== undefined) o.audioSel = s.audioSel; }
  if (s?.subs?.length) { o.subs = tr(s.subs, 16); if (s.subSel !== undefined) o.subSel = s.subSel; }
  return o;
}

/**
 * The television connects as role "tv", executes casts/commands from the phone and reports what it plays
 * (every 2 s and immediately when play/pause or the title changes). Returns a stop function.
 */
export function startTvLink(onCommand: (m: ToTv) => void, onFatal: (code: number) => void): () => void {
  const link = connect('tv', (m) => { if (m?.t === 'cast' || m?.t === 'ctl') onCommand(m as ToTv); }, onFatal);
  const report = () => link.sendNow({ t: 'status', ...clean(get(nowPlaying)) });
  const timer = setInterval(report, 2000);
  let last = '';
  const unsub = nowPlaying.subscribe((s) => { const k = `${s?.itemId}|${s?.paused}|${s?.audioSel}|${s?.subSel}`; if (k !== last) { last = k; report(); } });
  return () => { clearInterval(timer); unsub(); link.close(); };
}
