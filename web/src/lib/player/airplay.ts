// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AirPlay (Safari on iOS / iPadOS / macOS) for the player's own <video> element.
 *
 * Safari's AirPlay "video URL" mode hands the element's CURRENT media URL to the receiver (Apple TV, AirPlay 2 TVs such as LG
 * webOS 2019+), which then fetches the playlist and segments ITSELF, without the user's cookies. The player's normal stream is
 * either hls.js (MSE: no URL at all) or a cookie URL (/media/...: the gateway answers the TV with 401). Handing the TV either one
 * fails silently: the TV stays on its AirPlay placeholder, Safari never reports a wireless video target, the phone spins.
 * So: **the TV is never handed a URL it cannot load. The element already holds a cast token URL when the picker is used.**
 *
 * Flow ("token first"):
 * - Tap on OUR button (not AirPlaying): `busy` -> report the local stop and drop hls.js (`detach`), ask for a short-lived, scoped
 *   cast token (POST /api/cast/session, `via: 'airplay'`), put its URL on the element at the same position / play state (the phone
 *   plays the token stream itself meanwhile), THEN open `webkitShowPlaybackTargetPicker()`. After an await WebKit may no longer
 *   treat this as a user gesture and silently not open the picker, so the state turns `ready` and the player shows a prompt whose
 *   button (like another tap on the AirPlay button) opens the picker synchronously from a fresh gesture.
 * - Safari reports the wireless target while OUR token is on the element (tracked in `tokenOnElement`, set when we assign the
 *   token URL, cleared on restore; no URL comparison, Safari may report a normalised src) -> `active`, nothing is requested.
 * - No wireless target within ARM_MS while `ready`, or a playback error on the phone meanwhile: the token is revoked and the
 *   normal stream (hls.js) returns at the position (`restore`). A failed token request while the route is local (not wireless,
 *   not `ready`): toast + normal stream.
 *
 * No request loops (field bug: iPhone PWA -> LG, 314 POSTs / 294 x 429 in 30 min). WebKit resets the wireless route state when
 * `src` changes (WebKit bug 158226) and reports the still picked route again right after. Reacting to every flip made a loop
 * (off -> restore = src change -> on without token -> new token = src change -> off -> ...). Therefore:
 * - Wireless events within SETTLE_MS after OUR src change (token URL, or the restore) are ignored, except "on" while our token
 *   is on the element (harmless: no request, no src change); when the window ends the actual property is evaluated once.
 * - Wireless off while active only starts a grace timer (WIRELESS_OFF_GRACE_MS): on again in time -> nothing happens. Only a
 *   sustained off ends AirPlay (`stop`: revoke + restore, as before).
 * - Token requests come from a tap (pick / retry / ready prompt), an explicit refresh (audio track, quality, renewal), or at most
 *   ONE automatic request per wireless episode (route chosen outside our button, e.g. Control Center). The episode only ends when
 *   the route is really off after the restore settled. A client breaker allows at most AUTO_MAX automatic requests per
 *   AUTO_WINDOW_MS. Beyond either limit: `error` state with Retry, no request.
 * - A failed token request (e.g. 429) while the route is wireless or `ready` never calls restore (no src change): `error` state
 *   with Retry plus the hint to end AirPlay in the picker; no automatic retry. A playback error on the TV does the same.
 * - After each successful token request a one-off diagnostic probe (airplayProbe.ts) fetches the token's master and first variant
 *   playlist like the TV does and logs a sanitized summary (tags, codecs, no URIs) to the event log.
 * - Variant fallback (field: LG webOS fetched the master, then nothing, MEDIA_ERR_SRC_NOT_SUPPORTED): on `video-error` code 4 while
 *   our token stream is on the element (`ready` or active), once per token, the token's first VARIANT playlist (resolved from the
 *   master, which is fetched without credentials; it must stay under /media/c/<token>/) replaces the master on the element at the
 *   same position / play state. It still counts as our token stream (`tokenOnElement`). If that fails too (or the master has no
 *   usable variant): the error behaviour below. A new token (retry / refresh) starts with its master again.
 * - Every decision is written to the AirPlay event log (airplayLog.ts, /diagnose) without URLs, tokens or cast ids.
 *
 * Other notes:
 * - Feature detection only (no UA sniffing): the button exists when `webkitShowPlaybackTargetPicker` does and Safari reports a
 *   receiver via `webkitplaybacktargetavailabilitychanged` (on the video or on a hidden probe <video>, because hls.js sets
 *   disableRemotePlayback on the main element when it uses ManagedMediaSource).
 * - AirPlay chosen from Control Center while hls.js plays only mirrors the screen / sends audio: Safari does not report a wireless
 *   video target for an MSE stream, so nothing here runs.
 * - The backend lets an AirPlay token pin a second client address (the TV) for AIRPLAY_PIN2_WINDOW_MS after creation: the phone
 *   pins the first one when it loads the token stream, the TV the second one once the user picked it.
 * - Subtitles: the receiver only shows tracks inside the stream; the player's side-loaded WebVTT tracks stay on the phone.
 */
