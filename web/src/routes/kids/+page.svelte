<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<svelte:head><title>{$t('common.pageTitle', { page: $t('kids.home.pageTitle') })}</title></svelte:head>
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, type TKey } from '#lib/i18n';
  import KidsTile from './KidsTile.svelte';

  /**
   * Kids home: big rounded tiles, no billboard (nothing starts playing on its own), no social rows.
   * What a kids profile may see is decided by Jellyfin (parental cap of the profile's Jellyfin user), not by this page.
   */
  interface KRow { key: string; title: TKey; url: string; play?: boolean }
  const ROWS: KRow[] = [
    { key: 'resume', title: 'kids.home.resume', url: '/api/library/resume', play: true },
    { key: 'fav', title: 'kids.home.favorites', url: '/api/library/items?types=Movie,Series&filter=favorites&sort=SortName&limit=30' },
    { key: 'anim', title: 'kids.home.animation', url: '/api/library/items?types=Movie,Series&genre=Animation&sort=Random&limit=30' },
    { key: 'movies', title: 'kids.home.movies', url: '/api/library/items?types=Movie&sort=DateCreated&desc=true&limit=30' },
    { key: 'series', title: 'kids.home.series', url: '/api/library/items?types=Series&sort=DateCreated&desc=true&limit=30' },
  ];
  let rows: Record<string, Item[] | null> = {};
  let failed = false, name = '';

  async function load() {
    failed = false;
    rows = {};
    const res = await Promise.allSettled(ROWS.map((r) => api<{ items: Item[] }>(r.url)));
    rows = Object.fromEntries(ROWS.map((r, i) => [r.key, res[i]!.status === 'fulfilled' ? ((res[i] as PromiseFulfilledResult<{ items: Item[] }>).value.items ?? []).slice(0, 30) : []]));
    failed = res.every((r) => r.status === 'rejected');
  }
  onMount(() => {
    void load();
    void api<Me>('/api/me').then((m) => (name = m.profile?.name ?? '')).catch(() => undefined);
  });
  $: loaded = ROWS.every((r) => rows[r.key] !== undefined);
  $: empty = loaded && !failed && ROWS.every((r) => !rows[r.key]?.length);
</script>

<div class="kids-page">
  <div class="hello">
    <div>
      {#if name}<p class="hi">{$t('kids.home.hello', { name })}</p>{/if}
      <h1>{$t('kids.home.title')}</h1>
    </div>
    <a class="bigsearch" href="/kids/search" data-autofocus><Icon name="search" size={28} /><span>{$t('kids.nav.search')}</span></a>
  </div>

  {#if failed}
    <p class="note" role="alert">{$t('kids.home.loadFailed')} <button type="button" class="again" on:click={load}>{$t('kids.home.retry')}</button></p>
  {:else if empty}
    <p class="note">{$t('kids.home.empty')}</p>
  {/if}

  {#each ROWS as r (r.key)}
    {#if rows[r.key] === undefined}
      <section class="krow" aria-busy="true"><h2 class="skel-h"><span class="sr-only">{$t(r.title)}</span></h2><div class="track">{#each [0, 1, 2, 3, 4] as i (i)}<span class="skel"></span>{/each}</div></section>
    {:else if rows[r.key]?.length}
      <section class="krow" aria-labelledby="kr-{r.key}">
        <h2 id="kr-{r.key}">{$t(r.title)}</h2>
        <div class="track" data-nav>
          {#each rows[r.key] ?? [] as item (item.id)}<KidsTile {item} play={r.play} />{/each}
        </div>
      </section>
    {/if}
  {/each}
</div>

<style>
  .kids-page { --k-ink: #20233a; --k-card: #fff; --k-focus: #ffb703; --k-accent: #ff5d8f; min-height: 100vh; min-height: 100dvh; padding: calc(var(--nav-total) + 1.2rem) 0 3rem; color: var(--k-ink);
    background: radial-gradient(circle at 12% 8%, #fff6c9 0, transparent 38%), radial-gradient(circle at 92% 18%, #ffd6e8 0, transparent 34%), linear-gradient(180deg, #bfe9ff 0%, #e8f7ff 55%, #fffaf0 100%); }
  .hello { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: 0 var(--pad-x); margin-bottom: 1.2rem; }
  .hi { margin: 0; font-size: 1.2rem; font-weight: 700; color: #3c4a8f; }
  h1 { margin: .1rem 0 0; font-size: clamp(1.7rem, 4.5vw, 2.8rem); font-weight: 900; letter-spacing: -.01em; }
  .bigsearch { display: inline-flex; align-items: center; gap: .6rem; min-height: 56px; padding: 0 1.5rem; border-radius: 99px; background: #fff; color: var(--k-ink); font-size: 1.15rem; font-weight: 800; box-shadow: 0 6px 16px rgba(32, 35, 58, .15); }
  .bigsearch:hover, .bigsearch:focus-visible { box-shadow: 0 0 0 5px var(--k-focus), 0 6px 16px rgba(32, 35, 58, .15); outline: none; }
  .krow { margin: 0 0 1.6rem; }
  h2 { margin: 0 0 .7rem; padding: 0 var(--pad-x); font-size: clamp(1.3rem, 3vw, 1.75rem); font-weight: 900; }
  .track { display: flex; gap: clamp(.8rem, 2vw, 1.3rem); overflow-x: auto; scroll-snap-type: x proximity; scroll-padding: 0 var(--pad-x); padding: .5rem var(--pad-x) .9rem; scrollbar-width: none; }
  .track::-webkit-scrollbar { display: none; }
  .skel-h { width: 10rem; height: 1.6rem; margin-left: var(--pad-x); border-radius: 99px; background: rgba(255, 255, 255, .7); }
  .skel { flex: none; width: clamp(132px, 38vw, 210px); aspect-ratio: 2 / 3; border-radius: 24px; background: rgba(255, 255, 255, .7); }
  .note { margin: 2rem var(--pad-x); font-size: 1.2rem; font-weight: 700; }
  .again { margin-left: .6rem; border-radius: 99px; background: var(--k-ink); color: #fff; min-height: 48px; padding: 0 1.2rem; }
  @media (max-width: 720px) { .kids-page { padding-top: calc(var(--nav-total) + .6rem); } .bigsearch { width: 100%; justify-content: center; } }
</style>
