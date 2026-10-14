<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { tick } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  /** Trailer for a title that is not in the library. Nothing from YouTube loads before the click; the key is fetched on click. */
  export let mediaType: string;
  export let tmdbId: number;
  export let title: string;
  let open = false, busy = false, none = false, key = '', box: HTMLDivElement, closeBtn: HTMLButtonElement, opener: Element | null = null;

  const portal = (n: HTMLElement) => { document.body.appendChild(n); return { destroy: () => n.remove() }; };

  async function show() {
    if (busy) return;
    if (!key) {
      busy = true;
      try { key = (await api(`/api/seerr/${mediaType}/${tmdbId}/trailer`)).key; } catch { none = true; }
      busy = false;
      if (none) return;
    }
    opener = document.activeElement; open = true; document.body.style.overflow = 'hidden';
    await tick(); closeBtn?.focus();
  }
  function close() {
    open = false; document.body.style.overflow = '';
    (opener as HTMLElement | null)?.focus?.();
  }
  function onkey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') e.preventDefault(), closeBtn?.focus(); // the only focusable control is the close button
  }
</script>

<svelte:window on:keydown|capture={onkey} />
{#if none}<span class="muted" role="status">{$t('home.trailer.none')}</span>
{:else}<button class="sec" data-nav disabled={busy} aria-label={$t('home.trailer.watch', { title })} on:click={show}><Icon name="play" size={14} /> {$t('home.trailer.button')}</button>{/if}
{#if open}
  <div use:portal>
    <div class="scrim" on:click={close} role="presentation"></div>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={$t('home.trailer.dialog', { title })} bind:this={box}>
      <button class="x" data-nav bind:this={closeBtn} aria-label={$t('home.trailer.close')} on:click={close}><Icon name="x" size={22} /></button>
      <iframe src={`https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0&modestbranding=1`} allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title={$t('home.trailer.dialog', { title })}></iframe>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 90; }
  .dlg { position: fixed; z-index: 91; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(960px, 96vw); aspect-ratio: 16 / 9; background: #000; border-radius: 10px; }
  iframe { width: 100%; height: 100%; border: 0; border-radius: 10px; }
  .x { position: absolute; right: 0; top: -48px; width: 40px; min-height: 40px; height: 40px; padding: 0; border-radius: 50%; background: rgba(24,24,24,.85); }
  button:not(.x) { display: inline-flex; align-items: center; justify-content: center; gap: .3rem; }
</style>
