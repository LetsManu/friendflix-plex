<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  /** horizontal scroll position per row (title + link), kept across client-side navigation (back to home keeps the rows where they were) */
  const scrollMemo = new Map<string, number>();
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import Icon from '#lib/Icon.svelte';
  import PosterCard from '#lib/PosterCard.svelte';
  import { mobile } from '#lib/viewport';
  import { pageCount, pageIndex, INITIAL_EXTRA } from '#lib/home';
  import { t } from '#lib/i18n';

  export let title: string;
  /** null = loading (skeleton) */
  export let items: Item[] | null;
  export let href = '';
  /** small rank chip on the corner of portrait posters */
  export let ranked = false;
  /** cards get an X button; the parent handles `remove` */
  export let removable = false;
  /** phone layout: 16:9 cards with progress bar and ⓘ/⋯ bar instead of 2:3 posters (Weiterschauen, Nächste Folge) */
  export let landscape = false;
  /** first visible row of the page: its images load eagerly with high priority (LCP) */
  export let priority = false;
  let track: HTMLDivElement | undefined, section: HTMLElement | undefined;
  let canLeft = false, canRight = false, pages = 1, current = 0;
  // geometry cached by a ResizeObserver: the scroll handler only reads scrollLeft (in a rAF), never forces a layout
  let pageW = 1, maxScroll = 0, perPage = 5, raf = 0;
  const memoKey = title + '|' + href;
  /** scroll position to restore (from an earlier visit); while set, the current position is not remembered */
  let pending = scrollMemo.get(memoKey) ?? 0;

  function measure() {
    if (!track) return;
    const cs = getComputedStyle(track);
    const pad = parseFloat(cs.paddingLeft) || 0, gap = parseFloat(cs.columnGap) || 0;
    const n = parseFloat(getComputedStyle(section ?? track).getPropertyValue('--n')) || 5;
    perPage = Math.max(1, Math.floor(n));
    pageW = Math.max(1, track.clientWidth - 2 * pad + gap); // exactly the visible cards: the next page starts with the first hidden one
    maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    read();
  }
  function read() {
    if (!track) return;
    const x = track.scrollLeft;
    if (!pending) scrollMemo.set(memoKey, x);
    canLeft = x > 8;
    canRight = x < maxScroll - 8;
    pages = pageCount(maxScroll, pageW);
    current = pageIndex(x, maxScroll, pageW);
  }
  function onScroll() {
    if (!full) showAll();
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; read(); });
  }
  function go(dir: number) {
    if (!track) return;
    if (!full) showAll();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollBy({ left: dir * pageW, behavior: reduce ? 'auto' : 'smooth' });
  }

  let ro: ResizeObserver | undefined;
  function trackAction(node: HTMLDivElement) {
    track = node;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => measure()); ro.observe(node); }
    return { destroy() { ro?.disconnect(); ro = undefined; } };
  }
  // the first n+2 cards render at once, the rest on first hover / focus / scroll or when the browser is idle
  let full = false, idleId = 0;
  $: limit = full ? Infinity : perPage + INITIAL_EXTRA;
  function showAll() { full = true; }
  $: if (items && !full && typeof window !== 'undefined' && !idleId) {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    idleId = ric ? ric(showAll, { timeout: 2500 }) : (setTimeout(showAll, 1200) as unknown as number);
  }
  $: if (items && track) void afterItems(items.length, full);
  async function afterItems(_n: number, _full: boolean) {
    await tick();
    if (!track) return;
    if (pending) { if (!full) showAll(); await tick(); restore(pending, 0); }
    requestAnimationFrame(measure);
  }
  /** rows outside the viewport are skipped by content-visibility (no layout = scrollLeft clamps to 0): retry until it sticks */
  function restore(want: number, tries: number) {
    if (!track) return;
    track.scrollLeft = want;
    if (Math.abs(track.scrollLeft - want) <= 2) { pending = 0; read(); return; }
    pending = want;
    if (tries < 60) requestAnimationFrame(() => restore(want, tries + 1));
  }
  $: if (near && pending) requestAnimationFrame(() => pending && restore(pending, 0));
  // skeleton shimmer only while the row is near the viewport
  let near = false, io: IntersectionObserver | undefined;
  $: if (section && !io && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((es) => { const e = es[es.length - 1]; if (e) near = e.isIntersecting; }, { rootMargin: '200px 0px' });
    io.observe(section);
  }
  onDestroy(() => { io?.disconnect(); if (raf) cancelAnimationFrame(raf); });
</script>

