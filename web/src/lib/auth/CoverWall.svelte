<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The sign-in background (spec Part C "Cover wall"): 5 tilted columns of small covers from the library, moving slowly up and down in
   * turn, dimmed toward the card. Decorative only: hidden from assistive technology, nothing focusable, no titles.
   * Covers come from the public `GET /api/public/login-art` (same-origin paths); without them (wall off, empty library, setup's 503, an
   * outage: any non-200) the wall shows generated colour tiles from the app's palette. Still under `prefers-reduced-motion`.
   */
  import { onMount } from 'svelte';
  import { artPaths, fallbackArt, wallColumns } from './flow';

  const COLS = 5;
  /** per column (from the mockup): durations alternate with the direction */
  const DURATIONS = [48, 58, 44, 51, 59] as const;
  const FALLBACK_PER_COL = 8;

  let columns: string[][] = [];
  let loaded = false;
  // generated tiles: the same for everyone on a given day, so the wall does not flicker between loads
  const fallback = Array.from({ length: COLS }, (_, c) => {
    const tiles = fallbackArt(Math.floor(Date.now() / 86_400_000) * 7 + c, FALLBACK_PER_COL);
    return [...tiles, ...tiles];
  });

  onMount(() => {
    const ctl = new AbortController();
    void (async () => {
      try {
        const r = await fetch('/api/public/login-art', { credentials: 'same-origin', signal: ctl.signal });
        if (r.status === 200) columns = wallColumns(artPaths(await r.json()), COLS);
      } catch { /* offline or no JSON: generated tiles */ }
      loaded = true;
    })();
    return () => ctl.abort();
  });
  /** a cover that does not load leaves its tile empty (the tile keeps the column's rhythm) */
  const hide = (e: Event) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden');
</script>

<div class="wall" aria-hidden="true" data-wall={columns.length ? 'covers' : loaded ? 'generated' : 'loading'}>
  <div class="tiles">
    {#if columns.length}
      {#each columns as col, c (c)}
        <div class="col" class:down={c % 2 === 1} style="animation-duration:{DURATIONS[c % DURATIONS.length]}s">
          {#each col as src, i (i)}
            <i class="tile"><img {src} loading="lazy" decoding="async" alt="" aria-hidden="true" draggable="false" on:error={hide} /></i>
          {/each}
        </div>
      {/each}
    {:else}
      {#each fallback as col, c (c)}
        <div class="col" class:down={c % 2 === 1} style="animation-duration:{DURATIONS[c % DURATIONS.length]}s">
          {#each col as t, i (i)}
            <i class="tile art" style="background:linear-gradient({t.angle}deg,{t.from},{t.to})"></i>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
  <div class="shade"></div>
</div>

<style>
  .wall { position: absolute; inset: 0; overflow: hidden; pointer-events: none; user-select: none;
    background: radial-gradient(120% 70% at 20% 0%, #3a1a2a 0%, transparent 60%), radial-gradient(90% 60% at 100% 30%, #16323a 0%, transparent 60%), var(--bg); }
  .tiles { position: absolute; inset: -20%; display: flex; gap: 8px; opacity: .55; transform: rotate(-10deg); }
  .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; animation: wall-up linear infinite; will-change: transform; }
  .col.down { animation-name: wall-down; }
  @keyframes wall-up { from { transform: translateY(0); } to { transform: translateY(-50%); } }
  @keyframes wall-down { from { transform: translateY(-50%); } to { transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .col { animation: none; } }
  .tile { display: block; flex: none; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: var(--surface-2); }
  .tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
  /* phone: the card sits at the bottom, the wall dims toward it (mockup values) */
  .shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(16, 20, 24, .25) 0%, rgba(16, 20, 24, .55) 35%, rgba(16, 20, 24, .9) 70%, var(--bg) 100%); }
  /* desktop: the card is centred, the wall dims toward the middle */
  @media (min-width: 640px) {
    .shade { background: radial-gradient(ellipse 60% 70% at 50% 50%, rgba(16, 20, 24, .9) 0%, rgba(16, 20, 24, .55) 55%, rgba(16, 20, 24, .25) 100%); }
  }
</style>
