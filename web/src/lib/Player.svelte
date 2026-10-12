<script lang="ts">
  import type Hls from 'hls.js';
  import { createEventDispatcher, onDestroy, onMount, tick as tickDom } from 'svelte';
  import { api, ApiError, fmtClock, getActiveProfile, secToTicks } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { get } from 'svelte/store';
  import { prefs, prefsLoaded, saveAudioFx } from '#lib/stores';
  import { segmentShown, serverCaps } from '#lib/capabilities';
  import { subClasses } from '#lib/substyle';
  import { noteInteraction } from '#lib/stillwatching';
  import { nowPlaying } from '#lib/remote';
  import { isBackKey } from '#lib/spatial';
  import { isTypingTarget, nextSubtitle, resolveKey, SHORTCUTS, type KeyAction } from '#lib/player/keymap';
  import { BRIGHTNESS_MIN, brightnessPct, classifyMove, levelFromDrag, registerTap, scrubTarget, TAP_WINDOW, volumeSettable, zoneOf, type Axis, type TapState, type Zone } from '#lib/player/gestures';
  import { creditsStart } from '#lib/player/nextup';
  import { decideRecovery, freshRecovery, kindOfMediaError, lowerQuality, MAX_NETWORK_TRIES, type ErrorKind } from '#lib/player/retry';
  import { parseVolume, stepVolume } from '#lib/player/volume';
  import { hlsConfig, loadHls } from '#lib/player/hls';
  import { firstInfoBody, speedLabel, SPEEDS } from '#lib/player/bar';
  import EpisodesPanel from '#lib/player/EpisodesPanel.svelte';
  import CastInfoPanel from '#lib/player/CastInfoPanel.svelte';
  import CastPeek from '#lib/player/CastPeek.svelte';
  import ScenesPanel from '#lib/player/ScenesPanel.svelte';
  import { hasPeople, loadCastInfo, type CastInfoData } from '#lib/player/castinfo';
  import { chapterIndexAt, chapterLabel, chapterMarks, normalizeChapters, trickFrame, usefulChapters, type Chapter } from '#lib/player/chapters';
  import { AudioFxEngine, fxActive, fxBlocked, fxFromPref, fxToPref, loadFx, saveFx, type AudioFx } from '#lib/player/audiofx';
  import { fmtDuration, getLocale, t, tr, type TFn, type TKey } from '#lib/i18n';
  import { animeAudio, animeDefaultApplies, animeSubtitle } from '#lib/player/anime';
  import { castPause, castPlay, castPlayPause, castSeek, castSetSubtitle, castSetVolume, castState, castStop, castToggleMute, initCast, loadOnCast, onCastEvent, requestCastSession, type CastInfo, type CastState } from '#lib/cast';

  export let itemId: string;
  /** shown on the phone's remote while this plays */
  export let title = '';
  /** centred in the control bar: series / film name and, for episodes, "F3 Folgentitel" */
  export let barTitle = '';
  export let barSub = '';
  /** series of the playing episode: shows the episodes panel button */
  export let seriesId = '';
  export let seasonId = '';
  /** known to be a film (no per-series audio / subtitle preference to look up) */
  export let isMovie = false;
  /** language picked on the detail page: audio language code, subtitles code or 'off' (empty = my defaults) */
  export let wantAudio = '';
  export let wantSub = '';
  export let video: HTMLVideoElement | null = null;
  /** the element that goes fullscreen (so overlays/chat stay visible) */
  export let stage: HTMLDivElement | null = null;
  export let report = true;
  /** false = viewer may not play/pause/seek (watch party guest): controls are shown disabled and a hint appears */
  export let canControl = true;
  export let denyHint = tr('player.denyHint');
  /** watch party: no speed control (it would fight the drift correction) */
  export let partyMode = false;
  export let hasNext = false;
  /** px reserved on the right (e.g. open chat panel) so the control bar is not covered */
  export let inset = 0;
  /** true when the viewer chose "sleep after this episode" (the page then must not autoplay the next one) */
  export let sleepAfterEpisode = false;
  /** start position in seconds (shared scene link); overrides the resume position */
  export let startAt: number | undefined = undefined;
  /** second at which the end credits begin (outro segment or the last 25 s); Infinity while unknown. Read by the page for its "next episode" card. */
  export let creditsAt = Infinity;
  const dispatch = createEventDispatcher();

  interface Info {
    playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string; resumeTicks: number; maxBitrate: number;
    roleMaxBitrate?: number;
    trickplay?: { width: number; height: number; tileWidth: number; tileHeight: number; count: number; interval: number; url: string };
    /** audio track the server baked into hlsUrl (audioLang matched a non-default track) */
    audioIndex?: number;
    audioTracks: Array<{ index: number; title: string; isDefault: boolean; language?: string }>;
    subtitles: Array<{ index: number; title: string; url: string; language?: string; isDefault: boolean }>;
  }
  let info: Info | null = null, hls: Hls | null = null, error = '', mode = '', audioIndex: number | undefined, subIndex = -1;
  let segments: Array<{ type: string; start: number; end: number }> = [];
  let progressTimer: ReturnType<typeof setInterval>, started = false, stopped = false;

  // ---- Chromecast: while casting the local <video> stays paused and every control drives the receiver ----
  let casting = false, castBusy = false, castInfo: CastInfo | null = null, castPos = 0, castPaused: boolean | null = null, castOff: (() => void) | null = null;

  // ---- UI state ----
  let paused = true, current = 0, duration = 0, buffered = 0, volume = 1, muted = false, rate = 1, waiting = true, fullscreen = false;
  let menu: '' | 'tracks' | 'settings' | 'scenes' | 'more' | 'speed' | 'episodes' | 'chapters' = '', toast = '', toastTimer: ReturnType<typeof setTimeout>;
  let lastActive = Date.now(), tick = Date.now(), activityTimer: ReturnType<typeof setInterval>;
  type Bookmark = { id: string; position: number; note: string | null };
  let bookmarks: Bookmark[] = [], noteText = '', xray = false, pausedLong = false, pauseT: ReturnType<typeof setTimeout>;
  const SUB_LANGS = ['ger', 'eng', 'fre', 'spa', 'ita'] as const;
  let subDlg = false, subLang = 'ger', subResults: Array<{ id: string; name: string; provider: string; downloads?: number }> | null = null, subMsg = '', subBusy = false;
  let quality = 0, sleepMin = 0, sleepAt = 0, sleepLeft = '', prefsApplied = false, autoSkipped = new Set<number>(), pipOk = false, inPip = false;
  let scrubbing = false, scrubTime = 0, hoverX = -1, hoverTime = 0, trackEl: HTMLDivElement;
  // ---- robustness: stall spinner (only after 500 ms), reconnect overlay, recovery bookkeeping ----
  let spin = false, spinT: ReturnType<typeof setTimeout>, reconnecting = 0, retryT: ReturnType<typeof setTimeout>, rec = freshRecovery(), lastPos = 0, posKnown = false, errPos = 0, errTitle = '', errNote = '';
  function setSpin(on: boolean) { clearTimeout(spinT); if (!on) { spin = false; return; } spinT = setTimeout(() => (spin = true), 500); }
  $: setSpin(waiting && !error && !casting && !reconnecting);
  // ---- touch gestures ----
  let locked = false, lockHint = false, lockT: ReturnType<typeof setTimeout>, lockHold = false, coarse = false, volOk = true, brightness = 1;
  let hud: { icon: string; text: string; pct: number } | null = null, hudT: ReturnType<typeof setTimeout>;
  let ripple: { zone: Zone; total: number; n: number } | null = null, rippleT: ReturnType<typeof setTimeout>;
  let help = false, live = '', liveN = 0;
  $: showUi = !locked && (paused || menu !== '' || scrubbing || tick - lastActive < 3000);
  $: creditsAt = creditsStart(segments, duration);
  $: skip = segments.find((x) => x.type !== 'recap' && current >= x.start && current < x.end - 1) ?? null;
  $: shown = scrubbing ? scrubTime : current;
  $: pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  $: bufPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  $: nowPlaying.set({ itemId, title, position: current, duration, paused, audio: info?.audioTracks.map((a) => ({ i: a.index, t: a.title })), audioSel: audioIndex ?? info?.audioTracks.find((a) => a.isDefault)?.index, subs: info?.subtitles.map((x) => ({ i: x.index, t: x.title })), subSel: subIndex }); // what the phone remote shows
  $: if (skip && skip.type === 'intro' && !partyMode && canControl && get(prefs).autoSkipIntro && !autoSkipped.has(skip.start)) { autoSkipped.add(skip.start); doSkip(); flash(tr('player.skipped.intro'), 1500); }
  type Seg = 'intro' | 'outro' | 'recap' | 'preview';
  const isSeg = (k: string): k is Seg => k === 'intro' || k === 'outro' || k === 'recap' || k === 'preview';
  const segKey = (k: string, kind: 'segment' | 'skip' | 'skipped'): TKey | null => (isSeg(k) ? `player.${kind}.${k}` : null);
  const segText = (tf: TFn, k: string, kind: 'segment' | 'skip' | 'skipped'): string => { const key = segKey(k, kind); return key ? tf(key) : k; };

  const body = () => casting && castInfo
    ? { itemId, playSessionId: castInfo.playSessionId, mediaSourceId: castInfo.mediaSourceId, positionTicks: secToTicks(castPos), isPaused: $castState.paused, audioIndex, playMethod: 'Transcode' }
    : {
      itemId, playSessionId: info!.playSessionId, mediaSourceId: info!.mediaSourceId,
      positionTicks: secToTicks(video?.currentTime ?? 0), isPaused: video?.paused ?? false, audioIndex, playMethod: mode === 'direct' ? 'DirectPlay' : 'Transcode',
    };
  let lastSent = 0;
  const send = (kind: 'start' | 'progress' | 'stop', keepalive = false) => { lastSent = Date.now(); return report && info && api(`/api/playback/${kind}`, { method: 'POST', body: body(), keepalive }).catch(() => undefined); };

  // ---- per-series audio / subtitle choice ("anime pack"): remembered per profile, applied before the global defaults ----
  let serPref: { audio: string | null; subtitle: string | null } = { audio: null, subtitle: null }, serPrefDone = false;
  /** "Anime: Originalton mit Untertiteln": this anime series has no own choice yet -> Japanese audio + subtitles in the UI language */
  let animeDefault = false;
  /** first start of an episode: look the saved choice up (an episode id resolves to its series server-side); never delays playback for long */
  async function loadSerPref() {
    if (serPrefDone || partyMode || isMovie) return;
    serPrefDone = true;
    try {
      const want = get(prefs).animeOriginal;
      const r = await Promise.race([api<typeof serPref & { anime?: boolean }>(`/api/series/${seriesId || itemId}/langpref${want ? '?anime=1' : ''}`), new Promise<never>((_, no) => setTimeout(no, 800))]);
      serPref = { audio: r.audio, subtitle: r.subtitle };
      animeDefault = animeDefaultApplies(want, r.anime, serPref);
    } catch { /* no saved choice */ }
  }
  function rememberLang(p: { audio?: string; subtitle?: string }) {
    if (!seriesId || partyMode) return;
    serPref = { ...serPref, ...p };
    api(`/api/series/${seriesId}/langpref`, { method: 'PUT', body: p }).then(() => flash(tr('player.langSaved'), 1400)).catch(() => undefined);
  }

  /** the fields every later step relies on (a 204 parses to null) */
  const validInfo = (x: unknown): x is Info => {
    const i = x as Partial<Info> | null;
    return Boolean(i && typeof i.playSessionId === 'string' && typeof i.resumeTicks === 'number' && Array.isArray(i.audioTracks) && Array.isArray(i.subtitles) && (i.directUrl || i.hlsUrl));
  };
  async function load(startSec?: number) {
    error = ''; errNote = '';
    if (startSec !== undefined) { lastPos = startSec; posKnown = true; }
    // first start: the saved quality + audio language go into this same request (no second round trip)
    const first = !prefsApplied && !partyMode;
    if (first) await loadSerPref();
    const fb = first ? firstInfoBody(get(prefs), wantAudio || serPref.audio || animeAudio(animeDefault)) : {};
    if (fb.maxBitrate && !quality) quality = fb.maxBitrate;
    const audioLang = fb.audioLang;
    try {
      const got = await api<Info | null>('/api/playback/info', { method: 'POST', body: { itemId, startTicks: startSec !== undefined ? secToTicks(startSec) : undefined, audioIndex, maxBitrate: quality || undefined, audioLang } });
      // an empty/foreign answer (204, proxy page ...) has no playback session: show the error instead of crashing on it
      if (!validInfo(got)) throw new ApiError(502, null);
      info = got;
    } catch (e: any) {
      if (!(e instanceof ApiError) || e.status >= 500) { recover('network', true); return; } // server/network hiccup: retry with backoff
      reconnecting = 0;
      errNote = e?.body?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(e.body.max) }) : '';
      errTitle = tr('player.error.title'); error = tr('player.error.generic');
      return;
    }
    if (startSec === undefined) { lastPos = info.resumeTicks / 10_000_000; posKnown = true; } // a retry must not restart at 0 before playback ran
    if (info.audioIndex !== undefined) audioIndex = info.audioIndex;
    if (first && quality && info.roleMaxBitrate && quality >= info.roleMaxBitrate) quality = 0; // saved quality above the role limit = "Automatisch"
    // first start only: an older server ignores audioLang -> pick the track here (one extra request, as before)
    if (first) {
      prefsApplied = true;
      const wantTrack = audioLang ? info.audioTracks.find((a) => a.language === audioLang) : undefined;
      if (wantTrack && !wantTrack.isDefault && audioIndex === undefined) { audioIndex = wantTrack.index; return load(startSec); }
    }
    void attach(startSec ?? info.resumeTicks / 10_000_000);
  }

  let attachSeq = 0;
  async function attach(startSec: number) {
    if (!video || !info) return;
    const my = ++attachSeq, cur = info;
    hls?.destroy(); hls = null;
    const useDirect = info.directUrl && audioIndex === undefined && !rec.forcedHls && video.canPlayType('video/mp4');
    mode = useDirect ? 'direct' : 'hls';
    const seek = () => { if (startSec > 1) video!.currentTime = startSec; };
    // hls.js is loaded lazily, only on this path (and usually already prefetched by the play button)
    let H: typeof Hls | null = null;
    if (!useDirect) {
      try { H = await loadHls(); } catch { H = null; }
      if (my !== attachSeq || info !== cur || !video) return; // superseded while loading
    }
    if (useDirect) {
      video.src = info.directUrl!;
      video.addEventListener('loadedmetadata', seek, { once: true });
    } else if (H?.isSupported()) {
      const HC = H;
      hls = new HC(hlsConfig(startSec));
      hls.loadSource(info.hlsUrl);
      hls.attachMedia(video);
      hls.on(HC.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        recover(d.type === HC.ErrorTypes.NETWORK_ERROR ? 'network' : d.type === HC.ErrorTypes.MEDIA_ERROR ? 'media' : 'other');
      });
    } else if (!H && !video.canPlayType('application/vnd.apple.mpegurl')) {
      recover('network', true); // hls.js could not be loaded (offline): retry like a network error
      return;
    } else {
      video.src = info.hlsUrl; // Safari: native HLS
      video.addEventListener('loadedmetadata', seek, { once: true });
    }
    stopped = false; started = false;
    dispatch('ready', { info });
    // detail-page pick > this series' saved choice (when the episode has that language) > my global default
    const sp = serPref.subtitle;
    // anime default: subtitles in the UI language, but only while the Japanese track plays (a dub-only release keeps my defaults)
    const playingAudio = info.audioTracks.find((a) => a.index === audioIndex) ?? info.audioTracks.find((a) => a.isDefault);
    const anime = animeDefault && !wantAudio ? animeSubtitle(getLocale(), playingAudio?.language, info.subtitles) : null;
    const want = wantSub === 'off' ? '' : wantSub || (sp === 'off' ? '' : sp && info.subtitles.some((x) => x.language === sp) ? sp : anime || get(prefs).subtitleLang);
    if (want && !partyMode) tickDom().then(() => { const sub = info?.subtitles.find((x) => (x as { language?: string }).language === want); if (sub) setSubtitle(sub.index, false); });
  }

  // ---- error recovery: network = 3 retries with backoff at the last position; decode error = recoverMediaError once, then transcode / lower quality ----
  const resumePos = () => Math.max(lastPos, video && video.currentTime > 0 ? video.currentTime : 0);
  const lowerStep = () => lowerQuality(QUALITIES.map(([, b]) => b).filter((b) => b < (info?.roleMaxBitrate ?? Infinity)), quality, info?.maxBitrate ?? 0);
  let retryViaLoad = false;
  function recover(kind: ErrorKind, viaLoad = false) {
    if (casting) return;
    retryViaLoad = viaLoad;
    const pos = resumePos();
    const d = decideRecovery(kind, rec, { isHls: Boolean(hls), canLowerQuality: lowerStep() !== null });
    if (d.do === 'retry') {
      rec.networkTries = d.attempt; reconnecting = d.attempt; errPos = pos; waiting = true;
      clearTimeout(retryT); retryT = setTimeout(() => retryNow(pos), d.delay);
    } else if (d.do === 'recover-media') { rec.mediaRecovered = true; errPos = pos; hls?.recoverMediaError(); }
    else if (d.do === 'force-hls') { rec.forcedHls = true; errPos = pos; flash(tr('player.switchingTranscode'), 2500); wantAutoplay = !paused; load(pos); }
    else if (d.do === 'lower-quality') { rec.loweredQuality = true; errPos = pos; const q = lowerStep(); if (q) { wantAutoplay = !paused; changeQuality(q); } else giveUp(); }
    else giveUp();
  }
  function giveUp() { clearTimeout(retryT); reconnecting = 0; waiting = false; errTitle = tr('player.error.title'); error = errNote || tr('player.error.connection'); hls?.stopLoad(); }
  function retryNow(pos: number) {
    clearTimeout(retryT);
    if (!reconnecting) return;
    wantAutoplay = !paused || wantAutoplay;
    if (hls && !retryViaLoad && reconnecting < MAX_NETWORK_TRIES) { if (hls.levels.length) hls.startLoad(pos); else if (info) hls.loadSource(info.hlsUrl); } // 1st/2nd retry: restart loading (or the manifest request)
    else void load(posKnown ? pos : undefined); // last retry (or direct play): new playback session, the old token may be dead
  }
  function retryManually() { rec = freshRecovery(); reconnecting = 0; error = ''; errNote = ''; waiting = true; wantAutoplay = true; void load(posKnown ? resumePos() : undefined); }
  function leave() { if (history.length > 1) history.back(); else location.href = '/'; }
  function onVideoError() {
    if (hls || casting || !video?.error || !info) return; // hls.js reports its own errors
    const kind = kindOfMediaError(video.error.code);
    if (video.error.code === 1) return; // aborted by us
    recover(kind);
  }
  function onPlaying() {
    waiting = false;
    if (reconnecting) { reconnecting = 0; flash(tr('player.reconnected'), 1500); }
  }

  // ---- Chromecast session lifecycle ----
  const castErr = (e: any) => e?.body?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(e.body.max) })
    : e?.body?.error === 'transcoding_disabled' ? tr('player.cast.needsTranscode') : tr('player.cast.failed');
  const castRequest = (pos: number) => api<CastInfo>('/api/cast/session', { method: 'POST', body: { itemId, startTicks: secToTicks(pos), audioIndex, maxBitrate: quality || undefined } });
  const castRevoke = (ci: CastInfo | null) => { if (ci) api(`/api/cast/session/${ci.castId}`, { method: 'DELETE' }).catch(() => undefined); };

  /** local playback -> receiver: reports the local stop, frees the stream slot, asks for a cast token and loads it */
  async function startCast() {
    if (partyMode || casting || castBusy || !$castState.connected) return;
    castBusy = true;
    const pos = video?.currentTime ?? 0;
    if (started && !stopped) { stopped = true; await send('stop'); }
    video?.pause(); hls?.destroy(); hls = null;
    try {
      const ci = await castRequest(pos);
      castInfo = ci; castPos = pos; casting = true; started = false; stopped = false; castPaused = null; waiting = true;
      if (!(await loadOnCast(ci, subIndex))) throw new Error('load');
    } catch (e) {
      await endCast(pos, castErr(e));
    }
    castBusy = false;
  }
  /** receiver -> local playback at the last known position (disconnect, user ended the session, receiver error) */
  async function endCast(resumeAt: number, msg = '') {
    const ci = castInfo;
    if (casting && started && !stopped) { stopped = true; await send('stop'); }
    casting = false; castInfo = null; started = false; stopped = false;
    castRevoke(ci);
    if (msg) flash(msg, 4000);
    wantAutoplay = true;
    await load(resumeAt);
  }
  /** new token + LOAD at the current position: token about to expire, other audio track or quality */
  async function recast(pos: number) {
    if (!casting || castBusy) return;
    castBusy = true;
    const old = castInfo;
    try {
      if (started && !stopped) { castPos = pos; stopped = true; await send('stop'); }
      const ci = await castRequest(pos);
      castInfo = ci; started = false; stopped = false; castPaused = null; castPos = pos;
      castRevoke(old);
      if (!(await loadOnCast(ci, subIndex))) throw new Error('load');
    } catch {
      await endCast(pos, tr('player.cast.resumeFailed'));
    }
    castBusy = false;
  }
  /** the film ended on the receiver: close the session, tell the page (next episode) */
  async function finishCast() {
    const ci = castInfo;
    if (started && !stopped) { stopped = true; castPos = duration || castPos; await send('stop'); }
    casting = false; castInfo = null; paused = true;
    castRevoke(ci);
    castStop();
    dispatch('ended');
  }
  function handleCast(e: 'session-start' | 'session-end' | 'media-end') {
    if (e === 'session-start') void startCast();
    else if (e === 'session-end') { if (casting && !castBusy) void endCast(castPos); }
    else if (casting && !castBusy) { if (duration > 0 && castPos >= duration - 20) void finishCast(); else void endCast(castPos, tr('player.cast.continuedLocally')); }
  }
  /** mirrors the receiver into the player state and reports start/progress to the server */
  function castTick(s: CastState) {
    waiting = !s.loaded || s.state === 'buffering';
    if (!s.loaded) return;
    current = castPos = s.currentTime; if (s.duration) duration = s.duration;
    paused = s.paused; volume = s.volume; muted = s.muted;
    if (s.state === 'playing' && !started) { started = true; stopped = false; send('start'); }
    else if (started && castPaused !== null && castPaused !== s.paused) send('progress');
    castPaused = s.paused;
  }
  $: if (casting) castTick($castState);
  const doPause = () => (casting ? castPause() : video?.pause());

  async function changeAudio(i: number) {
    const lang = info?.audioTracks.find((a) => a.index === i)?.language;
    if (lang && lang !== 'und') rememberLang({ audio: lang });
    if (casting) { audioIndex = i; await recast(castPos); return; }
    const pos = video?.currentTime ?? 0;
    await send('stop');
    audioIndex = i;
    await load(pos);
    video?.play().catch(() => undefined);
  }
  function setSubtitle(i: number, remember = true) {
    subIndex = i;
    if (remember) { const lang = i === -1 ? 'off' : info?.subtitles.find((x) => x.index === i)?.language; if (lang && lang !== 'und') rememberLang({ subtitle: lang }); }
    if (casting) castSetSubtitle(i);
    [...(video?.textTracks ?? [])].forEach((t) => (t.mode = t.id === `sub-${i}` ? 'showing' : 'disabled'));
  }

  // ---- start playback: browsers may refuse sound without a prior key press (a TV that was only cast to) -> start muted, first key unmutes ----
  let wantAutoplay = !partyMode, needsSound = false;
  async function playSafe() {
    if (casting) { castPlay(); return; }
    if (!video) return;
    try { await video.play(); return; } catch { /* blocked: try muted */ }
    try { video.muted = true; muted = true; await video.play(); needsSound = true; flash(tr('player.soundOff'), 7000); }
    catch { video.muted = false; muted = false; } // still blocked: the big play button stays
  }
  function unmuteOnGesture(e: Event) {
    if (!needsSound || !video) return;
    needsSound = false; video.muted = false; muted = false; toast = '';
    e.stopPropagation(); e.preventDefault(); // this first key/tap only switches the sound on
  }
  const tvMode = () => document.documentElement.classList.contains('tv');
  const focusControls = () => { wake(); tickDom().then(() => stage?.querySelector<HTMLElement>('.ctl .ic')?.focus()); };
  /** commands from the phone remote (dispatched by the layout on a paired TV) */
  function onRemote(e: Event) {
    const m = (e as CustomEvent<{ action: string; value?: number }>).detail;
    wake();
    if (m.action === 'play') { if (allowed()) playSafe(); }
    else if (m.action === 'pause') { if (allowed()) doPause(); }
    else if (m.action === 'toggle') { if (paused) { if (allowed()) playSafe(); } else if (allowed()) doPause(); }
    else if (m.action === 'audio' && typeof m.value === 'number') { if (info?.audioTracks.some((a) => a.index === m.value)) changeAudio(m.value); }
    else if (m.action === 'sub' && typeof m.value === 'number') { if (m.value === -1 || info?.subtitles.some((x) => x.index === m.value)) setSubtitle(m.value); }
    else if (m.action === 'next') { if (hasNext && allowed()) dispatch('next'); else flash(tr('player.noNext')); }
    else if (m.action === 'seekBy' && typeof m.value === 'number') seekBy(m.value);
  }

  // ---- gated controls (party guests are not allowed to change playback) ----
  function announce(t: string) { live = t + (liveN++ % 2 ? '\u200b' : ''); }
  function flash(t: string, ms = 1100) { toast = t; announce(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast = ''), ms); }
  function allowed(): boolean { if (canControl) return true; flash(denyHint, 1800); return false; }
  function togglePlay() { if (casting) { if (allowed()) castPlayPause(); return; } if (!video || !allowed()) return; if (video.paused) video.play().catch(() => undefined); else video.pause(); }
  function seekTo(t: number) {
    if (casting) { if (!allowed()) return; t = Math.max(0, Math.min(duration || t, t)); castSeek(t); current = castPos = t; setTimeout(() => { if (started && !stopped) send('progress'); }, 700); return; }
    if (!video || !allowed()) return; video.currentTime = Math.max(0, Math.min(duration || t, t)); }
  function seekBy(d: number, quiet = false) { if (!video || !allowed()) return; seekTo((casting ? castPos : video.currentTime) + d); if (quiet) announce(d > 0 ? tr('player.secondsForward', { n: d }) : tr('player.secondsBack', { n: -d })); else flash(d > 0 ? `+${d} s` : `−${-d} s`, 700); }
  function doSkip() {
    if (!skip) return;
    const key = segKey(skip.type, 'skipped');
    // a preview at the very end is the teaser of the next episode: go there instead of seeking into nothing
    if (skip.type === 'preview' && duration && skip.end >= duration - 3 && hasNext) { if (allowed()) dispatch('next'); return; }
    seekTo(skip.end);
    if (key) announce(tr(key));
  }
  const QUALITIES: Array<[string, number]> = [['1080p', 8_000_000], ['720p', 4_000_000], ['480p', 1_500_000], ['360p', 800_000]];
  $: qualityOptions = QUALITIES.filter(([, b]) => b < (info?.roleMaxBitrate ?? Infinity));
  const qualityToast = (bps: number) => tr('player.quality.changed', { q: bps ? QUALITIES.find(([, b]) => b === bps)?.[0] ?? tr('player.quality.mbit', { n: Math.round(bps / 1e6) }) : tr('player.quality.auto') });
  async function changeQuality(bps: number) {
    menu = '';
    if (bps === quality) return;
    if (casting) { quality = bps; await recast(castPos); flash(qualityToast(bps)); return; }
    const pos = video?.currentTime ?? 0, wasPlaying = !(video?.paused ?? true);
    await send('stop');
    quality = bps;
    await load(pos);
    if (wasPlaying) video?.play().catch(() => undefined);
    flash(qualityToast(bps));
  }
  function setSleep(min: number | 'end') {
    menu = '';
    sleepAfterEpisode = min === 'end';
    sleepMin = typeof min === 'number' ? min : 0;
    sleepAt = typeof min === 'number' && min > 0 ? Date.now() + min * 60_000 : 0;
    flash(min === 0 ? tr('player.sleep.off') : min === 'end' ? tr('player.sleep.afterEpisode') : tr('player.sleep.set', { d: fmtDuration(min * 60) }));
  }
  async function pip() { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video?.requestPictureInPicture(); } catch { flash(tr('player.pipUnavailable')); } }
  // ---- scenes: bookmarks + share link ----
  const loadBookmarks = () => api(`/api/bookmarks?itemId=${itemId}`).then((r) => (bookmarks = r.bookmarks)).catch(() => undefined);
  async function addBookmark() {
    try { await api('/api/bookmarks', { method: 'POST', body: { itemId, position: Math.floor(video?.currentTime ?? 0), note: noteText || undefined } }); noteText = ''; await loadBookmarks(); flash(tr('player.bookmark.set')); }
    catch { flash(tr('player.bookmark.failed')); }
  }
  async function removeBookmark(id: string) { await api(`/api/bookmarks/${id}`, { method: 'DELETE' }).catch(() => undefined); loadBookmarks(); }
  async function shareScene() {
    const url = `${location.origin}/watch/${itemId}?t=${Math.floor(video?.currentTime ?? 0)}`;
    try { await navigator.clipboard.writeText(url); flash(tr('player.bookmark.linkCopied', { t: fmtClock(video?.currentTime ?? 0) }), 1800); } catch { flash(url, 4000); }
  }

  // ---- "Besetzung & Infos": side panel while paused (as before) or opened explicitly; quick peek while playing ----
  let castData: CastInfoData | null = null, castFailed = false, infoDismissed = false, infoFocus = false, peek = false, peekT: ReturnType<typeof setTimeout>;
  function ensureInfo() {
    if (castData) return;
    castFailed = false;
    loadCastInfo(itemId).then((d) => (castData = d)).catch(() => (castFailed = true));
  }
  $: if (paused && started) { clearTimeout(pauseT); pauseT = setTimeout(() => { pausedLong = true; ensureInfo(); }, 1200); } else { clearTimeout(pauseT); pausedLong = false; infoDismissed = false; }
  // automatic (pause): only with something to show; explicit: also while loading / after an error
  $: showXray = (xray || (pausedLong && !infoDismissed && Boolean(castData && (hasPeople(castData) || castData.studios.length || castData.genres.length)))) && menu === '' && !subDlg && !help && !error && !locked;
  $: if (showXray) peek = false;
  /** quick peek: does not pause, hides by itself after a few seconds */
  function openPeek() {
    if (showXray || locked) return;
    ensureInfo(); wake(); peek = true;
    clearTimeout(peekT); peekT = setTimeout(() => (peek = false), 6000);
    announce(tr('scenes.peek.label'));
  }
  function openCastInfo(focus: boolean) { clearTimeout(peekT); peek = false; menu = ''; ensureInfo(); infoFocus = focus; xray = true; wake(); }
  function closeCastInfo() {
    const had = stage?.querySelector('.ci')?.contains(document.activeElement);
    xray = false; infoDismissed = true; infoFocus = false;
    if (had) tickDom().then(() => castBtn?.focus());
  }
  /** the cast button in the bar: panel open -> close; paused -> panel; playing -> peek (a second press opens the panel) */
  function castButton() { if (showXray) closeCastInfo(); else if (paused || peek) openCastInfo(tvMode()); else openPeek(); }
  let castBtn: HTMLButtonElement | undefined;

  // ---- chapters ("Szenen"): marks on the seek bar, names while hovering / scrubbing, the scenes panel ----
  let chapters: Chapter[] = [], scBtn: HTMLButtonElement | undefined;
  $: marks = chapterMarks(chapters, duration);
  $: showScenes = usefulChapters(chapters, duration);
  const chapterAt = (sec: number) => { const i = chapterIndexAt(chapters, sec); return chapters.length > 1 && i >= 0 ? chapterLabel(chapters[i]!, i) : ''; };
  function closeScenes() { menu = ''; void tickDom().then(() => scBtn?.focus()); }

  // ---- sound: "Klare Stimmen" / "Nachtmodus" (Web Audio on the local <video>; the profile's server pref `audioFx`, with a
  //      localStorage copy so the player starts with the right mode before /api/prefs answered) ----
  let fx: AudioFx = loadFx(getActiveProfile()), fxEngine: AudioFxEngine | null = null, fxNote: '' | 'unsupported' | 'suspended' = '';
  const fxBlockFor = (isCasting: boolean, m: string, h: Hls | null) => video ? fxBlocked({
    casting: isCasting, nativeHls: m === 'hls' && !h, src: video.currentSrc || video.src || '', crossOrigin: video.crossOrigin, origin: location.origin,
    hasWebAudio: typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window),
  }) : 'unsupported';
  $: fxDisabled = menu === 'tracks' ? (casting ? 'casting' : fxNote === 'unsupported' ? 'unsupported' : fxBlockFor(casting, mode, hls)) : null;
  async function applyFx(quiet = false) {
    if (!video || (!fxActive(fx) && !fxEngine)) return;
    const b = fxBlockFor(casting, mode, hls);
    if (b) { if (b === 'unsupported') fxNote = 'unsupported'; return; }
    fxEngine ??= new AudioFxEngine(video);
    const r = await fxEngine.apply(fx);
    fxNote = r === 'unsupported' ? 'unsupported' : r === 'suspended' ? 'suspended' : '';
    if (r === 'unsupported' && !quiet) flash(tr('scenes.audio.unsupported'), 2500);
  }
  const FX_OPTS = [
    { k: 'voice', label: 'scenes.audio.voice', hint: 'scenes.audio.voiceHint' },
    { k: 'night', label: 'scenes.audio.night', hint: 'scenes.audio.nightHint' },
  ] as const;
  /** the server pref wins once it is known (another device may have changed it); never after a toggle made here */
  let fxTouched = false;
  $: if ($prefsLoaded && !fxTouched) adoptFxPref($prefs.audioFx);
  function adoptFxPref(p: unknown) {
    const n = fxFromPref(p);
    if (n.voice === fx.voice && n.night === fx.night) return;
    fx = n;
    saveFx(getActiveProfile(), fx);
    void applyFx(true);
  }
  function toggleFx(k: keyof AudioFx) {
    fxTouched = true;
    fx = { ...fx, [k]: !fx[k] };
    saveFx(getActiveProfile(), fx);
    saveAudioFx(fxToPref(fx)).catch(() => undefined); // offline / failed: still remembered in this browser
    const name = tr(k === 'voice' ? 'scenes.audio.voice' : 'scenes.audio.night');
    flash(tr(fx[k] ? 'scenes.audio.on' : 'scenes.audio.off', { name }), 1400);
    void applyFx();
  }
  /** a remembered mode needs a running AudioContext: the first key / tap after an autoplayed start switches it on */
  function fxGesture() { if (fxNote === 'suspended' && fxActive(fx)) void applyFx(true); }

  // ---- find subtitles (Jellyfin remote providers) ----
  async function searchSubs() {
    subBusy = true; subMsg = ''; subResults = null;
    try { subResults = (await api(`/api/items/${itemId}/subtitles/search?lang=${subLang}`)).results; if (!subResults?.length) subMsg = tr('player.subs.notFound'); }
    catch (e: any) { subMsg = e?.status === 403 ? tr('player.subs.notAllowed') : tr('player.subs.providerDown'); }
    subBusy = false;
  }
  async function pickSub(id: string) {
    subBusy = true;
    try {
      await api(`/api/items/${itemId}/subtitles/download`, { method: 'POST', body: { subtitleId: id } });
      if (casting) { subDlg = false; await recast(castPos); flash(tr('player.subs.added'), 2500); subBusy = false; return; }
      const pos = video?.currentTime ?? 0, was = !(video?.paused ?? true);
      subDlg = false; await send('stop'); await load(pos); if (was) video?.play().catch(() => undefined);
      flash(tr('player.subs.added'), 2500);
    } catch { subMsg = tr('player.subs.downloadFailed'); }
    subBusy = false;
  }
  function setRate(r: number) { if (!video) return; rate = r; video.playbackRate = r; menu = ''; flash(r === 1 ? tr('player.speed.normalToast') : tr('player.speed.rate', { r })); }
  // ---- Chromecast entry in the "Mehr" menu (the SDK loads lazily, Chromium only) ----
  function castClick() { menu = ''; if (!$castState.connected) void requestCastSession(); else if (casting) castStop(); else void startCast(); }
  $: castLabel = casting ? $t('player.cast.stopOn', { name: $castState.deviceName || 'Chromecast' }) : $castState.connected ? $t('player.cast.playOn', { name: $castState.deviceName || 'Chromecast' }) : $t('player.cast.castTo');
  $: modeLabel = casting ? 'Chromecast' : mode === 'direct' ? $t('player.mode.direct') : mode ? $t('player.mode.hls') : '';
  const toggleMenu = (m: typeof menu) => (menu = menu === m ? '' : m);
  /** Large control icons (~40px); smaller on phones */
  let ICON = 36;
  function pickEpisode(e: CustomEvent<{ id: string }>) { menu = ''; dispatch('episode', e.detail); }
  /** "Folgen" panel closed (✕ or the playing episode): focus goes back to its trigger */
  let epBtn: HTMLButtonElement | undefined;
  function closeEpisodes() { menu = ''; void tickDom().then(() => epBtn?.focus()); }
  function setVolume(v: number) { if (casting) { volume = v; muted = v === 0; castSetVolume(v); return; } if (!video) return; volume = v; video.volume = v; video.muted = v === 0; muted = v === 0; try { localStorage.setItem('ff_vol', String(v)); } catch { /* ignore */ } }
  function volumeBy(delta: number) { const v = stepVolume(muted ? 0 : volume, delta); setVolume(v); flash(tr('player.volume.level', { n: Math.round(v * 100) }), 600); }
  function toggleMute() { if (casting) { castToggleMute(); return; } if (!video) return; video.muted = !video.muted; muted = video.muted; if (!muted && volume === 0) setVolume(0.5); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage ?? video?.parentElement)?.requestFullscreen?.().catch(() => undefined);
  }

  // ---- timeline (pointer + keyboard) ----
  function fracAt(e: PointerEvent | MouseEvent) { const r = trackEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
  let trackW = 600;
  function onTrackMove(e: PointerEvent) { const f = fracAt(e); hoverX = f * 100; hoverTime = f * duration; trackW = trackEl.clientWidth; if (scrubbing) scrubTime = hoverTime; }
  /** keep the preview inside the timeline at both ends */
  $: previewW = info?.trickplay ? 168 : 0;
  $: tipLeft = Math.max(previewW / 2, Math.min(trackW - previewW / 2, (hoverX / 100) * trackW));
  $: thumb = hoverX < 0 || !duration ? null : trickFrame(info?.trickplay, scrubbing ? scrubTime : hoverTime, 168);
  $: tipChapter = hoverX >= 0 && duration ? chapterAt(scrubbing ? scrubTime : hoverTime) : '';
  function onTrackDown(e: PointerEvent) {
    if (!allowed()) return;
    scrubbing = true; scrubTime = fracAt(e) * duration; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onTrackUp() { if (scrubbing) { scrubbing = false; seekTo(scrubTime); } }
  function onTrackKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekBy(-5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(5); }
  }

  // ---- activity / keyboard / touch ----
  function wake() { lastActive = Date.now(); tick = lastActive; }
  const overlayOpen = () => Boolean(menu || subDlg || help || (xray && showXray));
  function act(a: KeyAction) {
    switch (a.type) {
      case 'toggle': togglePlay(); break;
      case 'play': if (allowed()) playSafe(); break;
      case 'pause': if (allowed()) doPause(); break;
      case 'seek': seekBy(a.by); break;
      case 'seekPct': if (duration > 0 && allowed()) { seekTo((duration * a.pct) / 100); flash(tr('player.percent', { n: a.pct }), 700); } break;
      case 'volume': volumeBy(a.delta); break;
      case 'mute': toggleMute(); flash(muted ? tr('player.mute') : tr('player.unmute'), 700); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'subtitles': cycleSubtitles(); break;
      case 'skip': if (skip && allowed()) doSkip(); break;
      case 'next': if (hasNext && allowed()) dispatch('next'); else flash(tr('player.noNext')); break;
      case 'help': help = !help; break;
      case 'pip': if (pipOk && !casting) void pip(); break;
      case 'tvControls': focusControls(); break;
      case 'escape': menu = ''; subDlg = false; help = false; if (showXray) closeCastInfo(); peek = false; break;
      case 'peek': if (peek) openCastInfo(true); else openPeek(); break;
      case 'castInfo': openCastInfo(true); break;
    }
  }
  function cycleSubtitles() {
    if (!info?.subtitles.length) { flash(tr('player.subs.none')); return; }
    const i = nextSubtitle(subIndex, info.subtitles.map((x) => x.index));
    setSubtitle(i);
    flash(i === -1 ? tr('player.subs.off') : tr('player.subs.on', { name: info.subtitles.find((x) => x.index === i)?.title ?? '' }), 1500);
  }
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (!video || isTypingTarget(t)) return;
    if ((t.tagName === 'BUTTON' || t.tagName === 'A') && (e.key === ' ' || e.key === 'Enter')) return; // the focused control keeps Space/Enter
    const a = resolveKey(e, { tv: tvMode(), onBody: t === document.body || t === stage, hasSkip: Boolean(skip), hasNext, overlayOpen: overlayOpen(), peekOpen: peek });
    wake();
    if (!a) return;
    e.preventDefault();
    act(a);
  }
  /** Back / Escape (capture phase: the control bar swallows key events): close the shortcut overlay / open menu, then leave the control bar */
  function onBackCapture(e: KeyboardEvent) {
    if (!(e.key === 'Escape' || (tvMode() && isBackKey(e)))) return;
    const opener = stage?.querySelector<HTMLElement>('.ctl [aria-expanded="true"]');
    if (menu || subDlg || help) {
      e.preventDefault(); e.stopImmediatePropagation();
      const panelBtn = menu === 'episodes' ? epBtn : menu === 'chapters' ? scBtn : undefined;
      menu = ''; subDlg = false; help = false;
      if (tvMode() || panelBtn) tickDom().then(() => (panelBtn ?? opener)?.focus());
    } else if (showXray && (xray || stage?.querySelector('.ci')?.contains(document.activeElement))) {
      e.preventDefault(); e.stopImmediatePropagation();
      const sheetBack = stage?.querySelector<HTMLButtonElement>('.ci [data-back]');
      if (sheetBack) sheetBack.click(); else closeCastInfo(); // person sheet open: back to the cast list first
    } else if (peek) {
      e.preventDefault(); e.stopImmediatePropagation();
      clearTimeout(peekT); peek = false;
    } else if (tvMode() && stage?.querySelector('.ctl')?.contains(document.activeElement)) {
      e.preventDefault(); e.stopImmediatePropagation();
      (document.activeElement as HTMLElement).blur(); lastActive = 0; // hide the bar, the next Back leaves the player
    }
  }
  /** keys typed on a control belong to the control (Space/Enter = click, arrows = slider) - everything else (F, M, C, digits ...) still reaches the player; Escape leaves */
  const ctlKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return;
    const t = e.target as HTMLElement;
    if (tvMode()) { e.stopPropagation(); return; } // D-pad: the focus belongs to the control bar
    const native = (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range' && e.key.startsWith('Arrow'));
    if (native) e.stopPropagation();
  };
  $: if (help || error) tickDom().then(() => stage?.querySelector<HTMLElement>('.help [data-autofocus], .errbox [data-autofocus]')?.focus());
  $: if (menu && typeof document !== 'undefined' && tvMode()) tickDom().then(() => stage?.querySelector<HTMLElement>('.menu .mi')?.focus());

  // ---- mouse: click = play/pause (deferred to tell a double click = fullscreen); touch is handled by the pointer gestures below ----
  let lastTap = 0, lastTouch = 0;
  const NO_GESTURE = '.ui, .skipbtn, .ovl, .dlg, .help, .lockbtn, [data-nav], button, a, input, select';
  function onSurfaceClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(NO_GESTURE)) return;
    if (Date.now() - lastTouch < 800) return; // the click that follows a touch was already handled
    const now = Date.now();
    if (menu) { menu = ''; return; }
    if (now - lastTap < 280) { toggleFullscreen(); lastTap = 0; } else { lastTap = now; setTimeout(() => { if (lastTap === now) { togglePlay(); lastTap = 0; } }, 285); }
  }
  function toggleControls() { if (tick - lastActive < 3000 && !paused) lastActive = 0; else wake(); }

  // ---- touch gestures: double-tap thirds = seek, swipe = volume / brightness / scrub, lock ----
  type G = { id: number; x: number; y: number; t: number; w: number; h: number; left: number; axis: Axis; moved: boolean; startTime: number; startVol: number; startBri: number; target: number };
  let g: G | null = null, tapState: TapState | null = null, pendingTap: ReturnType<typeof setTimeout>;
  function showHud(h: { icon: string; text: string; pct: number } | null, hideAfter = 0) { hud = h; clearTimeout(hudT); if (h && hideAfter) hudT = setTimeout(() => (hud = null), hideAfter); }
  function showRipple(zone: Zone, total: number) { ripple = { zone, total, n: (ripple?.n ?? 0) + 1 }; clearTimeout(rippleT); rippleT = setTimeout(() => (ripple = null), 750); }
  function gDown(e: PointerEvent) {
    if (e.pointerType !== 'touch' || tvMode()) return;
    lastTouch = Date.now();
    if (g) { g = null; showHud(null); return; } // second finger: not ours (pinch)
    if ((e.target as HTMLElement).closest(NO_GESTURE)) return;
    const r = (stage ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), w: r.width - inset, h: r.height, left: r.left, axis: null, moved: false, startTime: casting ? castPos : video?.currentTime ?? 0, startVol: muted ? 0 : volume, startBri: brightness, target: 0 };
  }
  function gMove(e: PointerEvent) {
    if (!g || e.pointerId !== g.id || locked) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.axis) {
      g.axis = classifyMove(dx, dy, g.x - g.left, g.w, { volumeOk: volOk });
      if (!g.axis) return;
      if (g.axis === 'scrub' && (!duration || !canControl)) { if (!canControl) allowed(); g.axis = null; g.moved = true; return; }
      if (g.axis === 'brightness' && casting) { g.axis = null; g.moved = true; return; }
      g.moved = true; clearTimeout(pendingTap); tapState = null;
    }
    if (g.axis === 'scrub') {
      g.target = scrubTarget(g.startTime, dx, g.w, duration);
      const d = g.target - g.startTime;
      const ch = chapterAt(g.target);
      showHud({ icon: d < 0 ? 'rewind10' : 'forward10', text: `${ch ? ch + ' · ' : ''}${fmtClock(g.target)}  (${d < 0 ? '−' : '+'}${fmtClock(Math.abs(d))})`, pct: duration ? (g.target / duration) * 100 : 0 });
    } else if (g.axis === 'volume') {
      const v = Math.round(levelFromDrag(g.startVol, dy, g.h) * 20) / 20;
      setVolume(v); showHud({ icon: v === 0 ? 'volume-off' : v < 0.5 ? 'volume-low' : 'volume', text: tr('player.volume.level', { n: Math.round(v * 100) }), pct: v * 100 });
    } else if (g.axis === 'brightness') {
      brightness = levelFromDrag(g.startBri, dy, g.h, BRIGHTNESS_MIN, 1);
      showHud({ icon: 'sun', text: tr('player.brightness', { n: brightnessPct(brightness) }), pct: ((brightness - BRIGHTNESS_MIN) / (1 - BRIGHTNESS_MIN)) * 100 });
    }
  }
  function gUp(e: PointerEvent) {
    if (!g || e.pointerId !== g.id) return;
    const cur = g; g = null; lastTouch = Date.now();
    if (cur.axis === 'scrub') { seekTo(cur.target); announce(tr('player.position', { t: fmtClock(cur.target) })); showHud(hud, 500); return; }
    if (cur.axis) { announce(hud?.text ?? ''); showHud(hud, 700); return; }
    if (cur.moved || Math.hypot(e.clientX - cur.x, e.clientY - cur.y) > 12) { showHud(null); return; }
    handleTap(e.clientX - cur.left, cur.w);
  }
  function gCancel(e: PointerEvent) { if (g && e.pointerId === g.id) { g = null; showHud(null); } }
  function handleTap(x: number, w: number) {
    if (locked) { showLockBtn(); return; }
    if (menu || help) { menu = ''; help = false; return; }
    const zone = zoneOf(x, w), r = registerTap(tapState, Date.now(), zone);
    tapState = r.state;
    clearTimeout(pendingTap);
    if (r.kind === 'seek') { seekBy(r.by, true); showRipple(zone, r.total); wake(); }
    else if (zone === 'center') toggleControls();
    else pendingTap = setTimeout(toggleControls, TAP_WINDOW + 20); // maybe the first half of a double tap
  }
  // lock: hides all controls and turns gestures off until the lock icon is held for 0.6 s
  function showLockBtn() { lockHint = true; clearTimeout(lockT); lockT = setTimeout(() => (lockHint = false), 3000); }
  function lockNow() { locked = true; menu = ''; flash(tr('player.lock.locked'), 2500); showLockBtn(); }
  let unlockT: ReturnType<typeof setTimeout>, unlockedAt = 0;
  function unlockDown() { lockHold = true; clearTimeout(unlockT); unlockT = setTimeout(() => { lockHold = false; locked = false; lockHint = false; unlockedAt = Date.now(); wake(); flash(tr('player.lock.unlocked'), 900); }, 600); }
  function unlockUp() { if (lockHold) { lockHold = false; clearTimeout(unlockT); flash(tr('player.lock.hold'), 1500); showLockBtn(); } }
  function lockKey(e: KeyboardEvent) { if (locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); locked = false; lockHint = false; unlockedAt = Date.now(); wake(); flash(tr('player.lock.unlocked'), 900); } }

  const syncTime = () => {
    if (!video) return;
    current = video.currentTime; duration = Number.isFinite(video.duration) ? video.duration : duration;
    if (current > 0 && !reconnecting && !error) lastPos = current;
    if ((rec.networkTries || rec.mediaRecovered) && current > errPos + 8) rec = freshRecovery(); // stable again: new error budget
    const b = video.buffered; buffered = b.length ? b.end(b.length - 1) : 0;
  };
  /** progress report that does not depend on timers (those are throttled in background tabs / Picture-in-Picture) */
  const reportTick = () => { if (started && !stopped && !casting && Date.now() - lastSent >= 10_000) send('progress'); };
  const onPlay = () => { fxEngine?.resume(); if (fxActive(fx) && !fxEngine?.routed) void applyFx(true); paused = false; if (stopped) { stopped = false; started = false; } if (!started) { started = true; send('start'); } else send('progress'); };

  onMount(() => {
    if (video) volOk = volumeSettable(video); // iOS cannot set the volume: no volume swipe there
    coarse = matchMedia('(pointer: coarse)').matches;
    const narrow = matchMedia('(max-width: 720px)'), setIcon = () => (ICON = narrow.matches ? 28 : 36);
    setIcon(); narrow.addEventListener?.('change', setIcon);
    try { const v = parseVolume(localStorage.getItem('ff_vol')); if (video && v !== null) { volume = v; video.volume = v; } } catch { /* ignore */ }
    load(startAt);
    castOff = onCastEvent(handleCast);
    if (!partyMode) void initCast();
    loadBookmarks();
    if ($serverCaps.chapters) api(`/api/items/${itemId}/chapters`).then((r) => (chapters = r?.supported ? normalizeChapters(r.chapters) : [])).catch(() => undefined);
    if ($serverCaps.segments.length) api(`/api/items/${itemId}/segments`).then((r) => (segments = (r.segments as typeof segments).map((x) => ({ ...x, type: String(x.type).toLowerCase() })).filter((x) => segmentShown($serverCaps, x.type)))).catch(() => undefined);
    progressTimer = setInterval(() => { if (started && !stopped) send('progress'); }, 10_000);
    pipOk = Boolean(document.pictureInPictureEnabled) && !video?.disablePictureInPicture;
    activityTimer = setInterval(() => {
      tick = Date.now();
      if (casting && castInfo && !castBusy && castInfo.expiresAt - tick < 10 * 60_000) void recast(castPos); // renew the token before it expires
      if (sleepAt) {
        if (tick >= sleepAt) { sleepAt = 0; sleepMin = 0; video?.pause(); flash(tr('player.sleep.paused'), 3000); }
        else sleepLeft = fmtClock((sleepAt - tick) / 1000);
      }
    }, 500);
    const bye = () => { if (!stopped) { stopped = true; send('stop', true); } if (casting) { castRevoke(castInfo); castStop(); } };
    // keep the resume position safe when the tab is hidden / the phone locks (Picture-in-Picture keeps playing: only a progress report, no stop)
    const vis = () => { if (document.visibilityState === 'hidden' && started && !stopped && !casting) send('progress', true); };
    const online = () => { if (reconnecting) retryNow(resumePos()); };
    const pipOn = () => { inPip = true; }, pipOff = () => { inPip = false; };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', vis);
    video?.addEventListener('enterpictureinpicture', pipOn); video?.addEventListener('leavepictureinpicture', pipOff);
    const fs = () => (fullscreen = Boolean(document.fullscreenElement));
    window.addEventListener('pagehide', bye);
    document.addEventListener('fullscreenchange', fs);
    window.addEventListener('ff-remote', onRemote);
    const touched = () => { noteInteraction(); fxGesture(); };
    window.addEventListener('pointerdown', touched, true); window.addEventListener('keydown', touched, true); window.addEventListener('ff-remote', touched);
    window.addEventListener('keydown', unmuteOnGesture, true);
    window.addEventListener('pointerdown', unmuteOnGesture, true);
    return () => {
      window.removeEventListener('pointerdown', touched, true); window.removeEventListener('keydown', touched, true); window.removeEventListener('ff-remote', touched);
      window.removeEventListener('pagehide', bye); document.removeEventListener('fullscreenchange', fs);
      window.removeEventListener('online', online); document.removeEventListener('visibilitychange', vis);
      video?.removeEventListener('enterpictureinpicture', pipOn); video?.removeEventListener('leavepictureinpicture', pipOff);
      narrow.removeEventListener?.('change', setIcon);
      window.removeEventListener('ff-remote', onRemote); window.removeEventListener('keydown', unmuteOnGesture, true); window.removeEventListener('pointerdown', unmuteOnGesture, true);
    };
  });
  onDestroy(() => {
    clearTimeout(peekT); fxEngine?.destroy();
    clearInterval(progressTimer); clearInterval(activityTimer); clearTimeout(toastTimer); clearTimeout(retryT); clearTimeout(spinT); clearTimeout(pendingTap); clearTimeout(hudT); clearTimeout(rippleT); clearTimeout(lockT); clearTimeout(unlockT); nowPlaying.set(null);
    if (started && !stopped) { stopped = true; send('stop'); }
    if (casting) { castRevoke(castInfo); castStop(); casting = false; } // leaving the page ends the cast session and revokes its token
    castOff?.();
    hls?.destroy();
  });
