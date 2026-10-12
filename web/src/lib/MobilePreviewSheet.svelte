<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { img } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import { dialogKeys } from '#lib/actions';
  import { isSpoiler } from '#lib/spoiler';
  import { listIds, prefs, toggleList } from '#lib/stores';
  import { closePreview, previewSheet } from '#lib/previewSheet';
  import { genreLine, itemPath, playPath, runtimeLabel, shareData } from '#lib/mobile';
  import { kidsMode } from '#lib/kids';
  import { t, tr } from '#lib/i18n';

  /** Bottom sheet that opens when a poster is tapped (phone layout). Mounted once in +layout.svelte; state in `previewSheet`. */
  $: item = $previewSheet?.item;
  $: opener = $previewSheet?.opener ?? null;
  $: posterId = item ? (item.type === 'Episode' && item.seriesId ? item.seriesId : item.id) : '';
  $: hasPoster = item ? (item.type === 'Episode' ? Boolean(item.seriesId) : item.image) : false;
  $: inList = item ? $listIds.has(item.seriesId ?? item.id) : false;
  $: meta = item ? [item.year ? String(item.year) : '', runtimeLabel(item)].filter(Boolean) : [];
  $: hidden = item ? isSpoiler(item, $prefs) : false;
  $: downloadable = item ? item.type === 'Movie' || item.type === 'Episode' : false;
  let sheetEl: HTMLElement, dragY = 0, dragging = false, dragStart = 0, note = '', noteT: ReturnType<typeof setTimeout>;

  function close(refocus = true) {
    closePreview(); dragY = 0; dragging = false;
    if (refocus && opener && document.contains(opener)) opener.focus();
  }
  onMount(() => { document.documentElement.style.overflow = 'hidden'; void tick().then(() => sheetEl?.querySelector<HTMLElement>('.close')?.focus()); });
  onDestroy(() => { clearTimeout(noteT); if (typeof document !== 'undefined') document.documentElement.style.overflow = ''; });

  function say(msg: string) { note = msg; clearTimeout(noteT); noteT = setTimeout(() => (note = ''), 3500); }
  async function share() {
    if (!item) return;
    const d = shareData(item, location.origin);
    try {
      if (navigator.share) { await navigator.share(d); return; }
    } catch (e) { if ((e as DOMException)?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(d.url); say(tr('home.card.linkCopied')); }
    catch { say(d.url); }
  }
  async function list() {
    if (!item) return;
    if (!(await toggleList(item.seriesId ?? item.id, inList))) say(tr('home.card.saveFailed'));
  }
  // swipe down on the grab zone closes the sheet (threshold 80 px)
  function dragDown(e: PointerEvent) { dragging = true; dragStart = e.clientY; dragY = 0; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
  function dragMove(e: PointerEvent) { if (dragging) dragY = Math.max(0, e.clientY - dragStart); }
  function dragEnd() { if (!dragging) return; const far = dragY > 80; dragging = false; dragY = 0; if (far) close(); }
</script>

{#if item}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" on:click={() => close()}></div>
  <div class="sheet" class:dragging role="dialog" aria-modal="true" aria-label={$t('home.card.preview', { name: item.name })} tabindex="-1" bind:this={sheetEl} use:dialogKeys={{ close: () => close() }} style={dragY ? `transform:translateY(${dragY}px)` : undefined}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="grab" on:pointerdown={dragDown} on:pointermove={dragMove} on:pointerup={dragEnd} on:pointercancel={dragEnd}><span class="handle" aria-hidden="true"></span></div>
    <button type="button" class="close" aria-label={$t('common.close')} on:click={() => close()}><Icon name="x" size={18} /></button>
    <div class="top">
      {#if hasPoster}<img class="poster" src={img(posterId, 240)} alt="" width="84" height="126" />{:else}<span class="poster none" aria-hidden="true"></span>{/if}
      <div class="info">
        <h2>{item.type === 'Episode' && item.seriesName ? item.seriesName : item.name}</h2>
        <p class="meta">
          {#each meta as m, i}{#if i}<span class="dot" aria-hidden="true">•</span>{/if}<span>{m}</span>{/each}
          {#if item.rating}<span class="age" aria-label={$t('home.card.ageRating', { rating: item.rating })}>{item.rating}</span>{/if}
        </p>
        {#if genreLine(item.genres)}<p class="genres">{genreLine(item.genres)}</p>{/if}
        {#if item.type === 'Episode'}<p class="genres">S{item.parentIndexNumber ?? '?'}:E{item.indexNumber ?? '?'} · {item.name}</p>{/if}
      </div>
    </div>
    {#if item.overview}<p class="ov">{hidden ? $t('home.card.spoilerHidden') : item.overview}</p>{/if}
    <div class="btns">
      <a class="play" href={playPath(item)} on:click={() => close(false)}><Icon name="play" size={22} />{item.positionTicks ? $t('home.card.resume') : $t('home.card.play')}</a>
      {#if downloadable}<span class="ic dl"><DownloadButton itemId={item.id} seriesId={item.seriesId ?? ''} compact /><small>{$t('home.card.download')}</small></span>{/if}
      <button type="button" class="ic" aria-pressed={inList} on:click={list}><span class="circ"><Icon name={inList ? 'check' : 'plus'} size={22} /></span><small>{$t('home.card.myList')}</small></button>
      {#if !$kidsMode}<button type="button" class="ic" on:click={share}><span class="circ"><Icon name="share" size={20} /></span><small>{$t('home.card.share')}</small></button>{/if}
    </div>
    <p class="note" role="status">{note}</p>
    <a class="details" href={itemPath(item)} on:click={() => close(false)}><Icon name="info" size={20} />{$t('home.card.detailsMore')}<Icon name="chevron-right" size={18} /></a>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.62); animation: fade .2s ease-out; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 91; max-width: 560px; margin: 0 auto; max-height: 88dvh; overflow-y: auto; overscroll-behavior: contain; outline: none; background: #1c1c1c; border-radius: 16px 16px 0 0; padding: 0 var(--pad-x) calc(.8rem + env(safe-area-inset-bottom)); box-shadow: 0 -12px 40px rgba(0,0,0,.7); animation: rise .26s var(--ease, ease-out); }
  .sheet.dragging { transition: none; }
  .grab { touch-action: none; cursor: grab; padding: 0 0 .2rem; margin: 0 calc(var(--pad-x) * -1); }
  .handle { display: block; width: 40px; height: 4px; border-radius: 99px; background: #666; margin: 10px auto 8px; }
  /* sits inside the sheet's padding box (aligned with the content edge), 44px hit area around a 34px circle */
  .close { position: absolute; top: 14px; right: calc(var(--pad-x) - 5px); width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; z-index: 2; }
  .close::before { content: ''; position: absolute; inset: 5px; border-radius: 50%; background: #3a3a3a; z-index: -1; }
  .close:hover:not(:disabled) { background: transparent; }
  .close:hover:not(:disabled)::before { background: #4a4a4a; }
  .top { display: flex; gap: .9rem; padding-top: .5rem; padding-right: 2.6rem; }
  .poster { flex: none; width: 84px; height: 126px; border-radius: 4px; object-fit: cover; background: #2a2a2a; }
  .info { min-width: 0; }
  h2 { font-size: 1.2rem; font-weight: 800; margin: 0 0 .3rem; line-height: 1.2; overflow-wrap: anywhere; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .5rem; margin: 0 0 .3rem; color: #d2d2d2; font-size: .9rem; }
  .dot { color: var(--mut); }
  .age { border: 1px solid #8a8a8a; padding: 0 .35rem; border-radius: 3px; font-size: .78rem; line-height: 1.5; }
  .genres { margin: 0; color: var(--mut); font-size: .85rem; }
  .ov { margin: .9rem 0 0; line-height: 1.45; font-size: .93rem; color: #e0e0e0; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .btns { display: flex; align-items: flex-start; gap: .4rem; margin-top: 1rem; }
  .play { flex: 1 1 auto; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: .5rem; min-height: 48px; background: #fff; color: #000; font-weight: 700; font-size: 1.02rem; border-radius: 4px; padding: 0 .8rem; white-space: nowrap; }
  .play:hover { background: rgba(255,255,255,.8); }
  .ic { flex: none; width: 62px; display: flex; flex-direction: column; align-items: center; gap: .15rem; background: transparent; padding: 0; min-height: 48px; color: #fff; font-weight: 500; }
  .ic:hover:not(:disabled) { background: transparent; }
  .circ { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; border: 2px solid rgba(255,255,255,.55); }
  .ic small { font-size: .68rem; color: #d0d0d0; line-height: 1.1; text-align: center; white-space: nowrap; }
  .dl :global(.dlb) { width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; border: 2px solid rgba(255,255,255,.55); color: #fff; }
  .dl :global(.dl) { display: block; }
  .ic.dl:not(:has(:global(.dlb))) { display: none; } /* downloads not allowed / unsupported: DownloadButton renders nothing */
  .note { min-height: 1.2em; margin: .5rem 0 0; font-size: .85rem; color: var(--mut); text-align: center; }
  .details { display: flex; align-items: center; justify-content: space-between; gap: .7rem; min-height: 48px; margin-top: .2rem; padding: 0 .2rem; border-top: 1px solid #333; font-weight: 600; }
  .details :global(svg:last-child) { margin-left: auto; color: var(--mut); }
  @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sheet, .backdrop { animation: none; } }
</style>
