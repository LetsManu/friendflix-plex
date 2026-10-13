<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { getDownload, getMeta, putDownload, queueProgress, type DownloadRecord } from '#lib/offline/db';
  import { getFile } from '#lib/offline/opfs';
  import { REASON_KEY, isPlayable } from '#lib/offline/license';
  import { t, tr } from '#lib/i18n';
  import { subClasses } from '#lib/substyle';
  import { DEFAULT_PREFS, prefs } from '#lib/stores';

  /** Lean player for downloaded files: no API calls, native controls, subtitles from local VTT files. */
  export let dl: DownloadRecord;
  const dispatch = createEventDispatcher<{ close: void }>();

  let video: HTMLVideoElement;
  let src = '';
  let tracks: Array<{ lang: string; title: string; url: string }> = [];
  let blobs: string[] = [];
  let error = '';
  let lastSave = 0, ready = false;

  // WebKit cannot reliably play huge blob URLs; the service worker serves the OPFS file with Range support instead.
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const webkit = /iPad|iPhone|iPod/.test(ua) || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Android|Edg\//.test(ua));
  $: style = subClasses({ ...DEFAULT_PREFS.subtitleStyle, ...($prefs?.subtitleStyle ?? {}) });

  onMount(async () => {
    try {
      const meta = { maxSeenTime: Number((await getMeta<number>('maxSeenTime')) ?? 0) };
      const verdict = isPlayable(dl, Date.now(), meta);
      if (!verdict.ok) { error = tr(REASON_KEY[verdict.reason ?? 'not_done']); return; }
      const file = await getFile(dl.id, 'video.mp4');
      if (!file || file.size === 0) { error = tr('account.offline.fileMissing'); return; }
      if (webkit && 'serviceWorker' in navigator && navigator.serviceWorker.controller) src = `/__dl/${dl.id}/video.mp4`;
      else { src = URL.createObjectURL(file); blobs.push(src); }
      for (const s of dl.subs) {
        const f = await getFile(dl.id, s.file);
        if (f) { const url = URL.createObjectURL(f); blobs.push(url); tracks = [...tracks, { lang: s.lang, title: s.title, url }]; }
      }
      ready = true;
    } catch { error = tr('account.offline.playFailed'); }
  });

  function onLoaded() {
    if (dl.positionSec > 5 && video.duration && dl.positionSec < video.duration - 30) video.currentTime = dl.positionSec;
    video.play().catch(() => undefined);
  }

  /** persist the position and queue a progress event for the next online sync (newest event per item wins) */
  async function save(force = false) {
    if (!video || !ready) return;
    const now = Date.now();
    if (!force && now - lastSave < 10_000) return;
    lastSave = now;
    const pos = video.currentTime, dur = video.duration || (dl.runtimeTicks ?? 0) / 1e7;
    if (!Number.isFinite(pos) || pos <= 0) return;
    const played = dur > 0 && pos / dur >= 0.9;
    try {
      const cur = (await getDownload(dl.id)) ?? dl; // keep manager-owned fields (state, licence) as they are now
      dl = { ...cur, positionSec: played ? 0 : Math.floor(pos), updatedAt: now };
      await putDownload(dl);
      await queueProgress({ itemId: dl.itemId, downloadId: dl.id, positionTicks: Math.floor(pos * 1e7), played, at: now });
    } catch { /* storage unavailable: nothing to do */ }
  }
  const onHide = () => { if (document.visibilityState === 'hidden') void save(true); };
  function close() { video?.pause(); void save(true); dispatch('close'); }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }

  onDestroy(() => { blobs.forEach((u) => URL.revokeObjectURL(u)); blobs = []; });
</script>

<svelte:window on:keydown={onKey} on:pagehide={() => save(true)} />
<svelte:document on:visibilitychange={onHide} />

<div class="op {style}" role="dialog" aria-label={dl.title}>
  <div class="bar">
    <button type="button" class="back" on:click={close} aria-label={$t('account.offline.back')}>{$t('account.offline.backButton')}</button>
    <span class="t">{dl.seriesName ? `${dl.seriesName} · ` : ''}{dl.s != null && dl.e != null ? `S${dl.s} E${dl.e} · ` : ''}{dl.title}</span>
  </div>
  {#if error}
    <div class="msg" role="alert">{error}</div>
  {:else if src}
    <!-- svelte-ignore a11y-media-has-caption -->
    <video bind:this={video} {src} controls playsinline preload="metadata" on:loadedmetadata={onLoaded} on:timeupdate={() => save()} on:pause={() => save(true)} on:ended={() => save(true)} crossorigin="anonymous">
      {#each tracks as t}<track kind="subtitles" src={t.url} srclang={t.lang.slice(0, 2) || 'xx'} label={t.title} />{/each}
    </video>
  {:else}
    <div class="msg" role="status">{$t('account.offline.loading')}</div>
  {/if}
</div>

<style>
  .op { position: fixed; inset: 0; z-index: 100; background: #000; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 1rem; padding: .5rem 1rem; padding-top: max(.5rem, var(--safe-top)); min-height: 52px; }
  .back { background: transparent; font-size: 1rem; }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
  video { flex: 1; min-height: 0; width: 100%; background: #000; }
  .msg { margin: auto; padding: 2rem; text-align: center; max-width: 30rem; }
  .op.sub-size-s :global(video::cue) { font-size: .9em; }
  .op.sub-size-m :global(video::cue) { font-size: 1.15em; }
  .op.sub-size-l :global(video::cue) { font-size: 1.5em; }
  .op.sub-size-xl :global(video::cue) { font-size: 1.9em; }
  .op.sub-color-white :global(video::cue) { color: #fff; }
  .op.sub-color-yellow :global(video::cue) { color: #ffe14d; }
  .op.sub-color-cyan :global(video::cue) { color: #4de8ff; }
  .op.sub-color-green :global(video::cue) { color: #6dff7a; }
  .op.sub-bg-none :global(video::cue) { background: transparent; text-shadow: none; }
  .op.sub-bg-shadow :global(video::cue) { background: transparent; text-shadow: 0 0 4px #000, 0 0 4px #000, 1px 1px 3px #000; }
  .op.sub-bg-semi :global(video::cue) { background: rgba(0,0,0,.65); text-shadow: none; }
  .op.sub-bg-solid :global(video::cue) { background: #000; text-shadow: none; }
  .op.sub-font-sans :global(video::cue) { font-family: system-ui, sans-serif; }
  .op.sub-font-serif :global(video::cue) { font-family: Georgia, 'Times New Roman', serif; }
  .op.sub-font-mono :global(video::cue) { font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
