<script lang="ts">
  import { api, backdrop, img, primeItem, srcset, CARD_SIZES, CARD_WIDTHS, type Item } from '#lib/api';
  import { prefetchModal } from '#lib/lazy';
  import { listIds, toggleList } from '#lib/stores';
  import { t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import { kidsMode } from '#lib/kids';
  import { openModal } from '#lib/modal';
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import { cardTag } from '#lib/badges';
  import { badges, wantBadge } from '#lib/fresh';
  import HoverPreview from '#lib/HoverPreview.svelte';
  import { hoverOwner, nextHoverUid } from '#lib/hover';

  export let item: Item;
  /** shows a remove (X) button and emits `remove` (used for Weiterschauen) */
  export let removable = false;
  /** portrait 2:3 poster instead of the 16:9 thumbnail (Top-10 rows) */
  export let poster = false;
  /** eager + high priority image (first visible row of the home page) */
  export let priority = false;
  const dispatch = createEventDispatcher<{
    remove: Item;
    /** "Merkliste" was toggled for this card (after the server accepted it) */
    listtoggle: { item: Item; inList: boolean };
    /** favourite was toggled (after the server accepted it) */
    favchange: { item: Item; favorite: boolean };
    /** a list from the ListMenu picker was changed */
    listchanged: { listId: string; contains: boolean };
  }>();
  let fav = item.favorite;
  $: fav = item.favorite; // follow the item when the list re-renders with fresh data
  $: href = item.type === 'Episode' ? `/watch/${item.id}` : item.type === 'BoxSet' ? `/library/${item.id}` : `/item/${item.id}`;
  $: detail = item.type === 'Episode' && item.seriesId ? `/item/${item.seriesId}` : `/item/${item.id}`;
  $: posterId = item.type === 'Episode' && item.seriesId ? item.seriesId : item.id;
  $: posterSrc = poster && (item.image || item.type === 'Episode') ? img(posterId, 320) : '';
  $: src = posterSrc || (item.backdrop ? backdrop(item.id, 520) : item.image ? img(item.id, 520) : '');
  // one URL for blur + main image (identical strings: a single request); the srcset widths are the same for both
  $: srcs = posterSrc ? srcset('Primary', posterId, [200, 320, 480]) : item.backdrop ? srcset('Backdrop', item.id, CARD_WIDTHS) : item.image ? srcset('Primary', item.id, CARD_WIDTHS) : '';
  $: sizes = posterSrc ? '(min-width: 1400px) 9vw, (min-width: 1100px) 11vw, 14vw' : CARD_SIZES;
  $: epSub = item.type === 'Episode' && item.seriesName ? `S${item.parentIndexNumber ?? '?'}·E${item.indexNumber ?? '?'} ${item.name}` : '';
  $: posterOnly = !posterSrc && !item.backdrop && item.image; // poster (2:3) in a 16:9 slot: show it contained on a blurred copy
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} · S${item.parentIndexNumber ?? '?'}:E${item.indexNumber ?? '?'}` : '';
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: inList = $listIds.has(item.seriesId ?? item.id);
  // one tag per card from the server (fresh label or "Nur noch N Tage"); episodes ask for their series' removal date
  $: badgeId = item.type === 'Episode' ? item.seriesId : item.id;
  $: wantBadge(badgeId);
  $: tag = cardTag(badgeId ? $badges[badgeId] : undefined, item, Date.now());
  let imgEl: HTMLImageElement | undefined;

  // ---- desktop pop-out preview (HoverPreview, portal): opens after ~450 ms hover / 600 ms keyboard focus ----
  const canHover = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const uid = nextHoverUid();
  let hp = false, hpComp: HoverPreview | undefined, thumbEl: HTMLAnchorElement;
  let overCard = false, focusCard = false, overPrev = false, focusPrev = false;
  let openT: ReturnType<typeof setTimeout>, closeT: ReturnType<typeof setTimeout>;
  const tvMode = () => document.documentElement.classList.contains('tv');
  function scheduleOpen(delay: number) {
    clearTimeout(openT);
    if (hp || !canHover || tvMode()) return;
    openT = setTimeout(() => { hp = true; hoverOwner.set(uid); }, delay);
  }
  function closePreview(refocus = false) {
    clearTimeout(openT); clearTimeout(closeT);
    const had = hp;
    hp = false; overPrev = false; focusPrev = false;
    if (had && refocus) thumbEl?.focus();
    hoverOwner.update((o) => (o === uid ? '' : o));
  }
  $: held = overCard || focusCard || overPrev || focusPrev;
  $: syncHold(hp, held);
  function syncHold(open: boolean, h: boolean) {
    clearTimeout(closeT);
    if (!open || h) return;
    // grace period so the pointer can travel from the card onto the pop-out; stay open while a list picker is open
    const check = () => { if (held) return; if (document.querySelector('.lm-pop, .ma-pop')) { closeT = setTimeout(check, 400); return; } closePreview(); };
    closeT = setTimeout(check, 120);
  }
  $: if ($hoverOwner !== uid && hp) { hp = false; overPrev = false; focusPrev = false; }
  function cardEnter() { overCard = true; scheduleOpen(450); }
  function cardLeave() { overCard = false; clearTimeout(openT); }
  // keyboard focus only: a mouse click on a button must not open (or pin) the preview
  function onFocusIn(e: FocusEvent) { if ((e.target as HTMLElement).matches(':focus-visible')) { focusCard = true; scheduleOpen(600); } }
  function onFocusOut(e: FocusEvent) { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) { focusCard = false; clearTimeout(openT); } }
  function onKey(e: KeyboardEvent) {
    // Tab from the thumbnail walks into the open pop-out (it lives in <body>, outside the tab order of the row)
    if (hp && e.key === 'Tab' && !e.shiftKey && e.target === thumbEl) { e.preventDefault(); hpComp?.focusFirst(); }
  }
  function exitPreview(dir: 1 | -1) {
    if (dir === -1) { thumbEl?.focus(); return; }
    const all = [...document.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((n) => !n.closest('.hp') && n.getClientRects().length);
    const next = all[all.indexOf(thumbEl) + 1];
    closePreview();
    (next ?? thumbEl)?.focus();
  }
  onDestroy(() => { clearTimeout(openT); clearTimeout(closeT); hoverOwner.update((o) => (o === uid ? '' : o)); });

  // ---- touch action sheet (the hover pop-up is not reachable without a pointer) ----
  let sheet = false, sheetEl: HTMLDivElement, moreBtn: HTMLButtonElement;
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  async function openSheet() { sheet = true; await tick(); sheetEl?.querySelector<HTMLElement>('a[href],button')?.focus(); }
  function closeSheet(refocus = true) { sheet = false; if (refocus) moreBtn?.focus(); }
  function sheetKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheetEl.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ---- feedback for failed saves (heart / Merkliste); role="status" region over the thumbnail ----
  let fb = '', fbT: ReturnType<typeof setTimeout>, favBusy = false;
  function flash() { fb = tr('home.card.saveFailed'); clearTimeout(fbT); fbT = setTimeout(() => (fb = ''), 4500); }
  onDestroy(() => clearTimeout(fbT));
  async function toggleFav() {
    if (favBusy) return;
    favBusy = true;
    const want = !fav;
    fav = want;
    try { await api(`/api/items/${item.id}/favorite`, { method: want ? 'POST' : 'DELETE' }); dispatch('favchange', { item, favorite: want }); }
    catch { fav = !want; flash(); }
    favBusy = false;
  }
  async function toggleInList() {
    const was = inList;
    if (await toggleList(item.seriesId ?? item.id, was)) { if (inList !== was) dispatch('listtoggle', { item, inList: !was }); } else flash();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article class="card" class:poster={!!posterSrc} on:mouseenter={cardEnter} on:mouseleave={cardLeave} on:focusin={onFocusIn} on:focusout={onFocusOut} on:keydown={onKey}>
  <div class="media">
  <a class="thumb" {href} bind:this={thumbEl} aria-label={item.name + (sub ? ', ' + sub : '')}>
    {#if posterOnly}<img class="blur" loading="lazy" decoding="async" {src} srcset={srcs} {sizes} alt="" aria-hidden="true" />{/if}
    {#if src}<img bind:this={imgEl} class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} loading={priority ? 'eager' : 'lazy'} fetchpriority={priority ? 'high' : undefined} decoding="async" {src} srcset={srcs} {sizes} alt="" width={posterSrc ? 200 : 320} height={posterSrc ? 300 : 180} />{/if}
    {#if tag?.kind === 'leaving'}<span class="newep leave">{$t(tag.key, { n: tag.n })}</span>
    {:else if tag && (tag.label === 'new' || tag.label === 'newSeries')}<span class="brand"><Logo size={16} label="" /><span class="neu">{$t(tag.key)}</span></span>
    {:else if tag}<span class="newep">{$t(tag.key)}</span>{/if}
    <span class="cap" class:big={!src}>{#if epSub}<span class="l1">{item.seriesName}</span><span class="l2">{epSub}</span>{:else}{item.name}{/if}</span>
    {#if pct}<span class="progress"><i style="width:{pct}%"></i></span>{/if}
  </a>
  {#if removable}<button class="rm" aria-label={$t('home.card.removeResume')} on:click={() => dispatch('remove', item)}><Icon name="x" size={14} /></button>{/if}
  <div class="fb" role="status">{#if fb}<span>{fb}</span>{/if}</div>
  <button type="button" class="mb" bind:this={moreBtn} aria-label={$t('home.card.actionsFor', { name: item.name })} aria-haspopup="dialog" aria-expanded={sheet} on:click={openSheet}><span aria-hidden="true">⋯</span></button>
  </div>
</article>
{#if hp}
  <HoverPreview
    bind:this={hpComp} {item} anchor={thumbEl} {href} {detail} {removable} {fav} startSrc={!posterSrc && imgEl?.complete ? imgEl.currentSrc : ''}
    bind:over={overPrev} bind:focused={focusPrev}
    on:close={(e) => closePreview(e.detail.refocus)} on:exit={(e) => exitPreview(e.detail.dir)}
    on:remove={(e) => { closePreview(); dispatch('remove', e.detail); }}
    on:listtoggle={(e) => dispatch('listtoggle', e.detail)}
    on:favchange={(e) => { fav = e.detail.favorite; dispatch('favchange', e.detail); }}
    on:listchanged={(e) => dispatch('listchanged', e.detail)}
  />
{/if}

{#if sheet}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" use:portal on:click={() => closeSheet()} role="presentation"></div>
  <div class="sheet" tabindex="-1" use:portal bind:this={sheetEl} role="dialog" aria-modal="true" aria-label={$t('home.card.actionsFor', { name: item.name })} on:keydown={sheetKey}>
    <p class="st">{item.name}</p>
    <a class="act" href={href} on:click={() => closeSheet(false)}><Icon name="play" size={20} />{$t('home.card.play')}</a>
    <button type="button" class="act" aria-haspopup="dialog" on:pointerenter={prefetchModal} on:click={(e) => { if (item.type !== 'Episode') primeItem(item); moreBtn?.focus(); openModal(e, detail); closeSheet(false); }}><Icon name="chevron-down" size={20} />{$t('home.card.moreInfo')}</button>
    <button type="button" class="act" on:click={() => { void toggleInList(); closeSheet(); }}><Icon name={inList ? 'check' : 'plus'} size={20} />{inList ? $t('home.card.removeFromList') : $t('home.card.addToList')}</button>
    <button type="button" class="act" aria-pressed={fav} on:click={() => { toggleFav(); closeSheet(); }}><Icon name="heart" size={20} fill={fav} />{fav ? $t('home.card.favRemove') : $t('home.card.favAdd')}</button>
    {#if item.type !== 'BoxSet' && !$kidsMode}<ListMenu itemId={item.seriesId ?? item.id} variant="row" up on:changed={(e) => dispatch('listchanged', e.detail)} />{/if}
    {#if removable}<button type="button" class="act" on:click={() => { dispatch('remove', item); closeSheet(false); }}><Icon name="x" size={20} />{$t('home.card.removeResume')}</button>{/if}
    <button type="button" class="act cancel" on:click={() => closeSheet()}>{$t('common.close')}</button>
  </div>
{/if}

<style>
  .card { position: relative; width: 100%; transform-origin: center; transition: transform var(--t-med) var(--ease) 0s; }
  .thumb { display: block; position: relative; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; transition: transform var(--t-fast) var(--ease); background: linear-gradient(135deg, #242b33, #151a20); }
  .thumb:active { transform: scale(.97); }
  .thumb:focus-visible { outline: 2px solid #fff; outline-offset: 3px; border-radius: var(--radius); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .l1 { display: block; } .l2 { display: block; font-weight: 500; font-size: .75rem; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cap.big { align-content: center; }
  .media { position: relative; }
  .poster .thumb { aspect-ratio: 2 / 3; }
  .poster .thumb::after { background: linear-gradient(transparent 70%, rgba(0,0,0,.6)); }
  .poster .cap { font-size: .8rem; }
  .fb { position: absolute; left: .5rem; right: .5rem; top: 2.2rem; z-index: 4; pointer-events: none; }
  .fb span { display: inline-block; padding: .25rem .6rem; border-radius: 6px; background: rgba(16,20,24,.92); border: 1px solid var(--err, #e5646e); color: #fff; font-size: .78rem; font-weight: 600; }
  .rm::after { content: ''; position: absolute; inset: -8px; } /* >=44px hit area, visual size unchanged */
  .brand { position: absolute; left: .45rem; top: .4rem; z-index: 2; pointer-events: none; display: flex; align-items: center; gap: .3rem; }
  .neu { padding: .05rem .4rem; border-radius: 3px; background: rgba(16,20,24,.78); color: #fff; font-size: .66rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
  .newep { position: absolute; left: .45rem; top: .45rem; z-index: 2; pointer-events: none; padding: .1rem .45rem; border-radius: 3px; background: var(--acc-fill); color: #fff; font-size: .68rem; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
  .newep.leave { background: #b3261e; }
  .blur { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover; filter: blur(18px) brightness(.55); }
  .thumb img.spoil { filter: blur(14px); transform: scale(1.1); }
  .thumb img.contain { position: relative; object-fit: contain; }
  .cap { position: absolute; left: .6rem; bottom: .5rem; right: .6rem; font-weight: 700; font-size: .85rem; text-shadow: 0 1px 6px #000, 0 0 2px #000; line-height: 1.2; }
  .cap.big { top: 0; display: grid; place-items: center; text-align: center; font-size: 1rem; padding: .5rem; }
  .thumb::after { content: ''; position: absolute; inset: 0; background: linear-gradient(transparent 55%, rgba(0,0,0,.65)); pointer-events: none; }
  .cap { z-index: 1; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.3); z-index: 2; }
  .progress i { display: block; height: 100%; background: var(--acc); }
  .rm { display: none; position: absolute; right: .4rem; top: .4rem; z-index: 3; width: 28px; min-height: 28px; height: 28px; padding: 0; border-radius: 50%; background: rgba(16,20,24,.7); border: 1.5px solid rgba(255,255,255,.6); color: #fff; place-items: center; }
  /* desktop: the card stays static; the pop-out (HoverPreview) is rendered in <body>. Subtle brightness only. */
  @media (hover: hover) and (pointer: fine) {
    .thumb { transition: transform var(--t-fast) var(--ease), filter var(--t-fast); }
    .card:hover .thumb { filter: brightness(1.12); }
  }
  .mb { display: none; position: absolute; right: 0; bottom: 0; z-index: 3; width: 44px; min-height: 44px; height: 44px; padding: 0; background: none; border: 0; color: #fff; place-items: center; }
  .mb span { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: rgba(16,20,24,.7); border: 1.5px solid rgba(255,255,255,.6); font-size: 1rem; line-height: 1; padding-bottom: .3rem; }
  @media (hover: none), (pointer: coarse) { .rm { display: grid; } .mb { display: grid; } .cap { right: 2.8rem; } }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 84; }
  .sheet { outline: none; position: fixed; z-index: 85; left: 0; right: 0; bottom: 0; max-width: 560px; margin: 0 auto; background: var(--surface); border-radius: 14px 14px 0 0; padding: .6rem .6rem calc(.6rem + var(--safe-bottom)); box-shadow: 0 -10px 40px rgba(0,0,0,.7); display: flex; flex-direction: column; gap: .1rem; }
  .st { margin: .2rem 1rem .5rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act { display: flex; gap: .8rem; align-items: center; min-height: 48px; padding: 0 1rem; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; text-decoration: none; }
  .act:hover, .act:focus-visible { background: rgba(255,255,255,.08); }
  .cancel { justify-content: center; color: var(--mut); margin-top: .2rem; }
</style>
