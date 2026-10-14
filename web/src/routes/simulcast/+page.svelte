<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, img, type Item } from '#lib/api';
  import { fmtDate, fmtTime, t, tr } from '#lib/i18n';

  type Ep = { id: string; name: string; season?: number; index?: number; premiereDate: string };
  interface Entry { item: Item; anime: boolean; weekday: number; timed: boolean; airsAt: string; season: 'winter' | 'spring' | 'summer' | 'fall'; seasonYear: number; latest?: Ep; next?: Ep }
  interface Result { season: Entry['season']; year: number; total: number; days: Array<{ weekday: number; items: Entry[] }> }

  let data: Result | null = null, failed = false, animeOnly = false;
  try { animeOnly = localStorage.getItem('ff-simulcast-anime') === '1'; } catch { /* private mode */ }

  async function load() {
    failed = false;
    try { data = await api<Result>(`/api/simulcast?anime=${animeOnly ? 1 : 0}`); } catch { failed = true; }
  }
  onMount(load);
  function toggle() {
    try { localStorage.setItem('ff-simulcast-anime', animeOnly ? '1' : '0'); } catch { /* ignore */ }
    data = null; void load();
  }

  /** a date-only air time is the UTC weekday; with a time of day the viewer's local weekday applies */
  const dayOf = (e: Entry) => (e.timed ? new Date(e.airsAt).getDay() : e.weekday);
  /** Monday first */
  const ORDER = [1, 2, 3, 4, 5, 6, 0];
  $: groups = ORDER.map((w) => ({ weekday: w, items: (data?.days.flatMap((d) => d.items) ?? []).filter((e) => dayOf(e) === w).sort((a, b) => a.item.name.localeCompare(b.item.name)) })).filter((g) => g.items.length);
  const dayName = (w: number) => fmtDate(new Date(Date.UTC(2024, 0, 7 + w, 12)), { weekday: 'long', timeZone: 'UTC' });
  const today = new Date().getDay();
  const seasonText = (s: Entry['season'], year: number) =>
    s === 'winter' ? tr('anime.simulcast.season.winter', { year: String(year) }) : s === 'spring' ? tr('anime.simulcast.season.spring', { year: String(year) }) : s === 'summer' ? tr('anime.simulcast.season.summer', { year: String(year) }) : tr('anime.simulcast.season.fall', { year: String(year) });
  /** "Zuletzt: S1:E3 · Nächste: S1:E4 am Sa., 17.10. · um 18:30 Uhr" */
  const info = (e: Entry) => [
    e.latest && tr('anime.simulcast.latest', { ep: code(e.latest) }),
    e.next && tr('anime.simulcast.next', { ep: code(e.next), date: fmtDate(e.next.premiereDate, { weekday: 'short', day: '2-digit', month: '2-digit' }) }),
    e.timed && tr('anime.simulcast.airsAt', { time: fmtTime(e.airsAt) }),
  ].filter(Boolean).join(' · ');
  const code = (e: Ep) => (e.season !== undefined && e.index !== undefined ? tr('social.calendar.episodeCode', { s: e.season, e: e.index }) : e.name);
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('anime.simulcast.title') })}</title></svelte:head>
<div class="head">
  <h1>{$t('anime.simulcast.title')}{#if data && data.total} <span class="season">{seasonText(data.season, data.year)}</span>{/if}</h1>
  <label class="chk"><input type="checkbox" bind:checked={animeOnly} on:change={toggle} /> {$t('anime.simulcast.onlyAnime')}</label>
</div>
<p class="muted">{$t('anime.simulcast.intro')}</p>

{#if failed}
  <p class="warn" role="alert">{$t('anime.simulcast.loadFailed')}</p>
{:else if data === null}
  <div class="skeleton sk"></div><div class="skeleton sk"></div>
{:else if !groups.length}
  <p class="muted">{$t('anime.simulcast.none')}</p>
{:else}
  {#each groups as g (g.weekday)}
    <section class="day" class:today={g.weekday === today} aria-labelledby="d{g.weekday}">
      <h2 id="d{g.weekday}">{dayName(g.weekday)}{#if g.weekday === today} <span class="tag">{$t('anime.simulcast.today')}</span>{/if}</h2>
      <ul>
        {#each g.items as e (e.item.id)}
          <li>
            <a href="/item/{e.item.id}" class="row">
              <span class="th">{#if e.item.image}<img loading="lazy" src={img(e.item.id, 240)} alt="" />{/if}</span>
              <span class="tx">
                <b>{e.item.name}</b>
                <span class="muted">{info(e)}</span>
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

<style>
  .head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .season { font-size: 1rem; font-weight: 400; color: var(--mut); margin-left: .4rem; }
  .chk { display: inline-flex; align-items: center; gap: .5rem; cursor: pointer; }
  .sk { height: 5rem; margin: .6rem 0; }
  .day { margin-top: 1.6rem; }
  .day h2 { font-size: 1.2rem; margin: 0 0 .5rem; }
  .tag { font-size: .75rem; font-weight: 600; background: var(--acc-fill); color: #fff; border-radius: 999px; padding: .1rem .55rem; vertical-align: middle; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: .6rem; }
  .row { display: grid; grid-template-columns: 112px 1fr; gap: .8rem; align-items: center; padding: .5rem; border-radius: 6px; background: #1b2127; color: inherit; text-decoration: none; transition: background var(--t-fast); }
  .row:hover, .row:focus-visible { background: #242b33; }
  .th { aspect-ratio: 16 / 9; background: #1c2228; border-radius: 4px; overflow: hidden; display: block; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { display: flex; flex-direction: column; gap: .2rem; min-width: 0; font-size: .9rem; }
  .tx b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1rem; }
  @media (max-width: 640px) { ul { grid-template-columns: 1fr; } .row { grid-template-columns: 96px 1fr; } }
</style>
