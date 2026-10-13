<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { api, backdrop, cachedDetail, img, primeDetail, primeItem, setCachedThumb, srcset, type Item, type ItemDetail } from '#lib/api';
  import { playPrefetch } from '#lib/player/prefetch';
  import { prefetchModal } from '#lib/lazy';
  import { listIds, toggleList, prefs } from '#lib/stores';
  import { t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import { kidsMode } from '#lib/kids';
  import RatingButton from '#lib/RatingButton.svelte';
  import MoreActions, { type MoreAction } from '#lib/MoreActions.svelte';
  import { toThumb, type Thumb } from '#lib/rating';
  import { openModal } from '#lib/modal';
  import { isSpoiler } from '#lib/spoiler';
  import { cardTag } from '#lib/badges';
  import { badges, loadFacts, wantBadge, type MediaTraits } from '#lib/fresh';
  import QualityChips from '#lib/QualityChips.svelte';
  import { genreLine, lengthLabel, previewRect, ratingBadge, type PreviewBox } from '#lib/hover';
  import { playPreview, previewFailed, previewOwner, stopPreview, toggleSound } from '#lib/preview';

  /** Desktop pop-out preview of a card: portal on <body>, grows out of the card, clamped to the viewport. */
  export let item: Item;
  /** the card's 16:9 thumbnail; the pop-out starts exactly there */
  export let anchor: HTMLElement;
  export let href: string;
  export let detail: string;
  export let removable = false;
  export let fav = false;
  /** the image the card already shows (currentSrc): painted at once, the sharper srcset image fades in over it */
  export let startSrc = '';
  /** pointer is over the pop-out / focus is inside it (the card keeps it open while true) */
  export let over = false;
  export let focused = false;

  const dispatch = createEventDispatcher<{
    close: { refocus: boolean };
    exit: { dir: 1 | -1 };
    remove: Item;
    listtoggle: { item: Item; inList: boolean };
    favchange: { item: Item; favorite: boolean };
    listchanged: { listId: string; contains: boolean };
  }>();

  let el: HTMLDivElement, pv: HTMLVideoElement | undefined;
  let box: PreviewBox | null = null, ready = false, playing = false, vmuted = true, hiLoaded = false;
  let thumb: Thumb = 0, fb = '', fbT: ReturnType<typeof setTimeout>, favBusy = false;
  let startT: ReturnType<typeof setTimeout>;
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  $: listId = item.seriesId ?? item.id;
  $: inList = $listIds.has(listId);
  $: src = item.backdrop ? backdrop(item.id, 520) : item.image ? img(item.id, 520) : '';
  $: srcs = item.backdrop ? srcset('Backdrop', item.id, [520, 780, 1280]) : item.image ? srcset('Primary', item.id, [320, 520, 780]) : '';
  $: posterOnly = !item.backdrop && item.image;
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: badgeId = item.type === 'Episode' ? item.seriesId : item.id;
  $: wantBadge(badgeId);
  $: tag = cardTag(badgeId ? $badges[badgeId] : undefined, item, Date.now());
  // quality chips (4K / HDR / Atmos ...) arrive a moment after the pop-out opened; nothing is shown while unknown
  let traits: MediaTraits | null = null;
  $: if (item.type !== 'BoxSet') void loadFacts(listId).then((f) => { if (f && listId === (item.seriesId ?? item.id)) traits = f.traits; });
  $: rate = ratingBadge(item, Date.now());
  $: len = lengthLabel(item);
  $: genres = genreLine(item.genres);
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} · S${item.parentIndexNumber ?? '?'}:E${item.indexNumber ?? '?'}` : '';
  $: if ($previewOwner !== item.id && playing) playing = false; // somebody else took over / the preview failed

  function compute(infoH?: number) {
    const r = anchor.getBoundingClientRect();
    box = previewRect({ left: r.left, top: r.top, width: r.width, height: r.height }, { w: window.innerWidth, h: window.innerHeight }, infoH);
  }

  onMount(() => {
    compute();
    void tick().then(() => {
      if (!el || !box) return;
      // the info panel has no fixed height: measure it and re-clamp vertically
      compute(el.offsetHeight - box.mediaH);
      void tick().then(() => {
        ready = true;
        if (!reduce && box && el.animate) {
          const f = box.from;
          el.animate([{ transform: `translate(${f.dx}px, ${f.dy}px) scale(${f.scale})`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
        }
      });
    });
    // sound-on preview after 1 s, only titles that have a clip and only when the viewer allows it
    startT = setTimeout(startVideo, 1000);
    if (item.type !== 'Episode') primeItem(item);
    prefetchModal();
    void loadThumb();
  });
  onDestroy(() => { clearTimeout(startT); clearTimeout(fbT); if (playing || $previewOwner === item.id) stopPreview(item.id); });

  async function startVideo() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (previewFailed(item.id) || !$prefs.hoverTrailers || reduce || nav.connection?.saveData || document.hidden) return;
    if (!(item.trailers || ($prefs.hoverClip && (item.type === 'Movie' || item.type === 'Series')))) return;
    playing = true;
    if (!(await playPreview(item.id, () => pv))) playing = false;
  }

  let thumbTouched = false;
  async function loadThumb() {
    // the same response feeds the detail popup (rendered from cache when the chevron is clicked)
    const hit = cachedDetail(listId);
    if (hit) thumb = toThumb(hit.thumb); // show at once, then revalidate: the rating may have changed on another device/tab
    try {
      const r = await api<ItemDetail>(`/api/items/${listId}`);
      if (!thumbTouched) thumb = toThumb(r?.thumb); // never overwrite a rating the viewer set meanwhile
      primeDetail(thumbTouched ? { ...r, thumb } : r);
    } catch { /* optional */ }
  }
  function onThumb(e: CustomEvent<{ value: Thumb }>) { thumbTouched = true; setCachedThumb(listId, e.detail.value); }
  function flash() { fb = tr('home.card.saveFailed'); clearTimeout(fbT); fbT = setTimeout(() => (fb = ''), 4500); }
  // after a mouse click drop the focus again (keyboard users keep it)
  const release = (e: MouseEvent) => { if (e.detail > 0) (e.currentTarget as HTMLElement).blur(); };
  async function toggleInList(e: MouseEvent) {
    release(e);
    const was = inList;
    if (await toggleList(listId, was)) { if (inList !== was) dispatch('listtoggle', { item, inList: !was }); } else flash();
  }
  async function toggleFav() {
    if (favBusy) return;
    favBusy = true;
    const want = !fav;
    fav = want;
    try { await api(`/api/items/${item.id}/favorite`, { method: want ? 'POST' : 'DELETE' }); dispatch('favchange', { item, favorite: want }); }
    catch { fav = !want; flash(); }
    favBusy = false;
  }
  // everything that is not Play / Merkliste / Bewerten / Details lives in "⋯ Mehr"
  let actions: MoreAction[] = [];
  $: actions = [
    { id: 'fav', label: fav ? $t('home.card.favRemove') : $t('home.card.favAdd'), icon: 'heart', pressed: fav, run: toggleFav },
    ...(removable ? [{ id: 'remove', label: $t('home.card.removeResume'), icon: 'x', run: () => { dispatch('remove', item); } }] : []),
    { id: 'details', label: $t('home.card.openDetail'), icon: 'info', href: detail },
  ];
  function more(e: MouseEvent) { if (item.type !== 'Episode') primeItem(item); dispatch('close', { refocus: false }); openModal(e, detail); }

  // ---- closing: Escape, scroll, navigation ----
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !document.querySelector('.lm-pop, .ma-pop')) { dispatch('close', { refocus: true }); }
  }
  function onScroll(e: Event) {
    const t = e.target as Node | null;
    if (t && t instanceof Element && (el?.contains(t) || t.closest?.('.lm-pop, .ma-pop'))) return;
    dispatch('close', { refocus: false });
  }
  beforeNavigate(() => dispatch('close', { refocus: false }));

  const FOCUSABLE = 'a[href],button:not([disabled])';
  const controls = () => [...(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((c) => c.offsetParent !== null || c.getClientRects().length);
  function tabKey(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const f = controls();
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); dispatch('exit', { dir: -1 }); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); dispatch('exit', { dir: 1 }); }
  }
  export function focusFirst() { controls()[0]?.focus(); }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  function leaveFocus(e: FocusEvent) { if (!el?.contains(e.relatedTarget as Node | null)) focused = false; }
</script>

<svelte:window on:keydown|capture={onKey} on:scroll|capture={onScroll} on:resize={() => dispatch('close', { refocus: false })} on:blur={() => dispatch('close', { refocus: false })} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="hp" data-play-scope class:ready use:portal bind:this={el} role="group" aria-label={$t('home.card.preview', { name: item.name })}
  style={box ? `left:${box.left}px;top:${box.top}px;width:${box.width}px;` : 'left:0;top:0;width:300px;'}
  on:mouseenter={() => (over = true)} on:mouseleave={() => (over = false)}
  on:focusin={() => (focused = true)} on:focusout={leaveFocus} on:keydown={tabKey}
>
  <div class="media" data-play-art style={box ? `height:${box.mediaH}px` : ''}>
    {#if posterOnly}<img class="blur" src={startSrc || src} alt="" aria-hidden="true" />{/if}
    {#if startSrc}<img class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} src={startSrc} alt="" />{/if}
    {#if src}<img class="hi" class:on={hiLoaded || !startSrc} class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} {src} srcset={srcs} sizes="{box?.width ?? 360}px" alt="" on:load={() => (hiLoaded = true)} />{/if}
    {#if playing}<!-- svelte-ignore a11y_media_has_caption --><video bind:this={pv} class="pv" loop playsinline on:volumechange={() => pv && (vmuted = pv.muted)} on:playing={() => pv && (vmuted = pv.muted)}></video>{/if}
    <span class="shade"></span>
    {#if tag}<span class="newep" class:leave={tag.kind === 'leaving'}>{$t(tag.key, { n: tag.kind === 'leaving' ? tag.n : 0 })}</span>{/if}
    <span class="cap">{item.type === 'Episode' && item.seriesName ? item.seriesName : item.name}</span>
    {#if playing}<button type="button" class="snd" aria-label={vmuted ? $t('home.card.soundOn') : $t('home.card.soundOff')} aria-pressed={!vmuted} on:click={(e) => { release(e); toggleSound(pv); }}><Icon name={vmuted ? 'volume-off' : 'volume'} size={16} /></button>{/if}
    {#if pct}<span class="progress"><i style="width:{pct}%"></i></span>{/if}
  </div>
  <div class="info">
    <div class="acts">
      <a class="round play" {href} use:playPrefetch aria-label={$t('home.card.playName', { name: item.name })} title={$t('home.card.play')}><Icon name="play" size={18} /></a>
      <button type="button" class="round" aria-label={inList ? $t('home.card.removeFromList') : $t('home.card.addToListLong')} title={$t('home.card.myList')} on:click={toggleInList}><Icon name={inList ? 'check' : 'plus'} size={18} /></button>
      {#if item.type !== 'BoxSet'}<RatingButton itemId={listId} bind:value={thumb} on:change={onThumb} on:error={flash} />{/if}
      <span class="right">
        <MoreActions {actions} title={item.name} label={$t('home.card.moreActionsFor', { name: item.name })}>
          {#if item.type !== 'BoxSet' && !$kidsMode}<ListMenu itemId={listId} variant="row" on:changed={(e) => dispatch('listchanged', e.detail)} />{/if}
        </MoreActions>
        <a class="round" href={detail} aria-label={$t('home.card.moreInfoFor', { name: item.name })} aria-haspopup="dialog" title={$t('home.card.moreInfo')} on:pointerenter={prefetchModal} on:focus={prefetchModal} on:click={more}><Icon name="chevron-down" size={18} /></a>
      </span>
    </div>
    <div class="fb" role="status">{#if fb}<span>{fb}</span>{/if}</div>
    <div class="meta">
      {#if rate}<span class:match={rate.startsWith('★')} class:fresh={rate === $t('home.card.new')}>{rate}</span>{/if}
      {#if item.rating}<span class="age">{item.rating}</span>{/if}
      {#if len}<span>{len}</span>{/if}
    </div>
    <QualityChips {traits} />
    {#if item.caption}<div class="sub cap2">{item.caption}</div>{:else if sub}<div class="sub">{sub}</div>{/if}
    {#if genres}<div class="sub">{genres}</div>{/if}
  </div>
</div>

<style>
  .hp { position: fixed; z-index: 65; background: var(--surface); border-radius: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.06); overflow: hidden; transform-origin: 0 0; visibility: hidden; color: var(--fg); }
  .hp.ready { visibility: visible; }
  .media { position: relative; background: #0a0d10; overflow: hidden; }
  .media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .media img.contain { object-fit: contain; }
  .blur { inset: -10%; width: 120%; height: 120%; filter: blur(18px) brightness(.55); }
  .media img.spoil { filter: blur(14px); transform: scale(1.1); }
  .pv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  .shade { position: absolute; inset: 0; background: linear-gradient(transparent 50%, rgba(24,24,24,.95)); pointer-events: none; }
  .cap { position: absolute; left: .9rem; right: 3.4rem; bottom: .6rem; font-weight: 800; font-size: 1.05rem; line-height: 1.2; text-shadow: 0 1px 8px #000; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; pointer-events: none; }
  .newep { position: absolute; left: .7rem; top: .6rem; padding: .1rem .45rem; border-radius: 3px; background: var(--acc-fill); color: #fff; font-size: .68rem; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
  .newep.leave { background: #b3261e; }
  .snd { position: absolute; right: .7rem; bottom: .6rem; z-index: 2; width: 32px; min-height: 32px; height: 32px; padding: 0; border-radius: 50%; background: rgba(16,20,24,.7); border: 1.5px solid rgba(255,255,255,.6); color: #fff; }
  .snd::after { content: ''; position: absolute; inset: -6px; }
  .snd:hover:not(:disabled) { background: rgba(16,20,24,.9); border-color: #fff; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.3); }
  .progress i { display: block; height: 100%; background: var(--acc); }
  .info { padding: .75rem .9rem 1rem; }
  .acts { display: flex; gap: .4rem; align-items: center; }
  .round { width: 34px; min-height: 34px; height: 34px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; position: relative; }
  .round::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; }
  .round:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  .round.play { background: var(--acc-fill); color: #fff; border-color: var(--acc-fill); }
  .round.play:hover { background: var(--acc-fill-hover); border-color: var(--acc-fill-hover); }
  .right { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
  .media img.hi { opacity: 0; transition: opacity .15s linear; }
  .media img.hi.on { opacity: 1; }
  .fb { min-height: 0; }
  .fb span { display: inline-block; margin-top: .4rem; padding: .2rem .55rem; border-radius: 6px; background: rgba(16,20,24,.92); border: 1px solid var(--err, #e5646e); font-size: .78rem; font-weight: 600; }
  .meta { display: flex; gap: .6rem; align-items: center; margin-top: .7rem; font-size: .8rem; color: #d2d2d2; flex-wrap: wrap; }
  .match { color: var(--ok); font-weight: 700; }
  .fresh { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255,255,255,.45); padding: 0 .35rem; line-height: 1.35; }
  .sub { font-size: .8rem; margin-top: .4rem; color: #e0e0e0; }
  .cap2 { color: #f5c518; }
  :global(html.tv) .hp { display: none; }
</style>