{#if items === null || items.length}
  <section class="row" class:m={$mobile} class:land={landscape} class:near class:rk={ranked} bind:this={section} aria-label={title} aria-busy={items === null} on:pointerenter={() => !full && showAll()} on:focusin={() => !full && showAll()}>
    <div class="hd">
      <h2>{#if href}<a {href}>{title}<span class="more"> {$t('home.row.showAll')}</span><Icon name="chevron-right" size={18} /></a>{:else}{title}{/if}</h2>
      {#if pages > 1 && !$mobile}<ol class="dots" aria-hidden="true">{#each Array(pages) as _, i}<li class:on={i === current}></li>{/each}</ol>{/if}
    </div>
    <div class="wrap">
      <button class="arrow left" class:hide={!canLeft} aria-label={$t('home.row.prev')} on:click={() => go(-1)}><Icon name="chevron-left" size={34} /></button>
      <div class="track" use:trackAction on:scroll={onScroll} role="list">
        {#if items === null}
          {#each Array(8) as _}<div class="slot"><div class="skeleton ph" class:poster={($mobile && !landscape) || ranked}></div></div>{/each}
        {:else}
          {#each items as it, idx (it.id)}{#if idx < limit}<div class="slot" class:ranked role="listitem">{#if ranked}<span class="rank" aria-label={$t('home.row.rank', { n: idx + 1 })}>{idx + 1}</span>{/if}{#if $mobile}<PosterCard item={it} {landscape} {removable} {priority} on:remove />{:else}<Card item={it} {removable} poster={ranked} {priority} on:remove />{/if}</div>{/if}{/each}
        {/if}
      </div>
      <button class="arrow right" class:hide={!canRight} aria-label={$t('home.row.next')} on:click={() => go(1)}><Icon name="chevron-right" size={34} /></button>
    </div>
  </section>
{/if}

<style>
  /* content-visibility skips off-screen rows; the size estimate matches the real height (slot width * card ratio + title)
     so the page height - and the scroll position restored on "back" - stays exact before a row was rendered once */
  .row { position: relative; z-index: 1; margin: 1.6rem 0 0; padding-bottom: .6rem; --n: 2.4; --gap: .45rem; --sw: calc((100vw - 2 * var(--pad-x) - (var(--n) - 1) * var(--gap)) / var(--n)); content-visibility: auto; contain-intrinsic-size: auto calc(var(--sw) * .5625 + 42px); }
  .row.rk { contain-intrinsic-size: auto calc(var(--sw) * .78 + 42px); }
  .row:hover, .row:focus-within { z-index: 4; }
  @media (min-width: 560px) { .row { --n: 3; } }
  @media (min-width: 800px) { .row { --n: 4; } }
  @media (min-width: 1100px) { .row { --n: 5; } }
  @media (min-width: 1400px) { .row { --n: 6; } }
  .hd { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin: 0 var(--pad-x) .45rem; }
  h2 { font-size: clamp(1.05rem, .55vw + .8rem, 1.45rem); font-weight: 600; margin: 0; letter-spacing: -.005em; line-height: 1.25; }
  /* page indicator (top right, only while the row is hovered) */
  .dots { display: flex; gap: 2px; list-style: none; margin: 0 0 .3rem; padding: 0; opacity: 0; transition: opacity var(--t-fast); }
  .dots li { width: 12px; height: 2px; background: #3c4650; }
  .dots li.on { background: #aaa; }
  .row:hover .dots, .row:focus-within .dots { opacity: 1; }
  h2 a { display: inline-flex; align-items: center; gap: .2rem; }
  .more { font-size: .8rem; color: #54b9c5; max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0; transition: max-width var(--t-med), opacity var(--t-med), margin var(--t-med); }
  h2 a:hover .more, h2 a:focus-visible .more { max-width: 10rem; opacity: 1; margin-left: .6rem; }
  .wrap { position: relative; }
  .track { display: flex; gap: var(--gap); overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; scrollbar-width: none; padding: .4rem var(--pad-x) .6rem; margin: -.4rem 0 -.6rem; /* small room for focus rings; the hover pop-out lives in <body> */ scroll-padding: 0 var(--pad-x); }
  .track::-webkit-scrollbar { display: none; }
  /* 100% = the track content box (inside the pad-x padding): exactly n cards per page, the neighbours peek in the padding */
  .slot { flex: 0 0 calc((100% - (var(--n) - 1) * var(--gap)) / var(--n)); scroll-snap-align: start; min-width: 0; }
  /* ranked row: normal portrait posters with a small filled rank chip on the top-right corner */
  .slot.ranked { position: relative; }
  .rank { position: absolute; right: .45rem; top: .45rem; z-index: 3; display: inline-flex; align-items: center; justify-content: center; min-width: 1.7rem; height: 1.7rem; padding: 0 .5rem; border-radius: 99px; background: var(--acc-fill); color: #fff; font-size: .85rem; font-weight: 800; line-height: 1; box-shadow: 0 2px 8px rgba(0, 0, 0, .45); pointer-events: none; user-select: none; }
  .row:not(.near) :global(.skeleton::after) { animation: none; display: none; }
  .ph { aspect-ratio: 16 / 9; width: 100%; }
  .ph.poster { aspect-ratio: 2 / 3; }
  .arrow { position: absolute; top: .4rem; bottom: .6rem; width: var(--pad-x); min-width: 44px; border-radius: 0; background: rgba(16, 20, 24, .55); opacity: 0; z-index: 7; padding: 0; }
  .arrow:hover:not(:disabled) { background: rgba(16, 20, 24, .8); }
  .arrow.left { left: 0; } .arrow.right { right: 0; }
  .arrow.hide { display: none; }
  .row:hover .arrow, .arrow:focus-visible { opacity: 1; }
  @media (hover: none), (pointer: coarse) { .arrow { display: none; } }

  /* ---- phone: swipeable poster rows (3.2 posters visible), no hover room needed ---- */
  .row.m { --gap: .4rem; --pw: calc((100vw - var(--pad-x) - 3 * var(--gap)) / 3.2); margin-top: 1.4rem; contain-intrinsic-size: auto calc(var(--pw) * 1.5 + 39px); }
  .row.m.land { contain-intrinsic-size: auto calc(var(--pw) * .5625 + 80px); }
  .row.m:hover, .row.m:focus-within { z-index: 1; }
  .row.m .hd { margin: 0 var(--pad-x) .5rem; }
  .row.m h2 { font-size: 1.05rem; font-weight: 700; }
  .row.m .track { padding: 0 var(--pad-x); margin: 0; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
  .row.m .slot { flex: 0 0 var(--pw); }
  .row.m .arrow { display: none; }
  .row.m .rank { right: .3rem; top: .3rem; min-width: 1.5rem; height: 1.5rem; font-size: .78rem; }
  .row.m.land { --pw: calc((100vw - var(--pad-x)) / 2.15); }
</style>