</script>

<svelte:window on:keydown={onKey} on:keydown|capture={onBackCapture} />
<div class="stage {subClasses($prefs.subtitleStyle)}" class:idle={!showUi} class:locked style="--inset:{inset}px" bind:this={stage} on:mousemove={() => { if (Date.now() - lastTouch > 800) wake(); }} on:click={onSurfaceClick} on:keydown={() => {}}
  on:pointerdown={gDown} on:pointermove={gMove} on:pointerup={gUp} on:pointercancel={gCancel} role="presentation">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} playsinline crossorigin="use-credentials" style:filter={brightness < 1 ? `brightness(${brightness})` : null}
    on:error={onVideoError}
    on:play={onPlay} on:pause={() => { paused = true; if (!castBusy && !casting && !stopped) send('progress'); }} on:seeked={() => started && send('progress')}
    on:ended={() => { stopped = true; paused = true; send('stop'); }}
    on:timeupdate={() => { syncTime(); reportTick(); }} on:progress={syncTime} on:loadedmetadata={syncTime}
    on:waiting={() => (waiting = true)} on:playing={onPlaying} on:canplay={() => { waiting = false; if (wantAutoplay) { wantAutoplay = false; playSafe(); } }}
    on:volumechange={() => { if (video) { muted = video.muted; } }}
    on:play on:pause on:seeked on:seeking on:waiting on:playing on:canplay on:timeupdate on:ended>
    {#if info}{#each info.subtitles as s}<track id="sub-{s.index}" kind="subtitles" src={s.url} srclang={s.language?.slice(0, 2) ?? 'xx'} label={s.title} />{/each}{/if}
  </video>

  <div class="sr" aria-live="polite" aria-atomic="true">{live}</div>
  {#if error}
    <div class="center errov" role="alertdialog" aria-labelledby="perr-t" aria-describedby="perr-d">
      <div class="errbox ui" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
        <b id="perr-t">{errTitle}</b><p id="perr-d">{error}</p>
        <div class="flex"><button class="btn light go" data-autofocus on:click={retryManually}>{$t('player.error.retry')}</button><button class="sec" on:click={leave}>{$t('player.error.back')}</button></div>
      </div>
    </div>
  {:else if reconnecting}
    <div class="center" role="status"><div class="reco ui"><div class="spin sm"></div><span>{$t('player.reconnecting')}</span><small>{$t('player.attempt', { n: reconnecting, max: MAX_NETWORK_TRIES })}</small></div></div>
  {:else if spin && waiting && !casting}<div class="center" role="status" aria-label={$t('player.loading')}><div class="spin"></div></div>{/if}
  {#if casting}
    <div class="center castov" role="status"><div class="castbox"><Icon name="cast" size={56} /><b>{$t('player.cast.playingOn', { name: $castState.deviceName || 'Chromecast' })}</b><button class="btn light ui" on:click|stopPropagation={() => castStop()}>{$t('player.cast.stop')}</button></div></div>
  {/if}
  {#if paused && !waiting && !error && !casting && !locked && !reconnecting}
    <button class="bigplay ui" aria-label={$t('player.controls.play')} on:click|stopPropagation={togglePlay}><Icon name="play" size={44} /></button>
  {/if}
  {#if toast}<div class="toast" aria-hidden="true">{toast}</div>{/if}
  {#if ripple}
    {#key ripple.n}<div class="rip {ripple.zone}" aria-hidden="true"></div>{/key}
    <div class="riplbl {ripple.zone}" aria-hidden="true"><Icon name={ripple.zone === 'left' ? 'rewind10' : 'forward10'} size={34} /><b>{$t('common.duration.s', { s: ripple.total })}</b></div>
  {/if}
  {#if hud}
    <div class="hud" aria-hidden="true"><Icon name={hud.icon} size={26} /><span>{hud.text}</span><i style="--p:{Math.max(0, Math.min(100, hud.pct))}%"></i></div>
  {/if}
  {#if coarse && !tvMode() && !casting && (locked ? lockHint : showUi)}
    <button class="lockbtn ic" class:holding={lockHold} aria-label={locked ? $t('player.lock.unlockAria') : $t('player.lock.lockAria')}
      on:pointerdown|stopPropagation={() => (locked ? unlockDown() : undefined)} on:pointerup|stopPropagation={unlockUp} on:pointercancel={unlockUp} on:pointerleave={unlockUp}
      on:keydown={lockKey} on:click|stopPropagation={() => { if (!locked && Date.now() - unlockedAt > 1000) lockNow(); }} on:contextmenu|preventDefault>
      <Icon name={locked ? 'lock' : 'unlock'} size={26} />
    </button>
  {/if}
  {#if help}
    <div class="help ui" role="dialog" aria-modal="true" aria-label={$t('player.shortcuts.title')} tabindex="-1" on:click|stopPropagation={() => (help = false)} on:keydown|stopPropagation>
      <div class="hbox" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
        <header><b>{$t('player.shortcuts.title')}</b><button class="icx" data-autofocus aria-label={$t('common.close')} on:click={() => (help = false)}><Icon name="x" size={20} /></button></header>
        <dl>{#each SHORTCUTS as s}<dt><kbd>{s.kKey ? $t(s.kKey) : s.k}</kbd></dt><dd>{$t(s.d)}</dd>{/each}</dl>
      </div>
    </div>
  {/if}

  <!-- overlays from the page (back button, next episode card, party chat/reactions) -->
  <div class="ovl" class:hide={!showUi}><slot name="top" /></div>
  <slot />

  {#if skip && !locked}<button class="skipbtn light" aria-keyshortcuts="S" on:click|stopPropagation={doSkip}>{segText($t, skip.type, 'skip')}{tvMode() ? $t('player.skipOk') : ''}</button>{/if}

  {#if showXray}
    <div class="cihost" class:hide={!showUi && !xray}><CastInfoPanel data={castData} failed={castFailed} autofocus={infoFocus} on:close={closeCastInfo} /></div>
  {:else if peek && !locked && menu === '' && !casting}
    <CastPeek data={castData} hint={tvMode() ? 'tv' : coarse ? 'none' : 'key'} on:more={() => openCastInfo(false)} />
  {/if}
  {#if subDlg}
    <div class="dlg ui" data-nav data-scope role="dialog" tabindex="-1" aria-modal="true" aria-label={$t('player.subs.search')} on:click|stopPropagation on:keydown|stopPropagation>
      <header><b>{$t('player.subs.search')}</b><button class="icx" aria-label={$t('common.close')} on:click={() => (subDlg = false)}><Icon name="x" size={20} /></button></header>
      <div class="flex"><select bind:value={subLang} aria-label={$t('player.subs.language')}>{#each SUB_LANGS as l}<option value={l}>{$t(`player.subs.langs.${l}`)}</option>{/each}</select><button disabled={subBusy} on:click={searchSubs}>{$t('player.subs.searchButton')}</button></div>
      {#if subMsg}<p class="muted">{subMsg}</p>{/if}
      {#if subResults?.length}<ul>{#each subResults as r}<li><button class="mi" disabled={subBusy} on:click={() => pickSub(r.id)}><Icon name="download" size={16} /><span class="grow">{r.name}</span><span class="muted">{r.provider}{r.downloads ? ` · ${r.downloads}×` : ''}</span></button></li>{/each}</ul>{/if}
    </div>
  {/if}

  <div class="ui ctl" data-nav class:hide={!showUi} on:click|stopPropagation on:keydown={ctlKey} role="toolbar" tabindex="-1" aria-label={$t('player.controls.toolbar')}>
    <div class="timeline">
      <div class="track" bind:this={trackEl} class:locked={!canControl} role="slider" tabindex="0" aria-label={$t('player.positionLabel')} aria-valuemin="0" aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(shown)}
        aria-valuetext={$t('player.valueText', { a: fmtClock(shown), b: fmtClock(duration) })}
        on:pointermove={onTrackMove} on:pointerleave={() => (hoverX = -1)} on:pointerdown={onTrackDown} on:pointerup={onTrackUp} on:pointercancel={onTrackUp} on:keydown={onTrackKey}>
        <div class="buf" style="width:{bufPct}%"></div>
        {#each segments as sg}{#if duration && sg.end > sg.start}<span class="seg {sg.type}" style="left:{(sg.start / duration) * 100}%;width:{((sg.end - sg.start) / duration) * 100}%" title={segText($t, sg.type, 'segment')} aria-hidden="true"></span>{/if}{/each}
        <div class="played" style="width:{pct}%"></div>
        {#each marks as m (m.i)}<span class="chap" style="left:{m.pct}%" aria-hidden="true"></span>{/each}
        {#each bookmarks as bm}{#if duration}<span class="mark" style="left:{(bm.position / duration) * 100}%" title="{fmtClock(bm.position)}{bm.note ? ' – ' + bm.note : ''}"></span>{/if}{/each}
        <div class="knob" style="left:{pct}%"></div>
        {#if hoverX >= 0}
          <div class="tip" style="left:{tipLeft}px">
            {#if tipChapter}<span class="chn">{tipChapter}</span>{/if}
            {#if thumb}<div class="thumb" style="width:{thumb.w}px;height:{thumb.h}px"><div style="width:{thumb.sw}px;height:{thumb.sh}px;background-image:url({thumb.url});background-size:{thumb.bw}px {thumb.bh}px;background-position:-{thumb.x}px -{thumb.y}px;transform:scale({thumb.k});transform-origin:0 0"></div></div>{/if}
            {fmtClock(scrubbing ? scrubTime : hoverTime)}
          </div>
        {/if}
      </div>
      <span class="rem" aria-hidden="true">{duration ? fmtClock(Math.max(0, duration - shown)) : '–'}</span>
    </div>
    <div class="row">
      <div class="grp">
        <button class="ic" class:locked={!canControl} aria-label={paused ? $t('player.controls.play') : $t('player.controls.pause')} on:click={togglePlay}><Icon name={paused ? 'play' : 'pause'} size={ICON} /></button>
        <button class="ic" class:locked={!canControl} aria-label={$t('player.controls.back10')} on:click={() => seekBy(-10)}><Icon name="rewind10" size={ICON} /></button>
        <button class="ic" class:locked={!canControl} aria-label={$t('player.controls.forward10')} on:click={() => seekBy(10)}><Icon name="forward10" size={ICON} /></button>
        <div class="vol">
          <button class="ic" aria-label={muted ? $t('player.unmute') : $t('player.mute')} on:click={toggleMute}><Icon name={muted || volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume'} size={ICON} /></button>
          <input class="vslider" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label={$t('player.volume.label')} on:input={(e) => setVolume(Number(e.currentTarget.value))} />
        </div>
        <span class="clock">{fmtClock(shown)} / {fmtClock(duration)}</span>
      </div>
      <div class="mid" title={barSub ? `${barTitle} · ${barSub}` : barTitle}>{#if barTitle}<b>{barTitle}</b>{#if barSub}<span>{barSub}</span>{/if}{/if}</div>
      <div class="grp right">
        <slot name="extra" />
        {#if hasNext}<button class="ic" aria-label={$t('player.controls.next')} title={$t('player.controls.nextKey')} on:click={() => dispatch('next')}><Icon name="skip-next" size={ICON} /></button>{/if}
        {#if seriesId}
          <div class="mwrap">
            <button class="ic" bind:this={epBtn} aria-label={$t('player.controls.episodes')} title={$t('player.controls.episodes')} aria-expanded={menu === 'episodes'} on:click={() => toggleMenu('episodes')}><Icon name="list" size={ICON} /></button>
            {#if menu === 'episodes'}<div class="menu bare"><EpisodesPanel {seriesId} {seasonId} currentId={itemId} on:pick={pickEpisode} on:close={closeEpisodes} /></div>{/if}
          </div>
        {/if}
        {#if showScenes}
          <div class="mwrap">
            <button class="ic" bind:this={scBtn} aria-label={$t('scenes.chapters.open')} title={$t('scenes.chapters.open')} aria-expanded={menu === 'chapters'} on:click={() => toggleMenu('chapters')}><Icon name="film" size={ICON} /></button>
            {#if menu === 'chapters'}<div class="menu bare"><ScenesPanel {chapters} current={shown} {duration} trickplay={info?.trickplay} on:seek={(e) => { seekTo(e.detail.time); closeScenes(); }} on:close={closeScenes} /></div>{/if}
          </div>
        {/if}
        <button class="ic" class:on={showXray || peek} bind:this={castBtn} aria-label={$t('scenes.info.open')} title={$t(coarse ? 'scenes.info.open' : 'scenes.info.openKey')} aria-pressed={showXray} on:click={castButton}><Icon name="users" size={ICON} /></button>
        {#if info}
          <div class="mwrap">
            <button class="ic" aria-label={$t('player.controls.tracks')} title={$t('player.controls.tracksKey')} aria-expanded={menu === 'tracks'} on:click={() => toggleMenu('tracks')}><Icon name="subtitles" size={ICON} /></button>
            {#if menu === 'tracks'}
              <div class="menu tracks" data-nav data-scope role="dialog" aria-label={$t('player.controls.tracks')}>
                {#if info.audioTracks.length > 1}
                  <div><h3>{$t('player.controls.audio')}</h3>
                    {#each info.audioTracks as a}<button class="mi" class:on={audioIndex === a.index || (audioIndex === undefined && a.isDefault)} on:click={() => { menu = ''; changeAudio(a.index); }}>{#if audioIndex === a.index || (audioIndex === undefined && a.isDefault)}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{a.title}</button>{/each}
                  </div>
                {/if}
                <div><h3>{$t('player.subs.title')}</h3>
                  <button class="mi" class:on={subIndex === -1} on:click={() => { setSubtitle(-1); menu = ''; }}>{#if subIndex === -1}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('common.off')}</button>
                  {#if $serverCaps.subtitleSearch}<button class="mi" on:click={() => { menu = ''; subDlg = true; subResults = null; subMsg = ''; }}><Icon name="search" size={16} />{$t('player.subs.searchMenu')}</button>{/if}
                  {#each info.subtitles as s}<button class="mi" class:on={subIndex === s.index} on:click={() => { setSubtitle(s.index); menu = ''; }}>{#if subIndex === s.index}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{s.title}</button>{/each}
                </div>
                <div class="fxcol"><h3>{$t('scenes.audio.title')}</h3>
                  {#each FX_OPTS as o (o.k)}<button class="mi fx" class:on={fx[o.k] && !fxDisabled} role="switch" aria-checked={fx[o.k]} disabled={Boolean(fxDisabled)} on:click={() => toggleFx(o.k)}>{#if fx[o.k] && !fxDisabled}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}<span class="fxl">{$t(o.label)}<small>{$t(o.hint)}</small></span></button>{/each}
                  {#if fxDisabled}<p class="fxnote">{$t(fxDisabled === 'casting' ? 'scenes.audio.casting' : 'scenes.audio.unsupported')}</p>
                  {:else if fxNote === 'suspended' && fxActive(fx)}<p class="fxnote">{$t('scenes.audio.needsTap', { name: $t(fx.voice ? 'scenes.audio.voice' : 'scenes.audio.night') })}</p>{/if}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        {#if !partyMode}
          <div class="mwrap">
            <button class="ic" aria-label={$t('player.speed.aria', { r: speedLabel(rate, $t) })} title={$t('player.speed.short')} aria-expanded={menu === 'speed'} on:click={() => toggleMenu('speed')}><Icon name="gauge" size={ICON} />{#if rate !== 1}<span class="ratebadge" aria-hidden="true">{$t('player.speed.rate', { r: rate })}</span>{/if}</button>
            {#if menu === 'speed'}
              <div class="menu speed" data-nav data-scope role="dialog" aria-label={$t('player.speed.title')}>
                <h3>{$t('player.speed.title')}</h3>
                <div class="speeds" role="group" aria-label={$t('player.speed.short')}>
                  {#each SPEEDS as r}<button class="sp-opt" class:on={rate === r} aria-pressed={rate === r} on:click={() => setRate(r)}><span class="dot" aria-hidden="true"></span>{speedLabel(r, $t)}</button>{/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        <div class="mwrap">
          <button class="ic" aria-label={$t('player.controls.more')} title={$t('player.controls.more')} aria-expanded={menu === 'more' || menu === 'scenes' || menu === 'settings'} on:click={() => (menu = menu === '' || (menu !== 'more' && menu !== 'scenes' && menu !== 'settings') ? 'more' : '')}>
            <svg width={ICON} height={ICON} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
            {#if sleepAt}<span class="sleepdot" title={$t('player.sleep.left', { t: sleepLeft })}></span>{/if}
          </button>
          {#if menu === 'more'}
            <div class="menu more" data-nav data-scope role="dialog" aria-label={$t('player.controls.more')}>
              <button class="mi" on:click={() => (menu = 'scenes')}><Icon name="bookmark" size={20} />{$t('player.bookmark.menu')}<span class="chev" aria-hidden="true">›</span></button>
              <button class="mi" class:on={showXray} aria-pressed={showXray} on:click={() => { if (showXray) { menu = ''; closeCastInfo(); } else openCastInfo(tvMode()); }}><Icon name="users" size={20} />{$t('scenes.info.open')}</button>
              {#if !partyMode && ($castState.available || $castState.connected)}<button class="mi" class:on={casting} aria-pressed={casting} on:click={castClick}><Icon name="cast" size={20} />{castLabel}</button>{/if}
              {#if pipOk && !casting}<button class="mi" class:on={inPip} aria-pressed={inPip} aria-keyshortcuts="P" on:click={() => { menu = ''; void pip(); }}><Icon name="pip" size={20} />{$t('player.controls.pip')}</button>{/if}
              <button class="mi" on:click={() => (menu = 'settings')}><Icon name="settings" size={20} />{$t('player.controls.settings')}{#if sleepAt}<span class="muted"> · {$t('player.sleep.left', { t: sleepLeft })}</span>{/if}<span class="chev" aria-hidden="true">›</span></button>
              {#if modeLabel}<p class="modeinfo"><Icon name="info" size={16} /><span>{$t('player.mode.label', { mode: modeLabel })}</span></p>{/if}
            </div>
          {:else if menu === 'scenes'}
            <div class="menu scenes" data-nav data-scope role="dialog" aria-label={$t('player.bookmark.scenesAria')}>
              <h3><button class="back" aria-label={$t('player.controls.backToMore')} on:click={() => (menu = 'more')}>‹</button>{$t('player.bookmark.scenes')}</h3>
              <button class="mi" on:click={shareScene}><Icon name="share" size={18} />{$t('player.bookmark.share', { t: fmtClock(shown) })}</button>
              <form class="addnote" on:submit|preventDefault={addBookmark}><input bind:value={noteText} maxlength="140" placeholder={$t('player.bookmark.note')} aria-label={$t('player.bookmark.noteAria')} /><button aria-label={$t('player.bookmark.add')}><Icon name="bookmark" size={18} /></button></form>
              {#each bookmarks as bm (bm.id)}
                <div class="bm"><button class="mi" on:click={() => { seekTo(bm.position); menu = ''; }}><span class="muted">{fmtClock(bm.position)}</span>{bm.note || $t('player.bookmark.title')}</button><button class="icx" aria-label={$t('player.bookmark.remove')} on:click={() => removeBookmark(bm.id)}><Icon name="x" size={16} /></button></div>
              {:else}<p class="muted pad">{$t('player.bookmark.none')}</p>{/each}
            </div>
          {:else if menu === 'settings'}
            <div class="menu tracks" data-nav data-scope role="dialog" aria-label={$t('player.controls.settings')}>
              <div><h3><button class="back" aria-label={$t('player.controls.backToMore')} on:click={() => (menu = 'more')}>‹</button>{$t('player.quality.title')}</h3>
                <button class="mi" class:on={quality === 0} on:click={() => changeQuality(0)}>{#if quality === 0}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('player.quality.auto')}</button>
                {#each qualityOptions as [label, bps]}<button class="mi" class:on={quality === bps} on:click={() => changeQuality(bps)}>{#if quality === bps}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{label}</button>{/each}
              </div>
              {#if !partyMode}
                <div><h3>{$t('player.sleep.title')}</h3>
                  <button class="mi" class:on={!sleepAt && !sleepAfterEpisode} on:click={() => setSleep(0)}>{#if !sleepAt && !sleepAfterEpisode}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('common.off')}</button>
                  {#each [15, 30, 45, 60] as m}<button class="mi" class:on={sleepMin === m && sleepAt > 0} on:click={() => setSleep(m)}>{#if sleepMin === m && sleepAt > 0}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('common.duration.m', { m })}{#if sleepMin === m && sleepAt > 0}<span class="muted"> ({sleepLeft})</span>{/if}</button>{/each}
                  <button class="mi" class:on={sleepAfterEpisode} on:click={() => setSleep('end')}>{#if sleepAfterEpisode}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('player.sleep.afterEpisodeOption')}</button>
                </div>
              {/if}
              {#if !coarse}<div><h3>{$t('player.controls.help')}</h3><button class="mi" on:click={() => { menu = ''; help = true; }}><Icon name="keyboard" size={16} />{$t('player.shortcuts.menu')}</button></div>{/if}
            </div>
          {/if}
        </div>
        <button class="ic" aria-label={fullscreen ? $t('player.controls.exitFullscreen') : $t('player.controls.fullscreen')} title={$t('player.controls.fullscreenKey')} on:click={toggleFullscreen}><Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={ICON} /></button>
      </div>
    </div>
  </div>
</div>

<style>
  .stage { position: relative; width: 100%; background: #000; color: #fff; overflow: hidden; user-select: none; -webkit-user-select: none; touch-action: none; -webkit-touch-callout: none; }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .stage :global(button:focus-visible), .stage :global(a:focus-visible), .stage :global([role=slider]:focus-visible) { outline: 3px solid #fff; outline-offset: 2px; }
  .stage.idle { cursor: none; }
  .stage :global(video) { display: block; width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #000; }
  .stage :global(video::cue) { background: rgba(0,0,0,.65); font-size: 1.15em; color: #fff; font-family: sans-serif; }
  .stage.sub-size-s :global(video::cue) { font-size: .9em; }
  .stage.sub-size-m :global(video::cue) { font-size: 1.15em; }
  .stage.sub-size-l :global(video::cue) { font-size: 1.5em; }
  .stage.sub-size-xl :global(video::cue) { font-size: 1.9em; }
  .stage.sub-color-white :global(video::cue) { color: #fff; }
  .stage.sub-color-yellow :global(video::cue) { color: #ffe14d; }
  .stage.sub-color-cyan :global(video::cue) { color: #4de8ff; }
  .stage.sub-color-green :global(video::cue) { color: #6dff7a; }
  .stage.sub-bg-none :global(video::cue) { background: transparent; text-shadow: none; }
  .stage.sub-bg-shadow :global(video::cue) { background: transparent; text-shadow: 0 0 4px #000, 0 0 4px #000, 1px 1px 3px #000; }
  .stage.sub-bg-semi :global(video::cue) { background: rgba(0,0,0,.65); text-shadow: none; }
  .stage.sub-bg-solid :global(video::cue) { background: #000; text-shadow: none; }
  .stage.sub-font-sans :global(video::cue) { font-family: system-ui, sans-serif; }
  .stage.sub-font-serif :global(video::cue) { font-family: Georgia, 'Times New Roman', serif; }
  .stage.sub-font-mono :global(video::cue) { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .center { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 3; }
  .spin { width: 62px; height: 62px; border: 5px solid rgba(255,255,255,.25); border-top-color: var(--acc); border-radius: 50%; animation: sp .9s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .spin.sm { width: 34px; height: 34px; border-width: 4px; }
  .errov { background: rgba(0,0,0,.82); pointer-events: auto; z-index: 11; }
  .errbox, .reco { display: grid; justify-items: center; gap: .8rem; text-align: center; max-width: min(460px, 90%); padding: 1.4rem 1.6rem; background: rgba(16,20,24,.92); border: 1px solid #323a43; border-radius: 10px; }
  .errbox b { font-size: 1.3rem; } .errbox p { margin: 0; color: #cfcfcf; } .errbox .flex { display: flex; gap: .6rem; flex-wrap: wrap; justify-content: center; }
  .reco { pointer-events: none; font-weight: 600; } .reco small { color: var(--mut); font-weight: 400; }
  .rip { position: absolute; top: 0; bottom: 0; width: 38%; z-index: 5; pointer-events: none; background: rgba(255,255,255,.2); animation: rip .7s ease-out forwards; }
  .rip.left { left: 0; border-radius: 0 100% 100% 0 / 0 50% 50% 0; } .rip.right { right: 0; border-radius: 100% 0 0 100% / 50% 0 0 50%; }
  @keyframes rip { from { opacity: 1; transform: scale(.7); } to { opacity: 0; transform: scale(1); } }
  .riplbl { position: absolute; top: 50%; transform: translateY(-50%); z-index: 6; pointer-events: none; display: grid; justify-items: center; gap: .1rem; text-shadow: 0 1px 6px #000; }
  .riplbl.left { left: 12%; } .riplbl.right { right: 12%; }
  .hud { position: absolute; top: 12%; left: 50%; transform: translateX(-50%); z-index: 9; display: flex; align-items: center; gap: .6rem; padding: .55rem 1.1rem; border-radius: 999px; background: rgba(0,0,0,.72); font-weight: 600; pointer-events: none; font-variant-numeric: tabular-nums; position: absolute; overflow: hidden; }
  .hud i { position: absolute; left: 0; bottom: 0; height: 3px; width: var(--p); background: var(--acc); }
  .lockbtn { position: absolute; left: max(.8rem, env(safe-area-inset-left)); bottom: 8rem; z-index: 10; width: 48px; min-height: 48px; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.5); }
  .lockbtn.holding { background: var(--acc); }
  .stage.locked { cursor: none; }
  .help { position: absolute; inset: 0; z-index: 13; display: grid; place-items: center; background: rgba(0,0,0,.7); }
  .hbox { width: min(520px, 92vw); max-height: 86%; overflow: auto; background: rgba(16,20,24,.98); border: 1px solid #323a43; border-radius: 10px; padding: 1rem 1.2rem; }
  .hbox header { display: flex; justify-content: space-between; align-items: center; margin-bottom: .6rem; }
  .hbox dl { display: grid; grid-template-columns: max-content 1fr; gap: .45rem 1.2rem; margin: 0; align-items: center; } .hbox dt, .hbox dd { margin: 0; }
  kbd { font: inherit; font-size: .85rem; background: #2b333c; border: 1px solid #4a5560; border-bottom-width: 2px; border-radius: 4px; padding: .1rem .5rem; white-space: nowrap; }
  .seg { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.38); pointer-events: none; border-left: 2px solid rgba(255,255,255,.9); border-radius: 2px; }
  .seg.preview { background: rgba(190,120,255,.4); border-left-color: #be78ff; }
  .seg.outro { background: rgba(245,197,24,.45); border-left-color: #f5c518; } .seg.recap { background: rgba(120,170,255,.4); border-left-color: #78aaff; }
  .bigplay { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 96px; height: 96px; border-radius: 50%; background: rgba(0,0,0,.55); border: 3px solid #fff; z-index: 4; }
  .bigplay:hover:not(:disabled) { background: rgba(0,0,0,.75); }
  .castov { background: #000; pointer-events: none; z-index: 2; }
  .castbox { display: grid; justify-items: center; gap: .9rem; text-align: center; color: #fff; }
  .castbox button { pointer-events: auto; border: 1px solid #fff; padding: .6rem 1.4rem; }
  .toast { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); background: rgba(0,0,0,.75); padding: .55rem 1.2rem; border-radius: 999px; z-index: 9; font-weight: 600; max-width: 90%; text-align: center; }
  .skipbtn { position: absolute; right: calc(var(--pad-x) + var(--inset, 0px)); bottom: 7.5rem; z-index: 8; border: 1px solid #fff; padding: .7rem 1.5rem; }
  .ovl { position: absolute; inset: 0 var(--inset, 0px) auto 0; z-index: 7; pointer-events: none; transition: opacity var(--t-med); }
  .ovl :global(*) { pointer-events: auto; }
  .ovl.hide { opacity: 0; } .ovl.hide :global(*) { pointer-events: none; }

  .ctl { position: absolute; left: 0; right: var(--inset, 0px); bottom: 0; z-index: 8; padding: 3.5rem clamp(.6rem, 2.4vw, 2.4rem) .9rem; background: linear-gradient(transparent, rgba(0,0,0,.85)); transition: opacity var(--t-med); }
  .ctl.hide { opacity: 0; pointer-events: none; }
  .timeline { display: flex; align-items: center; gap: 1rem; }
  .track { position: relative; flex: 1; height: 5px; background: rgba(255,255,255,.28); border-radius: 3px; cursor: pointer; touch-action: none; transition: height var(--t-fast); margin: 10px 0; }
  .track::before { content: ''; position: absolute; left: 0; right: 0; top: -20px; bottom: -20px; } /* bigger hit area */
  .track:hover, .track:focus-visible { height: 9px; }
  .track.locked { cursor: not-allowed; }
  .buf { position: absolute; inset: 0 auto 0 0; background: rgba(255,255,255,.35); border-radius: 3px; }
  .played { position: absolute; inset: 0 auto 0 0; background: var(--acc); border-radius: 3px; }
  .knob { z-index: 2; position: absolute; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: var(--acc); border-radius: 50%; transform: scale(0); transition: transform var(--t-fast); }
  .track:hover .knob, .track:focus-visible .knob { transform: scale(1); }
  .tip { position: absolute; bottom: 22px; transform: translateX(-50%); background: rgba(16,20,24,.95); padding: .15rem .35rem .2rem; border-radius: 4px; font-size: .85rem; pointer-events: none; text-align: center; }
  .thumb { overflow: hidden; border-radius: 3px; margin: .2rem 0 .25rem; background: #0c1014; }
  .mark { position: absolute; top: -3px; width: 4px; height: 11px; margin-left: -2px; background: #f5c518; border-radius: 2px; pointer-events: none; }
  .ic.on { color: var(--acc); }
  .menu.scenes { min-width: 280px; max-width: 92vw; } .menu.scenes .addnote { display: flex; gap: .4rem; padding: .3rem .6rem .6rem; } .menu.scenes .addnote input { flex: 1; min-width: 0; min-height: 38px; }
  .bm { display: flex; align-items: center; } .bm .mi { flex: 1; } .bm .mi .muted { min-width: 3rem; }
  .icx { background: transparent; padding: 0; width: 44px; min-height: 44px; color: var(--mut); } .icx:hover:not(:disabled) { background: rgba(255,255,255,.12); color: #fff; }
  .pad { padding: .3rem .8rem; }
  .cihost { transition: opacity var(--t-med); } .cihost.hide { opacity: 0; pointer-events: none; } .cihost.hide :global(*) { pointer-events: none; }
  /* chapter starts: small gaps in the seek bar (above buffer/played, below the knob) */
  .chap { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1.5px; background: rgba(0,0,0,.85); pointer-events: none; z-index: 1; }
  .chn { display: block; max-width: 220px; margin: .1rem auto .15rem; font-weight: 700; font-size: .82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fxcol { min-width: 170px; } .mi.fx { white-space: normal; align-items: flex-start; } .mi.fx :global(svg), .mi.fx .sp { margin-top: .2rem; }
  .fxl { display: grid; line-height: 1.25; } .fxl small { color: var(--mut); font-weight: 400; font-size: .78rem; }
  .fxnote { margin: .3rem .6rem 0; font-size: .78rem; color: var(--mut); max-width: 220px; }
  .dlg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 12; background: rgba(16,20,24,.98); border: 1px solid #323a43; border-radius: 10px; padding: 1rem 1.2rem; width: min(520px, 92vw); max-height: 70%; overflow: auto; display: grid; gap: .8rem; }
  .dlg header { display: flex; justify-content: space-between; align-items: center; } .dlg ul { list-style: none; padding: 0; margin: 0; } .grow { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; }
  .sleepdot { position: absolute; top: 10px; right: 10px; width: 9px; height: 9px; border-radius: 50%; background: var(--acc); }
  .rem { min-width: 3.4rem; text-align: right; font-variant-numeric: tabular-nums; }
  /* Control bar: controls left, title centred, extras right */
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr); align-items: center; gap: .6rem; }
  .grp { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
  .grp.right { justify-content: flex-end; }
  .mid { min-width: 0; max-width: 40vw; display: flex; align-items: baseline; justify-content: center; gap: .6rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 1.05rem; }
  .mid b { font-weight: 700; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .mid span { color: #d8d8d8; font-weight: 400; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .ic { position: relative; background: transparent; padding: 0; width: 56px; min-height: 56px; border-radius: 50%; color: #fff; display: inline-grid; place-items: center; }
  .ic:hover:not(:disabled) { background: rgba(255,255,255,.14); transform: scale(1.08); }
  .ic.locked { opacity: .4; }
  .vol { display: flex; align-items: center; }
  .vslider { width: 0; opacity: 0; transition: width var(--t-med) var(--ease), opacity var(--t-med); padding: 0; min-height: 0; accent-color: var(--acc); background: transparent; border: 0; }
  .vol:hover .vslider, .vol:focus-within .vslider { width: 92px; opacity: 1; margin-right: .6rem; }
  .clock { margin-left: .8rem; font-size: .9rem; color: #e0e0e0; font-variant-numeric: tabular-nums; }
  .ratebadge { position: absolute; right: 2px; bottom: 4px; font-size: .62rem; font-weight: 700; background: var(--acc-fill); color: #fff; border-radius: 3px; padding: 0 .2rem; line-height: 1.3; }
  .menu.bare { padding: 0; background: none; border: 0; box-shadow: none; min-width: 0; }
  .menu.more { min-width: 270px; padding: .4rem .3rem; }
  .menu.more .mi { min-height: 48px; font-size: .98rem; gap: .8rem; }
  .chev { margin-left: auto; font-size: 1.3rem; color: var(--mut); padding-left: .8rem; }
  .modeinfo { display: flex; gap: .5rem; align-items: center; margin: .3rem .6rem .2rem; padding-top: .5rem; border-top: 1px solid #2b333c; color: var(--mut); font-size: .82rem; }
  .menu h3 .back { background: transparent; padding: 0; width: 32px; min-height: 32px; margin-right: .3rem; font-size: 1.4rem; line-height: 1; color: #fff; border-radius: 50%; }
  .menu h3 .back:hover:not(:disabled) { background: rgba(255,255,255,.12); }
  .menu.speed { padding: 1rem 1.2rem 1.1rem; min-width: 0; }
  .menu.speed h3 { margin: 0 0 .9rem; }
  .speeds { display: flex; gap: .2rem; position: relative; }
  .speeds::before { content: ''; position: absolute; left: 2.2rem; right: 2.2rem; top: 21px; height: 2px; background: #4f5964; }
  .sp-opt { position: relative; display: grid; justify-items: center; gap: .45rem; min-width: 72px; min-height: 64px; padding: .2rem .3rem; background: transparent; color: #bdbdbd; font-weight: 400; font-size: .85rem; white-space: nowrap; border-radius: 4px; }
  .sp-opt .dot { width: 14px; height: 14px; margin-top: 8px; border-radius: 50%; background: #8a8a8a; }
  .sp-opt.on { color: #fff; font-weight: 700; }
  .sp-opt.on .dot { width: 24px; height: 24px; margin-top: 3px; background: #fff; box-shadow: 0 0 0 4px rgba(255,255,255,.25); }
  .sp-opt:hover:not(:disabled) { background: rgba(255,255,255,.08); color: #fff; }
  .mwrap { position: relative; }
  .menu { position: absolute; right: 0; bottom: 64px; background: rgba(16,20,24,.97); border: 1px solid #323a43; border-radius: 6px; padding: .6rem .3rem; min-width: 190px; box-shadow: 0 12px 30px #000; z-index: 20; }
  .menu.tracks { display: flex; gap: 1rem; padding: .8rem; min-width: 360px; max-width: min(94vw, 720px); }
  .menu.tracks > div { flex: 1; min-width: 118px; }
  .mi { white-space: nowrap; }
  .menu h3 { font-size: 1rem; margin: 0 .6rem .4rem; }
  .mi { display: flex; width: 100%; justify-content: flex-start; align-items: center; gap: .5rem; background: transparent; color: #d2d2d2; font-weight: 400; padding: .35rem .6rem; min-height: 44px; text-align: left; border-radius: 4px; }
  .mi:hover:not(:disabled) { background: rgba(255,255,255,.1); color: #fff; } .mi.on { color: #fff; font-weight: 700; }
  .sp { width: 16px; flex: none; }
  /* TV: bigger targets, strong focus, no volume slider (the TV has its own volume) */
  :global(html.tv) .ic { width: 64px; min-height: 64px; }
  :global(html.tv) .ic:focus-visible { background: rgba(255, 255, 255, .22); transform: scale(1.12); }
  :global(html.tv) .vol { display: none; }
  :global(html.tv) .clock { font-size: 1.1rem; }
  :global(html.tv) .track:focus-visible { height: 12px; outline: none; box-shadow: 0 0 0 4px #fff; }
  :global(html.tv) .mi { min-height: 56px; font-size: 1.05rem; }
  :global(html.tv) .skipbtn { font-size: 1.15rem; }
  @media (max-width: 720px) {
    .clock, .vol .vslider, .mid { display: none; }
    .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0; }
    .grp { gap: 0; }
    .menu.tracks { flex-direction: column; }
    .ic { width: 44px; min-height: 44px; }
    .bigplay { width: 76px; height: 76px; }
    /* phones: panels sit above the control bar across the full width instead of hanging off a button */
    .menu, .menu.tracks, .menu.more, .menu.scenes, .menu.speed, .menu.bare { position: fixed; left: .5rem; right: .5rem; bottom: 8.6rem; min-width: 0; max-width: none; max-height: 60vh; overflow-y: auto; }
    .menu.bare { overflow: visible; }
    .menu.bare :global(.eps), .menu.bare :global(.scn) { width: 100%; max-height: 60vh; }
    .lockbtn { bottom: auto; top: 5.5rem; } /* the two-row bar is taller on phones: keep the lock clear of the timeline */
    .speeds { flex-wrap: wrap; justify-content: center; } .speeds::before { display: none; } .sp-opt { min-width: 64px; }
  }
</style>
