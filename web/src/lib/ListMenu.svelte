<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { addToList, createList, itemLists, removeFromList, type PickerList } from '#lib/lists';
  import { placePopover, placedStyle } from '#lib/popover';
  import { t, tr } from '#lib/i18n';

  /** Jellyfin id of the movie / series to add (episodes are normalised server-side). */
  export let itemId: string;
  /** compact round button (Card / modal) or the larger detail-page icon button */
  export let variant: 'round' | 'ring' | 'row' = 'ring';
  /** prefer opening the picker above the button (bottom sheet, modal); it still flips when there is no room */
  export let up = false;
  /** diameter of the round variant in px */
  export let size = 34;
  /** emitted after a list was changed on the server (checkbox toggled, new list created with the item) */
  const dispatch = createEventDispatcher<{ changed: { listId: string; contains: boolean } }>();

  let open = false, lists: PickerList[] | null = null, err = '', creating = false, newName = '', busy = false, busyIds = new Set<string>();
  let root: HTMLElement, btn: HTMLButtonElement, pop: HTMLDivElement | undefined, style = '';

  async function load() {
    err = '';
    try { lists = await itemLists(itemId); } catch { lists = []; err = tr('detail.lists.loadFailed'); }
  }
  function place() {
    if (!btn) return;
    style = placedStyle(placePopover(btn.getBoundingClientRect(), { w: window.innerWidth, h: window.innerHeight }, { up, wide: variant === 'row' }));
  }
  async function toggleOpen() {
    open = !open;
    if (open) {
      lists = null; creating = false; newName = ''; place(); void load();
      await tick(); pop?.focus({ preventScroll: true });
    }
  }
  async function toggle(l: PickerList) {
    if (busyIds.has(l.id)) return;
    const was = l.contains;
    l.contains = !was; lists = lists;
    busyIds.add(l.id); busyIds = busyIds; err = '';
    try {
      await (was ? removeFromList(l.id, itemId) : addToList(l.id, itemId));
      dispatch('changed', { listId: l.id, contains: !was });
    } catch (e: any) {
      if (!was && e?.status === 409 && e.body?.error === 'exists') { dispatch('changed', { listId: l.id, contains: true }); } // already in there
      else {
        l.contains = was; lists = lists;
        err = e?.body?.error === 'list_full' ? tr('detail.lists.full') : tr('detail.lists.failed');
      }
    }
    busyIds.delete(l.id); busyIds = busyIds;
  }
  async function create() {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true; err = '';
    try {
      const { id } = await createList(name);
      await addToList(id, itemId);
      newName = ''; creating = false;
      dispatch('changed', { listId: id, contains: true });
      await load();
    } catch (e: any) { err = e?.body?.error === 'too_many_lists' ? tr('detail.lists.tooMany') : tr('detail.lists.failed'); }
    busy = false;
  }
  export function close(refocus = false) { if (!open) return; open = false; if (refocus) btn?.focus(); }
  const inside = (n: EventTarget | null) => !!n && (root?.contains(n as Node) || !!pop?.contains(n as Node));
  function onKey(e: KeyboardEvent) { if (open && e.key === 'Escape') { e.stopPropagation(); close(true); } }
  function onDoc(e: Event) { if (open && !inside(e.target)) close(); }
  /** the picker closes when keyboard focus moves somewhere else (null = unknown, e.g. Safari clicks: the outside-pointer handler covers that) */
  function onFocusOut(e: FocusEvent) { if (open && e.relatedTarget && !inside(e.relatedTarget)) close(); }
  /** the popover lives on <body> (cards scale and the modal clips), so it needs its own Tab trap */
  function popKey(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !pop) return;
    const f = [...pop.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])')];
    const a = document.activeElement;
    if (!f.length) { e.preventDefault(); return; }
    if (a === pop) { e.preventDefault(); (e.shiftKey ? f[f.length - 1]! : f[0]!).focus(); }
    else if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1]!.focus(); }
    else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0]!.focus(); }
  }
  /** hover cards: the picker follows the card, i.e. closes once the pointer leaves card and popover */
  function popLeave(e: MouseEvent) {
    const card = root?.closest('.card');
    if (card && !card.contains(e.relatedTarget as Node | null)) close();
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  if (typeof document !== 'undefined') { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey, true); }
  onDestroy(() => { if (typeof document !== 'undefined') { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); } });