import type { CastInfo } from '#lib/cast';
import { airLog } from './airplayLog';
import { fetchText, firstVariantUri, runProbe, scrubMessage } from './airplayProbe';

/** the part of HTMLVideoElement this module uses (tests pass a fake) */
export interface AirPlayVideo extends EventTarget {
  currentTime: number;
  readonly paused: boolean;
  src: string;
  webkitShowPlaybackTargetPicker?: () => void;
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
  /** Remote Playback API (Safari 13+): `connected` while a remote device plays, even when the webkit wireless flag flips */
  readonly remote?: { readonly state?: 'connecting' | 'connected' | 'disconnected' };
  play(): Promise<void>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
}

/** Safari's AirPlay API is there (iOS, iPadOS, macOS Safari; also all iOS browsers, which are WebKit) */
export const airPlaySupported = (v: Partial<AirPlayVideo> | null | undefined): boolean => typeof v?.webkitShowPlaybackTargetPicker === 'function';

/** how long a tap on the AirPlay button keeps the token stream (state `ready`) while waiting for the picker's wireless target */
export const ARM_MS = 90_000;
/** wireless off while active: only a state that lasts this long ends AirPlay (WebKit flips it around src changes) */
export const WIRELESS_OFF_GRACE_MS = 4000;
/** wireless events right after our own src change (token URL / restore) are ignored this long, then re-checked once */
export const SETTLE_MS = 1500;
/** breaker for automatic token requests (route chosen outside our button): at most AUTO_MAX per AUTO_WINDOW_MS */
export const AUTO_MAX = 3;
export const AUTO_WINDOW_MS = 60_000;

export interface AirPlayState {
  /** Safari knows at least one AirPlay receiver: show the button */
  available: boolean;
  /** the video plays on an AirPlay receiver (from the moment Safari reports the wireless target) */
  active: boolean;
  /** the token stream is being requested / switched to */
  busy: boolean;
  /** our button was tapped: the token stream is on the element, waiting (ARM_MS) for the picker's choice (prompt: choose the TV) */
  ready: boolean;
  /** the TV is the target but the token stream failed (request or playback): Retry, or end AirPlay in the picker */
  error: boolean;
}

export interface AirPlayDeps {
  /** POST /api/cast/session for the current item at `pos` (audio track, quality are the player's) */
  request(pos: number): Promise<CastInfo>;
  /** DELETE /api/cast/session/<castId> (fire and forget) */
  revoke(ci: CastInfo): void;
  /** before the token stream: report the local stop, drop hls.js, cancel pending attaches */
  detach(): void | Promise<void>;
  /** the token stream is about to play: progress reports belong to `ci` from now on */
  started(ci: CastInfo): void;
  /** AirPlay ended / no TV chosen / token failed before a TV: back to the normal stream at `pos`; `play` = it was playing */
  restore(pos: number, play: boolean, ci: CastInfo | null): void | Promise<void>;
  /** the token stream failed (toast) */
  fail(e: unknown): void;
  change(s: AirPlayState): void;
}

export interface AirPlayController {
  /**
   * our button (and the `ready` prompt): not AirPlaying -> token stream on the element, then the system picker;
   * `ready` / active -> opens the picker synchronously (must run from a click); while the token loads: nothing
   */
  pick(): void;
  readonly state: AirPlayState;
  /** new token at the current position while AirPlay plays or is `ready` (audio track / quality, renewal); no-op otherwise */
  refresh(): Promise<void>;
  /** error state (a tap on Retry): request a token stream again */
  retry(): Promise<void>;
  /** the element reported a playback error (`code` / `message` = MediaError, for the log; the message is scrubbed of URLs): TV's stream -> error state (Retry); `ready` (phone plays the token) -> normal stream */
  videoError(code?: number, message?: string): void;
  /** the cast session while AirPlay plays the token stream */
  readonly info: CastInfo | null;
  /** replaces every callback (the controller moves from the Player to the cast engine); state, listeners, token, breaker and timers stay */
  rebind(deps: AirPlayDeps): void;
  /** while AirPlay is active: new token for the item `deps.request(pos)` now resolves, at `pos`, always playing afterwards; no-op otherwise */
  switchItem(pos: number): Promise<void>;
  /** removes the listeners and revokes a live token (leaving the player) */
  destroy(): void;
}

