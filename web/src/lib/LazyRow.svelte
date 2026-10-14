<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getActiveProfile, type Item } from '#lib/api';
  import Row from '#lib/Row.svelte';
  import { homeCache } from '#lib/home';

  export let title: string;
  export let load: () => Promise<Item[]>;
  export let href = '';
  /** key in the home cache (survives client-side navigation for 5 minutes); empty = no caching */
  export let cacheKey = '';
  $: key = cacheKey ? `${getActiveProfile()}|${cacheKey}` : '';
  const hit = cacheKey ? homeCache.get(`${getActiveProfile()}|${cacheKey}`) : undefined;
  let items: Item[] | null = (hit?.value as Item[] | undefined) ?? null;
  let el: HTMLDivElement;

  /** Fetches only when the row approaches the viewport (keeps the first paint fast, spares Jellyfin); cached rows render at once. */
  onMount(() => {
    if (hit?.fresh) return;
    const io = new IntersectionObserver((e) => {
      if (e[0]?.isIntersecting) {
        io.disconnect();
        load().then((r) => { items = r; if (key) homeCache.set(key, r); }).catch(() => (items = items ?? []));
      }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  });
</script>

<div bind:this={el}><Row {title} {items} {href} /></div>
