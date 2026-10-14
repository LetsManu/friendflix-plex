<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { fmtClock } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { chapterIndexAt, chapterLabel, thumbTime, trickFrame, type Chapter, type Trickplay } from './chapters';

  /** Player "Szenen" panel: the chapters with a still (the server's chapter image, else a trickplay frame); a click jumps there. */
  export let chapters: Chapter[];
  export let current: number;
  export let duration: number;
  export let trickplay: Trickplay | null | undefined = undefined;
  const dispatch = createEventDispatcher<{ seek: { time: number }; close: void }>();

  const W = 160;
  /** chapter stills that failed to load (gateway / server without them): fall back to the trickplay frame */
  let broken = new Set<number>(), list: HTMLUListElement, root: HTMLDivElement;
  $: playing = chapterIndexAt(chapters, current);
  onMount(() => {
    void tick().then(() => {
      const cur = list?.querySelector<HTMLElement>('[aria-current="true"]');
      cur?.scrollIntoView({ block: 'nearest' });
      if (!root?.contains(document.activeElement)) (cur ?? list?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    });
  });
</script>

<div class="scn" role="dialog" aria-label={$t('scenes.chapters.title')} data-nav data-scope bind:this={root}>
  <header>
    <b>{$t('scenes.chapters.title')}</b><span class="muted">{$t('scenes.chapters.count', { n: chapters.length })}</span>
    <button type="button" class="icx" aria-label={$t('scenes.chapters.close')} on:click={() => dispatch('close')}><Icon name="x" size={20} /></button>
  </header>
  <ul bind:this={list}>
    {#each chapters as c, i (c.start)}
      {@const fr = trickFrame(trickplay, thumbTime(chapters, i, duration), W)}
      {@const name = chapterLabel(c, i)}
      <li>
        <button type="button" class="ch" class:cur={i === playing} aria-current={i === playing ? 'true' : undefined} aria-label={$t('scenes.chapters.jump', { name, t: fmtClock(c.start) })} on:click={() => dispatch('seek', { time: c.start })}>
          <span class="th" aria-hidden="true">
            {#if c.image && !broken.has(i)}<img src={c.image} alt="" loading="lazy" on:error={() => (broken = new Set(broken).add(i))} />
            {:else if fr}<span class="fr" style="width:{fr.sw}px;height:{fr.sh}px;background-image:url({fr.url});background-size:{fr.bw}px {fr.bh}px;background-position:-{fr.x}px -{fr.y}px;transform:scale({fr.k})"></span>
            {:else}<Icon name="film" size={24} />{/if}
            <i>{fmtClock(c.start)}</i>
          </span>
          <span class="tx"><b>{name}</b>{#if i === playing}<small>{$t('scenes.chapters.current')}</small>{/if}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .scn { width: min(600px, 94vw); max-height: min(70vh, 640px); display: flex; flex-direction: column; background: rgba(16,20,24,.98); border: 1px solid #323a43; border-radius: 6px; box-shadow: 0 12px 30px #000; overflow: hidden; }
  header { display: flex; align-items: center; gap: .6rem; padding: .6rem .6rem .5rem 1rem; border-bottom: 1px solid #252c34; }
  header b { font-size: 1.15rem; } header .muted { flex: 1; font-size: .85rem; }
  .icx { background: transparent; padding: 0; width: 44px; min-height: 44px; color: var(--mut); border-radius: 50%; }
  .icx:hover:not(:disabled) { background: rgba(255,255,255,.12); color: #fff; }
  ul { list-style: none; margin: 0; padding: .5rem; overflow-y: auto; overscroll-behavior: contain; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: .5rem; }
  .ch { display: grid; gap: .35rem; width: 100%; padding: .35rem; background: transparent; color: #d2d2d2; border-radius: 6px; text-align: left; justify-items: stretch; font-weight: 400; border: 2px solid transparent; }
  .ch:hover:not(:disabled), .ch:focus-visible { background: rgba(255,255,255,.1); color: #fff; }
  .ch.cur { border-color: var(--acc); color: #fff; }
  .th { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; overflow: hidden; background: #242b33; color: var(--mut); }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fr { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .th i { position: absolute; right: .3rem; bottom: .3rem; font-style: normal; font-size: .75rem; background: rgba(0,0,0,.75); padding: 0 .3rem; border-radius: 3px; color: #fff; font-variant-numeric: tabular-nums; }
  .tx { display: grid; min-width: 0; line-height: 1.25; } .tx b { font-weight: 600; font-size: .9rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tx small { color: var(--acc); font-size: .78rem; font-weight: 600; }
  @media (max-width: 560px) { ul { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
