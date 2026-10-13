<script lang="ts">
  import { img, type Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import Icon from '#lib/Icon.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import { seasonLabel } from '#lib/detail/format';
  import EpisodeComments from '#lib/detail/EpisodeComments.svelte';
  import { kidsMode } from '#lib/kids';
  import { playPrefetch } from '#lib/player/prefetch';

  /** series id (for the per-episode download buttons) */
  export let seriesId: string;
  export let seasons: Item[];
  /** selected season id (two-way) */
  export let season = '';
  /** null = loading */
  export let episodes: Item[] | null;
  /** next-up episode: highlighted */
  export let next: Item | null = null;
  /** query string (audio/sub choice) appended to the player links */
  export let qs = '';

  let revealed = new Set<string>();
  const reveal = (e: MouseEvent, id: string) => { e.preventDefault(); e.stopPropagation(); revealed = new Set([...revealed, id]); };
  const hidden = (e: Item, r: Set<string>) => isSpoiler(e, $prefs) && !r.has(e.id);
  // friends-only comments per episode (expand); kids profiles never see them
  let openComments = new Set<string>(), counts: Record<string, number> = {};
  const toggleComments = (id: string) => { const n = new Set(openComments); if (n.has(id)) n.delete(id); else n.add(id); openComments = n; };
  $: current = (e: Item) => (next ? next.id === e.id : false);
</script>

<section class="eps" aria-labelledby="eps-h">
  <div class="seasonbar">
    <h2 id="eps-h">{$t('detail.episodes.title')}</h2>
    {#if seasons.length}
      <span class="sel">
        <label class="sr-only" for="dv-season">{$t('detail.episodes.season')}</label>
        <select id="dv-season" bind:value={season}>{#each seasons as s (s.id)}<option value={s.id}>{seasonLabel(s)}</option>{/each}</select>
        <span class="chev" aria-hidden="true"><Icon name="chevron-down" size={16} /></span>
      </span>
    {/if}
  </div>
  <ol>
    {#if episodes === null}
      {#each Array(4) as _}<li><div class="skeleton sk"></div></li>{/each}
    {:else if !episodes.length}
      <li class="muted none">{$t('detail.episodes.none')}</li>
    {:else}
      {#each episodes as e (e.id)}
        {@const pct = e.positionTicks && e.runtimeTicks ? Math.min(100, (e.positionTicks / e.runtimeTicks) * 100) : 0}
        <li class="eprow" class:cur={current(e)}>
          <div class="epmain">
          <a class="ep" href="/watch/{e.id}{qs ? '?' + qs : ''}" aria-current={current(e) ? 'true' : undefined} data-play-scope use:playPrefetch>
            <span class="n" aria-hidden="true">{e.indexNumber ?? ''}</span>
            <span class="th" data-play-art>
              {#if e.image}<img class:spoil={hidden(e, revealed)} loading="lazy" src={img(e.id, 320)} alt="" />{/if}
              {#if pct}<span class="bar"><i style="width:{pct}%"></i></span>{/if}
              <span class="pl"><Icon name="play" size={22} /></span>
            </span>
            <span class="tx">
              <span class="t"><b>{#if e.indexNumber !== undefined}<span class="sr-only">{$t('detail.episodes.episodeN', { n: e.indexNumber })}</span>{/if}{e.name}</b><span class="muted dur">{e.runtimeTicks ? $t('common.duration.m', { m: Math.round(e.runtimeTicks / 600_000_000) }) : ''}</span></span>
              {#if hidden(e, revealed)}<span class="muted ov">{$t('detail.episodes.spoiler')} · <button type="button" class="lnk" on:click={(ev) => reveal(ev, e.id)}>{$t('detail.episodes.reveal')}</button></span>
              {:else}<span class="muted ov">{e.overview ?? ''}</span>{/if}
            </span>
            {#if e.played}<span class="seen"><Icon name="check" size={18} label={$t('detail.episodes.watched')} /></span>{/if}
          </a>
          <span class="epdl">
            {#if !$kidsMode}
              <button type="button" class="cmbtn" class:on={openComments.has(e.id)} aria-expanded={openComments.has(e.id)} aria-controls="cm-panel-{e.id}"
                aria-label={openComments.has(e.id) ? $t('anime.comments.hide') : $t('anime.comments.show')} title={openComments.has(e.id) ? $t('anime.comments.hide') : $t('anime.comments.show')}
                on:click={() => toggleComments(e.id)}><Icon name="message" size={18} />{#if counts[e.id]}<span class="n2">{counts[e.id]}</span>{/if}</button>
            {/if}
            <DownloadButton itemId={e.id} {seriesId} compact />
          </span>
          </div>
          {#if openComments.has(e.id) && !$kidsMode}
            <div id="cm-panel-{e.id}"><EpisodeComments itemId={e.id} onCount={(n) => (counts = { ...counts, [e.id]: n })} /></div>
          {/if}
        </li>
      {/each}
    {/if}
  </ol>
</section>

<style>
  .eps { margin-top: 2.2rem; }
  .seasonbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .6rem; }
  h2 { margin: 0; font-size: 1.4rem; }
  .sel { position: relative; display: inline-block; }
  select { appearance: none; -webkit-appearance: none; background: #1f262c; border: 1px solid #3c4650; padding-right: 2.2rem; font-weight: 600; cursor: pointer; }
  select:hover { border-color: #fff; }
  .chev { position: absolute; right: .7rem; top: 50%; transform: translateY(-50%); pointer-events: none; }
  ol { list-style: none; padding: 0; margin: 0; }
  .sk { height: 90px; margin: .5rem 0; }
  .none { padding: 1rem .8rem; }
  .epmain { position: relative; }
  .eprow { position: relative; border-bottom: 1px solid var(--line); }
  .eprow:last-child { border-bottom: 0; }
  .eprow.cur { background: rgba(255, 255, 255, .06); box-shadow: inset 3px 0 0 var(--acc); border-radius: 4px; }
  .ep { display: grid; grid-template-columns: 2.6rem 160px 1fr auto; gap: 1rem; align-items: center; padding: 1rem .8rem; border-radius: 4px; transition: background var(--t-fast); }
  .ep:hover { background: #242b33; }
  .n { font-size: 1.6rem; color: var(--mut); text-align: center; font-weight: 300; }
  .th { position: relative; aspect-ratio: 16 / 9; background: #1c2228; border-radius: 4px; overflow: hidden; display: block; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .th img.spoil { filter: blur(14px); transform: scale(1.1); }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255, 255, 255, .3); }
  .bar i { display: block; height: 100%; background: var(--acc); }
  .pl { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; background: rgba(0, 0, 0, .45); transition: opacity var(--t-fast); }
  .ep:hover .pl, .ep:focus-visible .pl { opacity: 1; }
  .tx { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .t { display: flex; justify-content: space-between; gap: 1rem; }
  .dur { white-space: nowrap; }
  .ov { font-size: .88rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .lnk { background: none; border: 0; padding: 0; min-height: 0; color: var(--fg); text-decoration: underline; cursor: pointer; font: inherit; font-weight: 400; display: inline; }
  .lnk:hover:not(:disabled) { background: none; }
  .seen { color: var(--ok); }
  .epdl { position: absolute; right: .8rem; bottom: .8rem; display: flex; align-items: center; gap: .4rem; }
  /* the row's bottom margin makes room when the comments panel is closed: the buttons sit over the row's padding */
  .cmbtn { display: inline-flex; align-items: center; gap: .25rem; min-height: 0; padding: .3rem .5rem; border-radius: 999px; background: rgba(255, 255, 255, .1); border: 0; color: var(--fg); cursor: pointer; font-size: .8rem; }
  .cmbtn:hover, .cmbtn.on { background: rgba(255, 255, 255, .22); }
  .n2 { font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) {
    .ep { grid-template-columns: 110px 1fr; padding: .8rem .5rem; gap: .7rem; }
    .n, .seen { display: none; }
    .epdl { right: .4rem; bottom: .4rem; }
  }
</style>
