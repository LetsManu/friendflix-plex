<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { LOCALES, loadLocale, trIn, type Locale } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';

  /**
   * Language choice shown once (full screen):
   * - `instance`: first admin visit without a stored instance default (bilingual title, not skippable)
   * - `profile`: first login of a profile without a stored language (skippable: keeps the instance default)
   * The texts of the picker preview the highlighted language.
   */
  export let mode: 'instance' | 'profile' = 'profile';
  export let preselect: Locale = 'de';
  /** saves the choice; reject to show an error and keep the picker open */
  export let onChoose: (l: Locale) => Promise<void>;
  /** profile mode: "Später" (stores the instance default so the question does not come back) */
  export let onSkip: (() => Promise<void>) | null = null;

  let sel: Locale = preselect, busy = false, err = '', box: HTMLElement, loaded = 0;
  // load the highlighted language so the picker can speak it (re-renders once it is there)
  const preload = (l: Locale) => { loadLocale(l).then(() => { loaded += 1; }, () => undefined); };
  $: preload(sel);
  const makeT = (l: Locale, _loaded: number) => (k: Parameters<typeof trIn>[1]) => trIn(l, k);
  $: tt = makeT(sel, loaded);

  async function run(f: () => Promise<void>) {
    busy = true; err = '';
    try { await f(); } catch { err = tt('account.language.saveFailed'); busy = false; }
  }
  onMount(() => box?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true }));
  function onKey(e: KeyboardEvent) {
    const i = LOCALES.findIndex((l) => l.code === sel);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    sel = LOCALES[(i + step + LOCALES.length) % LOCALES.length]!.code;
    queueMicrotask(() => box?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  }
</script>

<div class="lg" role="dialog" aria-modal="true" aria-labelledby="lg-h" lang={sel}>
  <span class="brand" aria-hidden="true"><Logo wordmark size={30} /></span>
  <div class="inner">
    {#if mode === 'instance'}
      <h1 id="lg-h">{tt('account.language.instanceTitle')}<span class="en" lang="en"> / {tt('account.language.instanceTitleEn')}</span></h1>
      <p class="muted">{tt('account.language.instanceIntro')}</p>
    {:else}
      <h1 id="lg-h">{tt('account.language.title')}</h1>
      <p class="muted">{tt('account.language.intro')}</p>
    {/if}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="grid" role="radiogroup" aria-labelledby="lg-h" bind:this={box} on:keydown={onKey} data-nav>
      {#each LOCALES as l (l.code)}
        <button type="button" role="radio" aria-checked={sel === l.code} tabindex={sel === l.code ? 0 : -1} class="opt" class:on={sel === l.code} lang={l.code} disabled={busy} on:click={() => (sel = l.code)}>
          <span class="nm">{l.name}</span><span class="code" aria-hidden="true">{l.code.toUpperCase()}</span>
        </button>
      {/each}
    </div>
    {#if err}<p class="err" role="alert">{err}</p>{/if}
    <div class="acts">
      <button type="button" class="go" disabled={busy} on:click={() => run(() => onChoose(sel))}>{mode === 'instance' ? tt('account.language.instanceSave') : tt('account.language.choose')}</button>
      {#if mode === 'profile' && onSkip}<button type="button" class="sec" disabled={busy} on:click={() => run(onSkip ?? (async () => undefined))}>{tt('account.language.skip')}</button>{/if}
    </div>
  </div>
</div>

<style>
  .lg { position: fixed; inset: 0; z-index: 120; background: var(--bg, #101418); overflow-y: auto; display: grid; place-items: center; padding: calc(4.5rem + var(--safe-top)) var(--pad-x) calc(2rem + var(--safe-bottom)); }
  .brand { position: absolute; top: calc(1.2rem + var(--safe-top)); left: max(var(--pad-x), var(--safe-left)); display: inline-flex; }
  .inner { width: min(760px, 100%); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 1rem; }
  h1 { font-size: clamp(1.7rem, 4vw, 2.8rem); font-weight: 500; margin: 0; }
  .en { color: var(--mut); }
  p { margin: 0; max-width: 560px; line-height: 1.5; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .7rem; width: 100%; margin-top: .8rem; }
  .opt { position: relative; flex-direction: column; gap: .2rem; min-height: 84px; background: var(--surface-2, #242b33); border: 2px solid transparent; border-radius: 8px; color: #e5e5e5; font-size: 1.15rem; font-weight: 600; }
  .opt:hover:not(:disabled) { background: #2e363f; }
  .opt.on, .opt.on:hover:not(:disabled) { border-color: #fff; background: #323a43; color: #fff; }
  .opt:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
  .code { font-size: .72rem; letter-spacing: .12em; color: var(--mut); font-weight: 500; }
  .acts { display: flex; gap: .8rem; flex-wrap: wrap; justify-content: center; margin-top: .8rem; }
  .go { min-width: 220px; min-height: 48px; font-size: 1.05rem; }
  .acts .sec { min-height: 48px; }
</style>
