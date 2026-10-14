<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { api, getActiveProfile } from '#lib/api';
  import type { Story } from '#lib/fresh';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';

  /**
   * "Die Geschichte bisher": shown on a series the viewer is about to continue after a longer break or into a new season. Only the
   * overviews the media server already has (previous season, last watched episode), no generated text. Dismissed per profile, series
   * and next episode, so it comes back with the next season / the next break.
   */
  export let seriesId: string;
  let story: Story | null = null, gone = false, seq = 0;

  const dismissKey = (s: Story) => `ff-story:${getActiveProfile() || '-'}:${seriesId}:${s.next.id}`;
  function dismissed(s: Story): boolean { try { return localStorage.getItem(dismissKey(s)) === '1'; } catch { return false; } }
  function dismiss() {
    gone = true;
    if (story) try { localStorage.setItem(dismissKey(story), '1'); } catch { /* storage blocked: hidden until the next visit */ }
  }
  async function load(id: string) {
    const my = ++seq;
    story = null; gone = false;
    try {
      const r = await api<{ story: Story | null }>(`/api/items/${id}/story`);
      if (my !== seq || !r.story) return;
      if (dismissed(r.story)) return;
      story = r.story;
    } catch { /* optional card */ }
  }
  $: if (seriesId) void load(seriesId);
</script>

{#if story && !gone}
  <section class="story" aria-labelledby="story-h-{seriesId}">
    <div class="top">
      <div>
        <h2 id="story-h-{seriesId}">{$t('fresh.story.title')}</h2>
        <p class="why">{story.reason === 'newSeason' ? $t('fresh.story.newSeason', { n: story.next.season }) : $t('fresh.story.longBreak', { n: story.weeks ?? 0 })}</p>
      </div>
      <button type="button" class="x" aria-label={$t('fresh.story.dismiss')} title={$t('fresh.story.dismiss')} on:click={dismiss}><Icon name="x" size={18} /></button>
    </div>
    {#if story.season}
      <div class="blk"><h3>{$t('fresh.story.season', { n: story.season.number })}</h3><p>{story.season.overview}</p></div>
    {/if}
    {#if story.episode.overview}
      <div class="blk"><h3>{$t('fresh.story.lastEpisode', { s: story.episode.season, e: story.episode.index, name: story.episode.name })}</h3><p>{story.episode.overview}</p></div>
    {/if}
  </section>
{/if}

<style>
  .story { margin-top: 1.6rem; padding: 1rem 1.2rem 1.1rem; border-radius: 8px; background: var(--surface-2, #20262d); border-left: 3px solid var(--acc); }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
  h2 { margin: 0; font-size: 1.15rem; }
  .why { margin: .15rem 0 0; color: var(--mut); font-size: .88rem; }
  .blk { margin-top: .8rem; }
  h3 { margin: 0 0 .2rem; font-size: .9rem; font-weight: 700; color: #e6e6e6; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .blk p { font-size: .95rem; color: #d6d6d6; }
  .x { flex: none; width: 44px; min-height: 44px; margin: -.5rem -.6rem 0 0; padding: 0; border-radius: 50%; background: transparent; color: #fff; display: grid; place-items: center; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
</style>
