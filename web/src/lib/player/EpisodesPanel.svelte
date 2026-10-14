<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  import type { Item } from '#lib/api';
  /** seasons / episodes stay cached while the player hops from episode to episode */
  const seasonCache = new Map<string, Item[]>();
  const episodeCache = new Map<string, Item[]>();
</script>

<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { api, img } from '#lib/api';
  import { fmtDuration, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';

  /** Player "Folgen" panel: season picker + episode list; the playing episode is highlighted, a click plays another one. */
  export let seriesId: string;
  export let seasonId = '';
  export let currentId: string;
  const dispatch = createEventDispatcher<{ pick: { id: string }; close: void }>();

  let seasons: Item[] = seasonCache.get(seriesId) ?? [], season = seasonId, episodes: Item[] | null = null, failed = false, list: HTMLUListElement;
  let epSeq = 0;
  async function loadSeasons() {
    if (seasons.length) return;
    try { seasons = (await api(`/api/items/${seriesId}/seasons`)).items as Item[]; seasonCache.set(seriesId, seasons); } catch { seasons = []; }
    if (!season) season = seasons[0]?.id ?? '';
    if (!season) void loadEpisodes(''); // no seasons (flat series): all episodes
  }
  async function loadEpisodes(sid: string) {
    const my = ++epSeq, key = `${seriesId}:${sid}`;
    const hit = episodeCache.get(key);
    if (hit) { episodes = hit; return; }
    episodes = null; failed = false;
    try {
      const r = (await api(`/api/items/${seriesId}/episodes${sid ? `?seasonId=${sid}` : ''}`)).items as Item[];
      if (my !== epSeq) return;
      episodes = r; episodeCache.set(key, r);
    } catch { if (my === epSeq) { episodes = []; failed = true; } }
  }
  $: if (season) void loadEpisodes(season);
  onMount(() => { void loadSeasons(); });
  // once the episodes are rendered (cache hit or after the request): the playing episode is in view and focused
  // (keyboard users continue from there). Only the first time, and never stealing focus the viewer already moved inside the panel.
  let placed = false, root: HTMLDivElement;
  $: if (!placed && list && episodes?.length) { placed = true; void tick().then(placeCurrent); }
  function placeCurrent() {
    const cur = list?.querySelector<HTMLElement>('[aria-current="true"]');
    cur?.scrollIntoView({ block: 'center' });
    if (root?.contains(document.activeElement)) return;
    (cur ?? list?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }
  /** run time in the UI language ("52 Min.", "1 Std. 5 Min."); `$locale` re-renders the page, so a plain call is enough */
  const mins = (ticks: number) => fmtDuration(Math.round(ticks / 600_000_000) * 60);
  const pct = (e: Item) => (e.played ? 100 : e.runtimeTicks && e.positionTicks ? Math.min(100, (e.positionTicks / e.runtimeTicks) * 100) : 0);
</script>

<div class="eps" role="dialog" aria-label={$t('player.episodes.title')} data-nav data-scope bind:this={root}>
  <header>
    {#if seasons.length > 1}
      <label class="sel"><span class="sr">{$t('player.episodes.season')}</span>
        <select bind:value={season} aria-label={$t('player.episodes.season')}>{#each seasons as s (s.id)}<option value={s.id}>{s.name}</option>{/each}</select>
      </label>
    {:else}
      <b>{seasons[0]?.name ?? $t('player.episodes.title')}</b>
    {/if}
    <button type="button" class="icx" aria-label={$t('player.episodes.close')} on:click={() => dispatch('close')}><Icon name="x" size={20} /></button>
  </header>
  {#if episodes === null}
    <p class="muted pad" role="status">{$t('player.episodes.loading')}</p>
  {:else if !episodes.length}
    <p class="muted pad" role="status">{failed ? $t('player.episodes.failed') : $t('player.episodes.none')}</p>
  {:else}
    <ul bind:this={list}>
      {#each episodes as e (e.id)}
        {@const cur = e.id === currentId}
        <li>
          <button type="button" class="ep" class:cur aria-current={cur ? 'true' : undefined} on:click={() => (cur ? dispatch('close') : dispatch('pick', { id: e.id }))}>
            <span class="no">{e.indexNumber ?? ''}</span>
            {#if cur}
              <span class="th">{#if e.image}<img src={img(e.id, 320)} alt="" loading="lazy" />{/if}{#if pct(e)}<i style="width:{pct(e)}%"></i>{/if}</span>
            {/if}
            <span class="tx">
              <b>{e.name}</b>
              {#if cur}<small class="now">{$t('player.episodes.playing')}{e.runtimeTicks ? ' · ' + mins(e.runtimeTicks) : ''}</small>{#if e.overview}<small class="ov">{e.overview}</small>{/if}{:else if e.runtimeTicks}<small>{mins(e.runtimeTicks)}</small>{/if}
            </span>
            {#if !cur && pct(e)}<span class="bar" aria-hidden="true"><i style="width:{pct(e)}%"></i></span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .eps { width: min(560px, 94vw); max-height: min(70vh, 640px); display: flex; flex-direction: column; background: rgba(16,20,24,.98); border: 1px solid #323a43; border-radius: 6px; box-shadow: 0 12px 30px #000; overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .7rem .8rem .5rem 1rem; border-bottom: 1px solid #252c34; }
  header b { font-size: 1.15rem; }
  .sel select { font-size: 1.05rem; font-weight: 700; background: #20262d; color: #fff; border: 1px solid #4a5560; border-radius: 4px; min-height: 44px; padding: 0 .8rem; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .icx { background: transparent; padding: 0; width: 44px; min-height: 44px; color: var(--mut); border-radius: 50%; }
  .icx:hover:not(:disabled) { background: rgba(255,255,255,.12); color: #fff; }
  ul { list-style: none; margin: 0; padding: .3rem; overflow-y: auto; overscroll-behavior: contain; }
  .ep { display: flex; align-items: center; gap: .8rem; width: 100%; min-height: 52px; padding: .55rem .7rem; background: transparent; color: #d2d2d2; border-radius: 4px; text-align: left; font-weight: 400; justify-content: flex-start; position: relative; }
  .ep:hover:not(:disabled), .ep:focus-visible { background: rgba(255,255,255,.1); color: #fff; }
  .ep.cur { background: #242b33; color: #fff; align-items: flex-start; border: 1px solid #46505a; }
  .no { flex: none; min-width: 1.6rem; font-size: 1.05rem; font-weight: 700; color: var(--mut); text-align: center; }
  .cur .no { color: #fff; padding-top: .2rem; }
  .th { position: relative; flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 4px; overflow: hidden; background: #2b333c; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .th i, .bar i { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--acc); }
  .tx { display: grid; gap: .2rem; min-width: 0; flex: 1; }
  .tx b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cur .tx b { white-space: normal; }
  small { color: var(--mut); font-size: .8rem; }
  .now { color: #fff; }
  .ov { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
  .bar { position: absolute; left: 3rem; right: .7rem; bottom: .3rem; height: 3px; background: rgba(255,255,255,.2); border-radius: 2px; overflow: hidden; }
  .bar i { bottom: 0; top: 0; height: auto; }
  .pad { padding: 1rem; margin: 0; }
  @media (max-width: 560px) { .th { width: 96px; } }
</style>