export const AVAILABILITY_EVENT = 'webkitplaybacktargetavailabilitychanged';
export const WIRELESS_EVENT = 'webkitcurrentplaybacktargetiswirelesschanged';

export interface AirPlayTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}
const realTimers: AirPlayTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t), now: () => Date.now() };

/**
 * `probe`: an extra element (hidden, never MSE) whose availability events count too.
 * `timers` is injectable for tests.
 */
export function createAirPlay(video: AirPlayVideo, deps: AirPlayDeps, probe?: EventTarget | null, timers: AirPlayTimers = realTimers): AirPlayController {
  /** the callbacks in use: `rebind` swaps them (the Player that owned the element is gone, the cast engine took over) */
  let d = deps;
  let available = false, active = false, busy = false, ready = false, error = false, info: CastInfo | null = null, seq = 0, dead = false;
  let armT: ReturnType<typeof setTimeout> | undefined, armPos: number | null = null;
  /** the cast session whose token URL WE put on the element (cleared when the normal stream is restored) */
  let tokenOnElement: CastInfo | null = null;
  /** settle window after our own src change / grace timer for "wireless off" */
  let settleT: ReturnType<typeof setTimeout> | undefined, offT: ReturnType<typeof setTimeout> | undefined;
  /** this wireless episode already had its one automatic token request */
  let autoUsed = false;
  /** the running settle window follows a stop(): its re-check decides whether the wireless episode really ended */
  let afterStop = false;
  /** d.restore() is running (the player re-attaches its normal stream, src changes at some point): keep the window open */
  let restoring = false;
  const autoTimes: number[] = [];
  const now = () => (timers.now ?? Date.now)();
  const avail = new Map<EventTarget, boolean>();
  const state = (): AirPlayState => ({ available, active, busy, ready, error });
  const emit = () => { if (!dead) d.change(state()); };
  const flags = () => `${available ? 'v' : ''}${active ? 'A' : ''}${busy ? 'B' : ''}${ready ? 'R' : ''}${error ? 'E' : ''}${tokenOnElement ? 'T' : ''}${settleT !== undefined ? 'S' : ''}${offT !== undefined ? 'O' : ''}${autoUsed ? 'U' : ''}`;
  const log = (ev: string, o: { wireless?: boolean; note?: string } = {}) => { if (!dead) airLog(ev, { ...o, src: video.src, state: flags() }); };
  const trustedLog = (ev: string, note: string) => { if (!dead) airLog(ev, { src: video.src, state: flags(), note, trusted: true }); };
  /** casts whose variant fallback was already used (once per token) */
  const fellBack = new Set<string>();
  /** the variant fallback's master fetch is running: further element errors are ignored meanwhile */
  let fallingBack = false;
  /** casts already probed (once per token) */
  const probed = new Set<string>();
  /** fire and forget: fetches the token's playlists and logs what the TV gets; never changes state, never throws */
  const startProbe = (ci: CastInfo) => {
    if (dead || probed.has(ci.castId)) return;
    probed.add(ci.castId);
    try { void runProbe(ci.contentUrl, trustedLog, () => !dead).catch(() => undefined); } catch { /* diagnosis only */ }
  };
  const isWireless = () => Boolean(video.webkitCurrentPlaybackTargetIsWireless);
  const stopArmTimer = () => { if (armT !== undefined) timers.clear(armT); armT = undefined; };
  const disarm = () => { stopArmTimer(); ready = false; armPos = null; };
  const arm = () => { stopArmTimer(); ready = true; armT = timers.set(armTimeout, ARM_MS); };
  const clearOff = () => { if (offT !== undefined) timers.clear(offT); offT = undefined; };
  const settle = () => { if (settleT !== undefined) timers.clear(settleT); settleT = timers.set(settleEnd, SETTLE_MS); };
  /** a new src starts at 0 until its metadata: the position we put it at counts until then */
  const position = () => (armPos !== null && video.currentTime < 1 ? armPos : video.currentTime);
  const picker = () => { try { video.webkitShowPlaybackTargetPicker?.(); } catch { /* not from a gesture: the `ready` prompt opens it */ } };
  const status = (e: unknown) => {
    const x = e as { status?: unknown; body?: { error?: unknown } } | null;
    return [typeof x?.status === 'number' ? `status ${x.status}` : 'status ?', typeof x?.body?.error === 'string' ? x.body.error : ''].filter(Boolean).join(' ');
  };
  /** automatic token requests within the breaker window */
  const autoAllowed = () => {
    const t = now();
    while (autoTimes.length && t - autoTimes[0]! >= AUTO_WINDOW_MS) autoTimes.shift();
    return autoTimes.length < AUTO_MAX;
  };

  /** token URL on the element at `pos` (the token is the credential: no cookies; the cast path answers with CORS *) */
  function play(ci: CastInfo, pos: number, wasPlaying: boolean, url = ci.contentUrl) {
    video.removeAttribute('crossorigin');
    tokenOnElement = ci;
    video.src = url;
    settle(); // WebKit may now flip the wireless state: ignore that for SETTLE_MS
    log('src', { note: url === ci.contentUrl ? 'token' : 'token variant' });
    if (pos > 1) video.addEventListener('loadedmetadata', () => { if (info === ci) video.currentTime = pos; }, { once: true });
    if (wasPlaying) video.play().catch(() => undefined);
  }

  const onAvailability = (e: Event) => {
    const on = (e as Event & { availability?: string }).availability === 'available';
    avail.set(e.currentTarget ?? video, on);
    const was = available;
    available = [...avail.values()].some(Boolean);
    if (was !== available) log('availability', { note: `${on ? 'available' : 'not-available'} (${e.currentTarget === video || !e.currentTarget ? 'video' : 'probe'})` });
    emit();
  };

  const onWireless = () => {
    const w = isWireless();
    if (dead) return;
    if (settleT !== undefined && !(w && (active || tokenOnElement) && !(busy && !ready))) {
      log('wireless', { wireless: w, note: 'ignored (settle after src change)' });
      return;
    }
    evaluate(w, 'event');
  };

  /** the one place that acts on the wireless state (event, end of the settle window) */
  function evaluate(w: boolean, why: string) {
    if (w) {
      if (offT !== undefined) { clearOff(); log('wireless', { wireless: w, note: `${why}: on again within grace, ignored` }); return; }
      if (active) { log('wireless', { wireless: w, note: `${why}: already active` }); return; }
      if (busy && !ready) { log('wireless', { wireless: w, note: `${why}: token in flight` }); return; } // tokenFirst() checks the target when done
      if (tokenOnElement) { // the TV got our token URL
        disarm(); active = true; error = false; emit();
        log('wireless', { wireless: w, note: `${why}: started` });
        return;
      }
      // a route we did not prepare (Control Center / picker outside our button): one automatic request per episode, breaker
      if (autoUsed) { active = true; error = true; disarm(); emit(); log('wireless', { wireless: w, note: `${why}: no token, automatic request already used -> error` }); return; }
      if (!autoAllowed()) { active = true; error = true; disarm(); emit(); log('breaker', { wireless: w, note: `${AUTO_MAX} automatic requests in ${AUTO_WINDOW_MS / 1000} s -> error` }); return; }
      autoUsed = true; autoTimes.push(now());
      log('wireless', { wireless: w, note: `${why}: no token on element -> automatic request` });
      const from = armPos ?? undefined;
      disarm(); void switchTo(info, from);
      return;
    }
    if (active) {
      if (offT === undefined) { offT = timers.set(offEnd, WIRELESS_OFF_GRACE_MS); log('wireless', { wireless: w, note: `${why}: off, debounced` }); }
      else log('wireless', { wireless: w, note: `${why}: off, grace running` });
      return;
    }
    log('wireless', { wireless: w, note: `${why}: off, not active, ignored` });
  }

  function settleEnd() {
    settleT = undefined;
    if (dead) return;
    if (restoring) { settleT = timers.set(settleEnd, SETTLE_MS); return; } // the normal stream is not attached yet
    const w = isWireless();
    if (afterStop) { afterStop = false; if (!w) autoUsed = false; } // the route is really off: the wireless episode is over
    evaluate(w, 'settle re-check');
  }

  function offEnd() {
    offT = undefined;
    if (dead) return;
    if (isWireless()) { log('wireless', { wireless: true, note: 'grace over: on again, ignored' }); return; }
    if (video.remote?.state === 'connected') { log('wireless', { wireless: false, note: 'grace over: remote playback connected, ignored' }); return; }
    if (!active) return;
    log('wireless', { wireless: false, note: 'grace over: sustained off -> stop' });
    void stop();
  }

  /** our button: token first, then the picker (the TV must never see the cookie / MSE URL) */
  async function tokenFirst() {
    const my = ++seq, pos = video.currentTime, wasPlaying = !video.paused;
    busy = true; error = false; emit();
    let ci: CastInfo;
    try {
      await d.detach();
      if (my !== seq || dead) return;
      log('token-start', { note: 'tap' });
      ci = await d.request(pos);
    } catch (e) {
      if (my !== seq || dead) return;
      log('token-fail', { note: `tap: ${status(e)}` });
      busy = false;
      if (isWireless()) { active = true; error = true; emit(); d.fail(e); return; } // the TV is the target: never the cookie URL, Retry
      emit();
      d.fail(e);
      log('restore', { note: 'token failed, local' });
      await d.restore(pos, wasPlaying, null); // detach() dropped the normal stream: bring it back
      return;
    }
    if (my !== seq || dead) { d.revoke(ci); return; }
    log('token-ok', { note: 'tap' });
    startProbe(ci);
    info = ci;
    d.started(ci);
    play(ci, pos, wasPlaying);
    busy = false;
    if (isWireless()) { active = true; emit(); log('wireless', { wireless: true, note: 'already wireless after token: started' }); return; } // a TV was picked meanwhile
    armPos = pos; arm(); emit();
    picker(); // WebKit may still honour the tap's gesture; if not, the `ready` prompt opens it
  }

  /** automatic request (route without our token), Retry, or a new token for the running / ready session (audio track, quality, renewal) */
  async function switchTo(old: CastInfo | null, from?: number, why = 'auto', forcePlay = false) {
    const my = ++seq, pos = from ?? position(), wasPlaying = forcePlay || !video.paused;
    if (!ready) active = true;
    busy = true; emit();
    try {
      await d.detach();
      if (my !== seq) return;
      log('token-start', { note: why });
      const ci = await d.request(pos);
      if (my !== seq || dead) { d.revoke(ci); return; } // AirPlay ended (or the player closed) meanwhile
      log('token-ok', { note: why });
      startProbe(ci);
      if (old) d.revoke(old);
      info = ci; error = false;
      d.started(ci);
      play(ci, pos, wasPlaying);
      if (ready && !active && armT === undefined) arm(); // Retry from the `ready` error: wait for the picker again
    } catch (e) {
      if (my !== seq || dead) return;
      log('token-fail', { note: `${why}: ${status(e)}` });
      if (!active && !ready && !isWireless()) { busy = false; d.fail(e); await stop(); return; } // plain local: normal stream
      // the TV is (or may become) the target: never hand it the cookie URL; no restore, no src change, no automatic retry
      error = true; info = old;
      if (ready) stopArmTimer(); // stay in the error state (Retry / picker) instead of restoring after ARM_MS
      d.fail(e);
    } finally {
      if (my === seq) { busy = false; emit(); }
    }
  }

  /** AirPlay off (sustained) / no TV chosen: revoke the token, normal stream at the position */
  async function stop() {
    const ci = info, pos = position(), wasPlaying = !video.paused;
    seq++; disarm(); clearOff();
    info = null; tokenOnElement = null; active = false; busy = false; error = false;
    if (ci) d.revoke(ci);
    video.setAttribute('crossorigin', 'use-credentials');
    emit();
    log('restore', { note: 'stop' });
    afterStop = true; settle(); // the restore changes src: WebKit may flip the route state again
    restoring = true;
    try { await d.restore(pos, wasPlaying, ci); }
    finally { restoring = false; }
    if (!dead && settleT !== undefined) settle(); // the window runs SETTLE_MS from the end of the restore
  }

  /** the token's first variant playlist URL, or null (fetch failed, no variant, outside /media/c/<token>/) */
  async function variantUrl(ci: CastInfo): Promise<string | null> {
    try {
      const master = await fetchText(ci.contentUrl);
      if (master.status !== 200) return null;
      const rel = firstVariantUri(master.text);
      if (rel === null || rel.includes('\\')) return null;
      const base = new URL(ci.contentUrl);
      const prefix = /^\/media\/c\/[^/]+\//.exec(base.pathname)?.[0];
      const u = new URL(rel, base);
      return prefix && u.origin === base.origin && u.pathname.startsWith(prefix) ? u.href : null;
    } catch {
      return null;
    }
  }

  /** code 4 on our token's master: put its variant playlist on the element instead (once per token); false = not applicable */
  function tryVariant(code: number | undefined): boolean {
    const ci = info;
    if (code !== 4 || !ci || tokenOnElement !== ci || !(ready || active) || fellBack.has(ci.castId)) return false;
    fellBack.add(ci.castId);
    fallingBack = true;
    const my = seq, pos = position(), wasPlaying = !video.paused;
    log('fallback-variant', { note: 'master not supported: trying the variant playlist' });
    void variantUrl(ci).then((url) => {
      fallingBack = false;
      if (dead || my !== seq || info !== ci || tokenOnElement !== ci || error) return; // AirPlay ended / new token meanwhile
      if (url === null) { log('fallback-variant', { note: 'no usable variant' }); failed(); return; }
      play(ci, pos, wasPlaying, url);
    });
    return true;
  }

  /** the token stream failed for good: the phone's (`ready`) -> normal stream; the TV's -> error state (Retry) */
  function failed() {
    if (ready && !active) { d.fail(new Error('airplay_media')); void stop(); return; }
    if (!active) return;
    error = true;
    d.fail(new Error('airplay_media'));
    emit();
  }

  function armTimeout() {
    armT = undefined;
    if (!ready || active || dead) return;
    log('arm-timeout', { note: `no TV within ${ARM_MS / 1000} s` });
    void stop();
  }

  video.setAttribute('x-webkit-airplay', 'allow');
  for (const t of probe ? [video, probe] : [video]) t.addEventListener(AVAILABILITY_EVENT, onAvailability);
  video.addEventListener(WIRELESS_EVENT, onWireless);

  return {
    pick() {
      if (dead) return;
      if (active || ready) {
        log('pick', { note: active ? 'picker (active)' : 'picker (ready)' });
        if (ready && !active && !error) arm(); // the user is still choosing: restart the wait
        picker();
        return;
      }
      if (busy) { log('pick', { note: 'busy, ignored' }); return; } // the token is on its way (double tap)
      log('pick', { note: 'token first' });
      void tokenFirst();
    },
    get state() { return state(); },
    async refresh() { if ((active || ready) && !busy && info && !error && !dead) await switchTo(info, undefined, 'refresh'); },
    async retry() { if ((active || error) && !busy && !dead) { log('retry'); await switchTo(info, undefined, 'retry'); } },
    videoError(code?: number, message?: string) {
      if (dead) return;
      const msg = scrubMessage(message);
      const flag = busy ? ', busy: ignored' : error ? ', already error' : fallingBack ? ', fallback running: ignored' : '';
      // raw webkitCurrentPlaybackTargetIsWireless (true / false / undefined): tells a phone failure from a TV failure
      const w = `w=${String(video.webkitCurrentPlaybackTargetIsWireless)}`;
      if (msg) trustedLog('video-error', `code ${code ?? '?'} ${w} msg ${msg}${flag}`);
      else log('video-error', { note: `code ${code ?? '?'} ${w}${flag}` });
      if (busy || error || fallingBack) return;
      if (tryVariant(code)) return;
      failed();
    },
    rebind(next: AirPlayDeps) { d = next; log('rebind'); },
    async switchItem(pos: number) { if (active && !busy && !dead) await switchTo(info, pos, 'switch', true); },
    get info() { return info; },
    destroy() {
      log('destroy');
      dead = true; seq++; disarm(); clearOff();
      if (settleT !== undefined) timers.clear(settleT);
      settleT = undefined;
      for (const t of probe ? [video, probe] : [video]) t.removeEventListener(AVAILABILITY_EVENT, onAvailability);
      video.removeEventListener(WIRELESS_EVENT, onWireless);
      if (info) d.revoke(info);
      info = null; tokenOnElement = null;
    },
  };
}
