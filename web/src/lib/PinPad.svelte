<script lang="ts">
  import { t } from '#lib/i18n';
  import { createEventDispatcher, onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { isBackKey } from '#lib/spatial';
  /** heading; default: "PIN eingeben" in the current language */
  export let title = '';
  /** optional line below the heading (e.g. why the owner profile's PIN is asked for when leaving a kids profile) */
  export let hint = '';
  export let error = '';
  export let busy = false;
  const dispatch = createEventDispatcher<{ submit: string; cancel: void }>();
  let pin = '';
  let box: HTMLElement;

  /** clears the entry after a failed attempt (parent sets error) */
  $: if (error) pin = '';
  // also clear when a request finishes (the same error text can repeat)
  let wasBusy = false;
  $: { if (wasBusy && !busy) pin = ''; wasBusy = busy; }
  function add(d: string) {
    if (busy || pin.length >= 4) return;
    pin += d;
    if (pin.length === 4) dispatch('submit', pin);
  }
  function del() { if (!busy) pin = pin.slice(0, -1); }

  // capture phase: digits / Backspace / Escape belong to the pad (the layout would treat Back as "leave the page")
  function onKey(e: KeyboardEvent) {
    if (/^\d$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); add(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); del(); }
    else if (e.key === 'Escape' || isBackKey(e)) { e.preventDefault(); e.stopPropagation(); dispatch('cancel'); }
  }
  onMount(() => {
    window.addEventListener('keydown', onKey, true);
    box?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

<div class="pad" bind:this={box} role="group" aria-label={title || $t('account.pin.enter')}>
  <h2>{title || $t('account.pin.enter')}</h2>
  {#if hint}<p class="hint">{hint}</p>{/if}
  <div class="boxes" aria-live="polite" aria-label={$t('account.pin.progress', { n: pin.length })}>
    {#each [0, 1, 2, 3] as i}<span class="b" class:on={i < pin.length} class:cur={i === pin.length}>{i < pin.length ? '●' : ''}</span>{/each}
  </div>
  <p class="err msg" role="alert">{error}</p>
  <div class="keys" data-nav>
    {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as d, i}
      <button class="sec k" disabled={busy} data-autofocus={i === 0 ? '' : undefined} on:click={() => add(d)}>{d}</button>
    {/each}
    <button class="sec k" aria-label={$t('account.pin.cancel')} on:click={() => dispatch('cancel')}><Icon name="x" size={22} /></button>
    <button class="sec k" disabled={busy} on:click={() => add('0')}>0</button>
    <button class="sec k" aria-label={$t('account.pin.delete')} disabled={busy} on:click={del}>⌫</button>
  </div>
</div>

<style>
  .pad { display: flex; flex-direction: column; align-items: center; gap: .6rem; }
  h2 { margin: 0; font-size: 1.3rem; }
  .hint { margin: 0; max-width: 18rem; text-align: center; color: var(--mut); font-size: .9rem; }
  .boxes { display: flex; gap: .7rem; margin: .5rem 0 0; }
  .b { width: 3.2rem; height: 3.8rem; display: grid; place-items: center; background: #2b333c; border: 2px solid transparent; border-radius: 6px; font-size: 1.5rem; }
  .b.cur { border-color: #fff; } .b.on { border-color: #6a7480; }
  .msg { min-height: 1.5em; margin: 0; font-size: .9rem; }
  .keys { display: grid; grid-template-columns: repeat(3, 4.2rem); gap: .6rem; }
  .k { min-height: 3.6rem; font-size: 1.3rem; padding: 0; }
</style>
