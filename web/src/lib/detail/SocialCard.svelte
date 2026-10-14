<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { api } from '#lib/api';
  import { kidsMode } from '#lib/kids';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Reactions from '#lib/Reactions.svelte';

  /** Reactions (movies, episodes) and the friends' stars (stars, review, list) as one card of the Details tab; nothing on kids profiles. */
  export let id: string;
  export let type: string;

  interface Rating { name: string; stars: number; review?: string | null; mine?: boolean }
  let ratings: Rating[] = [], avg: number | null = null, stars = 0, review = '', msg = '', seq = 0;
  /** after the viewer's own rating: the friends' average now (the ratings line above updates from it) */
  const dispatch = createEventDispatcher<{ rated: { average: number | null } }>();

  $: if (!$kidsMode) void load(id);
  async function load(itemId: string) {
    const my = ++seq;
    ratings = []; avg = null; stars = 0; review = ''; msg = '';
    try {
      const rr = await api(`/api/items/${itemId}/ratings`);
      if (my !== seq) return;
      ratings = rr.ratings ?? []; avg = rr.average ?? null;
      const mine = ratings.find((x) => x.mine);
      stars = mine?.stars ?? 0; review = mine?.review ?? '';
    } catch { /* optional: the card stays empty */ }
  }
  async function rate() {
    if (!stars) return;
    msg = '';
    try {
      await api(`/api/items/${id}/rating`, { method: 'PUT', body: { stars, review: review || undefined } });
      const rr = await api(`/api/items/${id}/ratings`); ratings = rr.ratings ?? []; avg = rr.average ?? null;
      dispatch('rated', { average: avg });
    } catch { msg = tr('detail.view.saveFailed'); }
  }
</script>

{#if !$kidsMode}
  <div class="social panel">
    {#if type === 'Movie' || type === 'Episode'}<Reactions {id} />{/if}
    <section class="rate" class:sep={type === 'Movie' || type === 'Episode'} aria-labelledby="rt-h">
      <h2 id="rt-h">{$t('detail.ratings.title')} {#if avg}<span class="badge">{$t('detail.ratings.average', { avg: fmtNumber(avg, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>{/if}</h2>
      <div class="flex" role="group" aria-label={$t('detail.ratings.stars')}>
        {#each [1, 2, 3, 4, 5] as n}<button type="button" class="icon-btn star" class:on={stars >= n} aria-pressed={stars >= n} aria-label={$t('detail.ratings.star', { n })} on:click={() => (stars = n)}><Icon name="star" size={24} fill={stars >= n} /></button>{/each}
        <input placeholder={$t('detail.ratings.review')} maxlength="280" bind:value={review} aria-label={$t('detail.ratings.reviewLabel')} />
        <button type="button" disabled={!stars} on:click={rate}>{$t('detail.ratings.save')}</button>
      </div>
      {#if msg}<p class="err" role="status">{msg}</p>{/if}
      {#each ratings as r}<p><b>{r.name}</b> <span class="warn">{'★'.repeat(r.stars)}</span> <span class="muted">{r.review ?? ''}</span></p>{/each}
    </section>
  </div>
{/if}

<style>
  .social { margin-top: 2rem; display: grid; gap: 1.4rem; }
  /* one card: the reactions lose their own panel frame */
  .social :global(.reactions) { margin: 0; padding: 0; background: none; border: 0; box-shadow: none; }
  .rate.sep { border-top: 1px solid var(--line); padding-top: 1.2rem; }
  .rate h2 { font-size: 1.4rem; margin: 0 0 .6rem; }
  .rate input { flex: 1; min-width: 200px; }
  .star.on { color: #f5c518; }
</style>
