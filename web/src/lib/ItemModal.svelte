<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import DetailView from '#lib/detail/DetailView.svelte';
  import { holdBillboard } from '#lib/preview';
  import { t } from '#lib/i18n';

  export let id: string;
  let item: Item | null = null, failed = false;
  let closeBtn: HTMLButtonElement, box: HTMLDivElement, overlay: HTMLDivElement;
  let opener: Element | null = null;

  // another title opened inside the dialog (Mehr davon): start at the top again
  $: id, overlay && (overlay.scrollTop = 0);

  function loaded() {
    // TV: the play button is the natural first stop (the close button is reached with Back)
    if (document.documentElement.classList.contains('tv')) tick().then(() => box?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
  }

  const close = () => history.back();
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab' && box) { // keep focus inside the dialog
      const f = [...box.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((n) => n.getClientRects().length);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  const scrimClick = (e: MouseEvent) => { if (e.target === e.currentTarget) close(); };

  onMount(() => {
    opener = document.activeElement;
    const release = holdBillboard(); // the billboard behind the dialog pauses while it is open
    document.body.style.overflow = 'hidden';
    // everything behind the dialog (siblings of the overlay in the app root) becomes inert
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(overlay?.parentElement?.children ?? []) as HTMLElement[]) {
      if (el === overlay || el.tagName === 'SCRIPT' || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', ''); inerted.push(el);
    }
    tick().then(() => closeBtn?.focus());
    return () => { release(); document.body.style.overflow = ''; for (const el of inerted) el.removeAttribute('inert'); (opener as HTMLElement | null)?.focus?.(); };
  });
</script>

<svelte:window on:keydown={key} />
<!-- the overlay is the scroll container: the page behind is locked, long dialogs scroll inside it -->
<div class="overlay" bind:this={overlay} on:click={scrimClick} role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label={item ? undefined : $t('detail.view.details')} aria-labelledby={item ? 'modal-title' : undefined} bind:this={box}>
    <button type="button" class="x" bind:this={closeBtn} aria-label={$t('common.close')} on:click={close}><Icon name="x" size={22} /></button>
    <DetailView {id} variant="modal" titleId="modal-title" bind:item bind:failed on:loaded={loaded} />
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 80; overflow-y: auto; overscroll-behavior: contain; background: rgba(0, 0, 0, .75); animation: fade var(--t-med) var(--ease); padding: 2rem 0 3rem; }
  .modal { position: relative; width: min(850px, 96vw); margin: 0 auto; background: var(--surface); border-radius: 8px; box-shadow: 0 20px 60px #000; overflow: hidden; animation: pop var(--t-med) var(--ease); }
  .x { position: absolute; right: .8rem; top: .8rem; z-index: 5; width: 40px; min-height: 40px; height: 40px; padding: 0; border-radius: 50%; background: rgba(24, 24, 24, .85); }
  @keyframes fade { from { opacity: 0; } } @keyframes pop { from { opacity: 0; transform: translateY(18px) scale(.97); } }
  @media (hover: none), (pointer: coarse) { .x { width: 44px; min-height: 44px; height: 44px; } }
  /* phones: full screen below the status bar; a border (outside the scroll box) rather than padding, so sticky tabs stop under it */
  @media (max-width: 640px) { .overlay { padding: 0; border-top: var(--safe-top) solid var(--surface); } .modal { width: 100vw; min-height: calc(100vh - var(--safe-top)); border-radius: 0; } }
</style>