</script>

<svelte:window on:resize={() => open && place()} on:scroll|capture={() => open && place()} />
<span class="lm" class:blk={variant === 'row'} bind:this={root} on:focusout={onFocusOut}>
  <button bind:this={btn} class={variant === 'ring' ? 'icon-btn ring' : variant === 'row' ? 'rowbtn' : 'round'} class:on={open} aria-haspopup="dialog" aria-expanded={open} style={variant === 'round' ? `width:${size}px;height:${size}px;min-height:${size}px` : undefined} aria-label={$t('detail.lists.add')} title={$t('detail.lists.add')} on:click|stopPropagation={toggleOpen}>
    <Icon name="list" size={variant === 'ring' ? 21 : 18} />{#if variant === 'row'}<span>{$t('detail.lists.addMore')}</span>{/if}
  </button>
</span>
{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="pop lm-pop" class:up bind:this={pop} use:portal {style} tabindex="-1" role="dialog" aria-label={$t('detail.lists.add')} on:keydown={popKey} on:focusout={onFocusOut} on:mouseleave={popLeave}>
    {#if lists === null}<p class="muted">{$t('detail.lists.loading')}</p>
    {:else}
      {#if !lists.length}<p class="muted">{$t('detail.lists.none')}</p>{/if}
      <ul>
        {#each lists as l (l.id)}
          <li><label><input type="checkbox" checked={l.contains} disabled={busyIds.has(l.id)} on:change={() => toggle(l)} /><span>{l.name}</span></label></li>
        {/each}
      </ul>
      {#if creating}
        <form on:submit|preventDefault={create}>
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" maxlength="60" placeholder={$t('detail.lists.newName')} aria-label={$t('detail.lists.newName')} bind:value={newName} autofocus />
          <button class="sec" type="submit" disabled={busy || !newName.trim()}>{$t('detail.lists.create')}</button>
        </form>
      {:else}<button class="new" type="button" on:click={() => (creating = true)}><Icon name="plus" size={16} />{$t('detail.lists.newList')}</button>{/if}
      {#if err}<p class="err" role="alert">{err}</p>{/if}
    {/if}
  </div>
{/if}

<style>
  .lm { position: relative; display: inline-block; }
  .blk { display: block; }
  .rowbtn { display: flex; gap: .8rem; align-items: center; width: 100%; min-height: 48px; padding: 0 1rem; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; }
  .rowbtn:hover:not(:disabled), .rowbtn.on { background: rgba(255,255,255,.08); }
  .round { width: 34px; min-height: 34px; height: 34px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; }
  .round:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  /* position: fixed on <body> (see place()): not clipped by overflow:hidden / transformed ancestors, always inside the viewport */
  .pop { position: fixed; z-index: 90; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; outline: none; background: var(--surface); color: var(--fg, #fff); border: 1px solid rgba(255,255,255,.18); border-radius: var(--radius); padding: .6rem .7rem; box-shadow: 0 14px 28px rgba(0,0,0,.6); text-align: left; font-size: .9rem; font-weight: 400; }
  ul { list-style: none; margin: 0 0 .4rem; padding: 0; max-height: 220px; overflow: auto; }
  label { display: flex; gap: .55rem; align-items: center; padding: .3rem 0; cursor: pointer; }
  label:has(:disabled) { opacity: .6; cursor: progress; }
  .new { display: flex; gap: .4rem; align-items: center; background: none; border: 0; color: inherit; padding: .3rem 0; min-height: 0; cursor: pointer; }
  form { display: flex; gap: .4rem; }
  form input { flex: 1; min-width: 0; }
  .muted { color: var(--mut); margin: 0 0 .4rem; }
  .err { color: var(--err, #e5646e); margin: .4rem 0 0; }
  @media (pointer: coarse) {
    label { min-height: 44px; padding: 0; }
    label input { width: 22px; height: 22px; flex: none; }
    .new { min-height: 44px; }
    form input, form button { min-height: 44px; }
  }
</style>
