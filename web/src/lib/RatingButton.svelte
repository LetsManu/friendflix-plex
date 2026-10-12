<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { api } from '#lib/api';
  import { focusIndex, nextThumb, RATING_OPTIONS, toThumb, type Thumb } from '#lib/rating';
  import { t } from '#lib/i18n';

  /**
   * Netflix-style rating: one round thumb button that expands (hover / click / keyboard focus / tap) into
   * "Nicht mein Fall" (-1), "Gefällt mir" (1) and "Super" (2). Clicking the active option resets to 0.
   * Saves via PUT /api/items/:id/thumb {value} (optimistic, reverted on error) and emits `change`.
   */
  export let itemId: string;
  /** current rating; bindable (`bind:value`) */
  export let value: Thumb = 0;
  /** diameter of the round button in px (34 = pop-out card, 42 = detail view) */
  export let size = 34;
  /** label under the icon (phone detail view icon row: "Bewerten") */
  export let showLabel = false;
  /** false: only emit `change`, the parent saves */
  export let persist = true;
  /** open the option pill above the button instead of over it (e.g. labelled icon rows) */
  export let up = false;

  const dispatch = createEventDispatcher<{ change: { value: Thumb; previous: Thumb }; error: { value: Thumb } }>();
  const fine = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;

  let open = false, busy = false, msg = '', skipFocusOpen = false;
  let root: HTMLElement, trigger: HTMLButtonElement, opts: HTMLButtonElement[] = [];
  let enterT: ReturnType<typeof setTimeout>, leaveT: ReturnType<typeof setTimeout>, msgT: ReturnType<typeof setTimeout>;
  $: v = toThumb(value);
  $: current = RATING_OPTIONS.find((o) => o.value === v);
  $: iconSize = Math.round(size * 0.5);

  async function show(focus = false) {
    clearTimeout(leaveT);
    open = true;
    if (focus) { await tick(); opts[focusIndex(v)]?.focus(); }
  }
  function hide(refocus = false) {
    clearTimeout(enterT); clearTimeout(leaveT);
    if (!open) return;
    open = false;
    if (refocus) { skipFocusOpen = true; trigger?.focus(); skipFocusOpen = false; }
  }

  async function pick(o: Exclude<Thumb, 0>, e: MouseEvent | KeyboardEvent) {
    if (busy) return;
    const previous = v, next = nextThumb(previous, o);
    value = next;
    const kb = e instanceof KeyboardEvent || (e as MouseEvent).detail === 0;
    hide(kb);
    if (!persist) { dispatch('change', { value: next, previous }); return; }
    busy = true;
    try {
      await api(`/api/items/${itemId}/thumb`, { method: 'PUT', body: { value: next } });
      dispatch('change', { value: next, previous });
    } catch {
      value = previous;
      msg = $t('common.rating.saveFailed');
      clearTimeout(msgT); msgT = setTimeout(() => (msg = ''), 4500);
      dispatch('error', { value: next });
    }
    busy = false;
  }

  function onTriggerClick(e: MouseEvent) {
    e.stopPropagation();
    if (open && !fine) { hide(); return; }
    void show(e.detail === 0); // keyboard "click" (Enter/Space) moves focus into the options
  }
  function onTriggerFocus(e: FocusEvent) {
    if (skipFocusOpen) return;
    if ((e.target as HTMLElement).matches(':focus-visible')) void show(true);
  }
  function onEnter() { if (!fine) return; clearTimeout(leaveT); clearTimeout(enterT); enterT = setTimeout(() => void show(false), 180); }
  function onLeave() {
    if (!fine) return;
    clearTimeout(enterT);
    leaveT = setTimeout(() => { if (!root?.contains(document.activeElement)) hide(); }, 220);
  }
  // null relatedTarget (focus went to <body>, e.g. while the pill re-renders) is ignored; outside clicks are handled by onDoc
  function onFocusOut(e: FocusEvent) { if (open && e.relatedTarget && !root?.contains(e.relatedTarget as Node)) hide(); }
  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); hide(true); return; }
    const i = opts.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = RATING_OPTIONS.length;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j >= 0) { e.preventDefault(); e.stopPropagation(); opts[j]?.focus(); }
  }
  function onDoc(e: Event) { if (open && !root?.contains(e.target as Node)) hide(); }
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', onDoc, true);
  onDestroy(() => {
    clearTimeout(enterT); clearTimeout(leaveT); clearTimeout(msgT);
    if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="rb" class:lab={showLabel} bind:this={root} style="--rb:{size}px" on:mouseenter={onEnter} on:mouseleave={onLeave} on:focusout={onFocusOut} on:keydown={onKey}>
  <button
    bind:this={trigger} type="button" class="trig" class:on={v !== 0} class:hid={open}
    tabindex={open ? -1 : 0} aria-label={current ? $t('common.rating.rated', { label: $t(current.key) }) : $t('common.rating.rate')} aria-haspopup="true" aria-expanded={open}
    title={current ? $t(current.key) : $t('common.rating.rate')} on:click={onTriggerClick} on:focus={onTriggerFocus}
  >
    <span class="ic">
      {#if v === -1}{@render down(iconSize, true)}{:else if v === 2}{@render double(iconSize, true)}{:else}{@render upIc(iconSize, v === 1)}{/if}
    </span>
    {#if showLabel}<span class="tx">{current ? $t(current.key) : $t('common.rating.rate')}</span>{/if}
  </button>
  {#if open}
    <span class="pill" class:up role="group" aria-label={$t('common.rating.rate')}>
      {#each RATING_OPTIONS as o, i (o.value)}
        <button
          bind:this={opts[i]} type="button" class="opt" class:on={v === o.value} aria-pressed={v === o.value}
          aria-label={v === o.value ? $t('common.rating.remove', { label: $t(o.key) }) : $t(o.key)} disabled={busy}
          on:click|stopPropagation={(e) => pick(o.value, e)}
        >
          {#if o.icon === 'down'}{@render down(iconSize, v === o.value)}{:else if o.icon === 'up'}{@render upIc(iconSize, v === o.value)}{:else}{@render double(iconSize, v === o.value)}{/if}
          <span class="tip" aria-hidden="true">{$t(o.key)}</span>
        </button>
      {/each}
    </span>
  {/if}
  <span class="msg" role="status">{#if msg}<span>{msg}</span>{/if}</span>
</span>

{#snippet upIc(s: number, f: boolean)}
  <svg width={s} height={s} viewBox="0 0 24 24" fill={f ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /></svg>
{/snippet}
{#snippet down(s: number, f: boolean)}
  <svg width={s} height={s} viewBox="0 0 24 24" fill={f ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" /></svg>
{/snippet}
{#snippet double(s: number, f: boolean)}
  <svg width={s} height={s} viewBox="0 0 28 24" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false"><path fill="none" d="M12.500 8l3-6a1.700 1.700 0 011.700 1.700V7h4.600a1.700 1.700 0 011.700 1.900l-1 5.600A1.700 1.700 0 0120.800 16H19" /><path fill={f ? 'currentColor' : 'none'} d="M6 13v8H2.500v-8zM6 13l3.500-7a1.700 1.700 0 011.700 1.700V11h5a1.700 1.700 0 011.700 2l-1.100 6.200A1.700 1.700 0 0115.100 21H6" /></svg>
{/snippet}

<style>
  .rb { position: relative; display: inline-flex; flex-direction: column; align-items: center; vertical-align: middle; }
  .trig, .opt { width: var(--rb); height: var(--rb); min-height: var(--rb); padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; position: relative; }
  .trig::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; } /* >=44px hit area at 34px */
  .trig:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  .trig:focus-visible, .opt:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .trig.hid { opacity: 0; pointer-events: none; } /* stays focusable while the pill covers it (visibility would drop focus) */
  .lab .trig { width: auto; height: auto; min-height: 44px; border: 0; background: none; border-radius: 6px; display: flex; flex-direction: column; gap: .3rem; padding: .2rem .4rem; }
  .lab .trig .ic { display: grid; place-items: center; width: var(--rb); height: var(--rb); }
  .lab .trig::after { display: none; }
  .tx { font-size: .75rem; font-weight: 500; color: var(--mut); white-space: nowrap; }
  .lab .trig.hid { opacity: 1; }
  /* option pill: centred over the trigger (Netflix), grows out of it */
  .pill { position: absolute; z-index: 30; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: .25rem; padding: .3rem; border-radius: 999px; background: #232323; box-shadow: 0 6px 22px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.1); animation: rb-in 140ms var(--ease, ease-out) both; }
  .pill.up { top: auto; bottom: calc(100% + 6px); transform: translateX(-50%); animation-name: rb-up; }
  .opt { border-color: transparent; background: transparent; }
  .opt:hover:not(:disabled) { background: rgba(255,255,255,.14); }
  .opt.on { color: #fff; background: rgba(255,255,255,.18); }
  .opt svg { transition: transform 120ms var(--ease, ease-out); }
  .opt:hover svg, .opt:focus-visible svg { transform: scale(1.15); }
  .tip { position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); white-space: nowrap; padding: .3rem .6rem; border-radius: 4px; background: #e6e6e6; color: #141414; font-size: .78rem; font-weight: 700; pointer-events: none; opacity: 0; transition: opacity 100ms; }
  .opt:hover .tip, .opt:focus-visible .tip { opacity: 1; }
  .msg { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 31; pointer-events: none; }
  .msg span { display: block; white-space: nowrap; padding: .2rem .55rem; border-radius: 6px; background: rgba(20,20,20,.94); border: 1px solid var(--err, #e5646e); color: #fff; font-size: .75rem; font-weight: 600; }
  @keyframes rb-in { from { opacity: 0; transform: translate(-50%, -50%) scale(.6); } }
  @keyframes rb-up { from { opacity: 0; transform: translateX(-50%) translateY(6px); } }
  @media (pointer: coarse) {
    .opt { width: 44px; height: 44px; min-height: 44px; }
    .tip { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .pill { animation: none; } .opt svg { transition: none; } }
</style>
