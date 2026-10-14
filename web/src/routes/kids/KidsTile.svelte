<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { img, srcset, type Item } from '#lib/api';
  import { itemPath, playPath } from '#lib/mobile';
  import { t } from '#lib/i18n';

  /** Big rounded poster tile of the kids pages: opens the title, or plays it right away (`play`, "Weiterschauen"). */
  export let item: Item;
  export let play = false;
  $: posterId = item.type === 'Episode' && item.seriesId ? item.seriesId : item.id;
  $: hasPoster = item.type === 'Episode' ? Boolean(item.seriesId) : item.image;
  $: title = item.type === 'Episode' && item.seriesName ? item.seriesName : item.name;
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  // a gradient per title when there is no artwork (stable: derived from the id)
  $: hue = [...item.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
</script>

<a class="tile" href={play ? playPath(item) : itemPath(item)} aria-label={play ? $t('kids.home.play', { name: title }) : title}>
  <span class="art">
  {#if hasPoster}
    <img loading="lazy" decoding="async" src={img(posterId, 320)} srcset={srcset('Primary', posterId, [240, 320, 480])} sizes="(max-width: 720px) 40vw, 220px" alt="" width="220" height="330" />
  {:else}
    <span class="noimg" style="background:linear-gradient(150deg,hsl({hue} 80% 62%),hsl({(hue + 50) % 360} 75% 45%))">{title}</span>
  {/if}
  {#if pct}<span class="bar" aria-hidden="true"><i style="width:{pct}%"></i></span>{/if}
  </span>
  <span class="nm" aria-hidden="true">{title}</span>
</a>

<style>
  .tile { position: relative; flex: none; display: flex; flex-direction: column; gap: .45rem; width: clamp(132px, 38vw, 210px); scroll-snap-align: start; color: var(--k-ink); border-radius: 24px; outline: none; }
  img, .noimg { display: block; width: 100%; aspect-ratio: 2 / 3; height: auto; object-fit: cover; border-radius: 24px; background: var(--k-card); box-shadow: 0 6px 18px rgba(0, 0, 0, .28); transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast); }
  .noimg { display: grid; place-items: center; padding: .8rem; text-align: center; font-size: 1.15rem; font-weight: 800; color: #fff; text-shadow: 0 1px 6px rgba(0, 0, 0, .35); }
  .tile:hover img, .tile:hover .noimg, .tile:focus-visible img, .tile:focus-visible .noimg { transform: translateY(-4px) scale(1.03); box-shadow: 0 0 0 5px var(--k-focus), 0 12px 26px rgba(0, 0, 0, .35); }
  .nm { font-size: 1.05rem; font-weight: 700; line-height: 1.25; padding: 0 .3rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .art { position: relative; display: block; }
  .bar { position: absolute; left: 14px; right: 14px; bottom: 14px; height: 8px; border-radius: 99px; background: rgba(255, 255, 255, .55); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--k-accent); border-radius: 99px; }
  @media (prefers-reduced-motion: reduce) { img, .noimg { transition: none; } .tile:hover img, .tile:hover .noimg, .tile:focus-visible img, .tile:focus-visible .noimg { transform: none; } }
</style>
