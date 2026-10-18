<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, getActiveProfile, type Item } from '#lib/api';
  import BrandHubs from '#lib/BrandHubs.svelte';
  import Hero from '#lib/Hero.svelte';
  import LazyRow from '#lib/LazyRow.svelte';
  import Row from '#lib/Row.svelte';
  import ThemedListRows from '#lib/ThemedListRows.svelte';
  import UpcomingRow from '#lib/UpcomingRow.svelte';
  import { failedParts, firstNonEmptyTab, homeCache, swrLoad, type HomePart, type HomeResponse } from '#lib/home';
  import type { Hub } from '#lib/hubs';
  import { loadFeatured, loadThemed, type FeaturedList, type ThemedList } from '#lib/lists';
  import { t, tr } from '#lib/i18n';

  let hero: Item | null = null, heroPlay = '';
  let resume: Item[] | null = null, next: Item[] | null = null, latest: Item[] | null = null, mine: Item[] | null = null;
  let trending: Item[] | null = null, recs: Item[] | null = null, friendsRated: Item[] | null = null;
  let top: Item[] | null = null, because: { name: string } | null = null, becauseItems: Item[] | null = null;
  let moreRaw: Array<{ because: { id: string; name: string }; items: Item[]; engine?: 'v1' | 'v2' }> = [];
  // engine v2: which engine built the "because" row, and the row ranker's order of the recommendation rows (null = the fixed layout)
  let becauseEngine: 'v1' | 'v2' = 'v1', homeOrder: string[] | null = null;
  let featured: FeaturedList[] = [];
  let hubs: Hub[] = [], themed: ThemedList[] = [];
  // titles an admin set a removal date for (only those the viewer can see; the row stays hidden while empty)
  let leaving: Item[] | null = null;
  let views: Item[] = [], genres: string[] = [], error = '';
  const q = (p: Record<string, string>) => new URLSearchParams(p).toString();
  // Jellyfin can answer 5xx/network errors right after a fresh sign-up: retry (not on 401/403) before giving up
  const retry = async <T,>(fn: () => Promise<T>, tries = 3, delayMs = 1500, giveUp: (e: unknown) => boolean = (e) => e instanceof ApiError && (e.status === 401 || e.status === 403)): Promise<T> => {
    for (let i = 1; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (i >= tries || giveUp(e)) throw e;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  };
  const load = (path: string) => retry(() => api(path));
  const items = (p: Record<string, string>) => load(`/api/library/items?${q(p)}`).then((r) => r.items as Item[]);
  /**
   * Cached per profile (module scope in #lib/home): back to home renders at once from memory. Personal rows
   * (Weiterschauen, Nächste Folge, Merkliste) always revalidate in the background, the catalogue rows after 5 minutes.
   */
  const cached = <T,>(key: string, fetcher: () => Promise<T>, apply: (v: T) => void, onError: () => void, ttl?: number) =>
    swrLoad(homeCache, `${getActiveProfile()}|${key}`, fetcher, apply, ttl, onError).catch(() => undefined); // onError only when nothing cached was shown
  const ALWAYS = 0;
  const idle = (fn: () => void) => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 900 }); else setTimeout(fn, 300);
  };

  // (GET /api/home: a 4xx is final, e.g. a server without the endpoint: straight to the old loaders)
  // The old per-row loaders: the fallback for every part GET /api/home could not deliver (named in `failed`, or the whole call failed).
  const loaders: Record<HomePart, () => void> = {
    // billboard: a random pick stays the same while it is cached
    hero: () => void cached('hero', async () => { const pool = await items({ types: 'Movie,Series', sort: 'Random', limit: '15' }); return pool.find((i) => i.backdrop) ?? pool[0] ?? null; }, (v) => (hero = v), () => (hero = null)),
    resume: () => void cached('resume', () => load('/api/library/resume').then((r) => r.items as Item[]), (v) => (resume = v), () => (resume = []), ALWAYS),
    nextup: () => void cached('nextup', () => load('/api/library/nextup').then((r) => r.items as Item[]), (v) => (next = v), () => (next = []), ALWAYS),
    leaving: () => void cached('leaving', () => load('/api/library/leaving').then((r) => r.items as Item[]), (v) => (leaving = v), () => (leaving = []), ALWAYS),
    recs: () => {
      void cached('recs', () => load('/api/recommendations').then((r) => r.items as Item[]), (v) => (recs = v), () => (recs = []));
      void cached('friends', () => load('/api/library/friends-rated').then((r) => r.items as Item[]), (v) => (friendsRated = v), () => (friendsRated = []));
    },
    because: () => {
      void cached('because', () => load('/api/library/because'), (r: { because: { name: string } | null; items: Item[]; engine?: 'v1' | 'v2' }) => { because = r.because; becauseItems = r.items; becauseEngine = r.engine ?? 'v1'; homeOrder = null; }, () => (becauseItems = []));
      // more "Because you watched" rows (2-3 further recent titles); they only appear in between the other rows below the fold
      void cached('becauseMore', () => load('/api/library/because-more').then((r) => r.rows as typeof moreRaw), (v) => (moreRaw = v), () => (moreRaw = []));
    },
    hubs: () => void cached('hubs', () => api('/api/hubs').then((r) => ((r.hubs as Hub[] | undefined) ?? [])), (v) => (hubs = v), () => (hubs = [])),
    themed: () => void cached('themed', loadThemed, (v) => (themed = v), () => (themed = [])),
  };
  const HOME_KEY = () => `${getActiveProfile()}|home`;
  function applyHome(r: HomeResponse<Item>) {
    const bad = failedParts(r);
    const p = r.parts;
    if (!bad.has('hero')) hero = p.hero ? (p.hero as Item) : null;
    if (!bad.has('resume')) resume = p.resume;
    if (!bad.has('nextup')) next = p.nextup;
    if (!bad.has('leaving')) leaving = p.leaving;
    if (!bad.has('recs')) { recs = p.recs.items; friendsRated = p.recs.friends; }
    if (!bad.has('because')) { because = p.because.because; becauseItems = p.because.items; moreRaw = p.because.more; becauseEngine = p.because.engine ?? 'v1'; homeOrder = Array.isArray(p.order) ? p.order : null; }
    if (!bad.has('hubs')) hubs = p.hubs as Hub[];
    if (!bad.has('themed')) themed = p.themed as ThemedList[];
    for (const n of bad) loaders[n]();
  }

  onMount(() => {
    // 1. the whole first screen (billboard, rows, hubs, themed lists) in ONE request; stale data from the last visit shows at once.
    //    Parts the server could not build are loaded the old way, one request each.
    const firstScreen = swrLoad(homeCache, HOME_KEY(), () => retry(() => api('/api/home') as Promise<HomeResponse<Item>>, 2, 800, (e) => e instanceof ApiError && e.status >= 400 && e.status < 500), applyHome, ALWAYS, () => { for (const n of Object.keys(loaders) as HomePart[]) loaders[n](); })
      .catch(() => undefined);
    // 3. below the fold: once the browser is idle (keeps the network free for the billboard image);
    //    from the cache at once (back navigation: same page height, so the scroll position restores exactly)
    const warm = Boolean(homeCache.get(`${getActiveProfile()}|latest`));
    // (after the first screen, so the idle requests never compete with it)
    void (warm ? Promise.resolve() : firstScreen).then(() => (warm ? (fn: () => void) => fn() : idle)(() => {
      void cached('latest', () => items({ types: 'Movie,Series', sort: 'DateCreated', desc: 'true', limit: '24' }), (v) => (latest = v), () => (latest = []));
      void cached('trending', () => load('/api/library/trending').then((r) => (r.items as Item[]).map((i) => ({ ...i, caption: i.viewers ? tr('home.meta.watching', { n: i.viewers }) : i.caption }))), (v) => (trending = v), () => (trending = []));
      void cached('top', () => items({ types: 'Movie,Series', sort: 'CommunityRating', desc: 'true', limit: '10' }), (v) => (top = v), () => (top = []));
      void cached('mine', () => load('/api/watchlist').then((r) => r.items as Item[]), (v) => (mine = v), () => (mine = []), ALWAYS);
      void cached('featured', () => loadFeatured(), (v) => (featured = v), () => (featured = []));
      void cached('views', () => load('/api/library/views').then((r) => r.items as Item[]), (v) => (views = v), () => (error = tr('home.rows.libraryFailed')));
      void cached('genres', () => load('/api/library/genres').then((r) => (r.genres as string[]).slice(0, 8)), (v) => (genres = v), () => undefined);
    }));
  });
  async function removeResume(id: string) {
    const prev = resume;
    resume = resume ? resume.filter((i) => i.id !== id) : resume; // optimistic
    try {
      await api(`/api/library/resume/${id}`, { method: 'DELETE' });
      homeCache.set(`${getActiveProfile()}|resume`, resume);
      const h = homeCache.get(HOME_KEY())?.value as HomeResponse<Item> | undefined;
      if (h) homeCache.set(HOME_KEY(), { ...h, parts: { ...h.parts, resume: resume ?? [] } });
    } catch { resume = prev; }
  }
  $: heroRank = hero && top ? top.findIndex((i) => i.id === hero!.id) + 1 : 0;
  // Jellyfin's next-up also lists the episode you are in the middle of: that one is already under "Weiterschauen"
  $: nextOnly = next && resume ? next.filter((e) => !resume!.some((r) => r.id === e.id)) : next;
  // the extra rows never repeat what "Weiterschauen" / "Nächste Folge" / the first "Weil du ..." row already show (episodes count as their series)
  $: taken = new Set([...(resume ?? []), ...(next ?? []), ...(becauseItems ?? [])].flatMap((i) => [i.id, i.seriesId ?? i.id]));
  $: more = moreRaw.map((r) => ({ ...r, items: r.items.filter((i) => !taken.has(i.id)) })).filter((r) => r.items.length >= 4);
  // engine v2: the recommendation rows in the order the server chose (friends, because, more:<n>); a row without titles is skipped by <Row>
  type OrderedRow = { key: string; title: string; items: Item[]; tag: { row: 'friends' | 'because' | 'because_more'; engine: 'v1' | 'v2' } };
  $: ordered = (homeOrder ?? []).flatMap((key): OrderedRow[] => {
    if (key === 'friends') return [{ key, title: $t('home.rows.friendsRated'), items: friendsRated ?? [], tag: { row: 'friends', engine: becauseEngine } }];
    if (key === 'because') return because ? [{ key, title: $t('home.rows.because', { name: because.name }), items: becauseItems ?? [], tag: { row: 'because', engine: becauseEngine } }] : [];
    const m = /^more:(\d+)$/.exec(key) ? moreRaw[Number(key.slice(5))] : undefined;
    const left = m ? m.items.filter((i) => !taken.has(i.id)) : [];
    // the same floor as the v1 path: a "more" row that shrinks below 4 titles after removing what the first rows show is skipped
    return m && left.length >= 4 ? [{ key, title: $t('together.because', { name: m.because.name }), items: left, tag: { row: 'because_more', engine: m.engine ?? becauseEngine } }] : [];
  });
  // the first visible row loads its images eagerly with high priority
  $: firstRow = firstNonEmptyTab(['resume', 'next', 'recs', 'friends'] as const, { resume, next: nextOnly, recs, friends: friendsRated });
  const viewLoader = (id: string) => () => items({ parentId: id, sort: 'DateCreated', desc: 'true', limit: '24' });
  const genreLoader = (g: string) => () => items({ types: 'Movie,Series', genre: g, sort: 'Random', limit: '24' });
</script>

<svelte:head><title>{$t('common.appName')}</title></svelte:head>
<Hero item={hero} rank={heroRank} portrait />
<BrandHubs {hubs} />
<div class="rows">
  {#if error}<p class="err" style="margin:1rem var(--pad-x)">{error}</p>{/if}
  <Row title={$t('home.rows.resume')} items={resume} landscape removable priority={firstRow === 'resume'} on:remove={(e) => removeResume(e.detail.id)} />
  <Row title={$t('home.rows.nextUp')} items={nextOnly} landscape priority={firstRow === 'next'} />
  <!-- featured themed lists (worker S1) follow the second row -->
  <ThemedListRows lists={themed} />
  {#if leaving?.length}<Row title={$t('fresh.row.leaving')} items={leaving} />{/if}
  <Row title={$t('home.rows.recs')} items={recs} priority={firstRow === 'recs'} />
  {#if homeOrder}
    {#each ordered as r (r.key)}<Row title={r.title} items={r.items} reco={r.tag} />{/each}
    <Row title={$t('home.rows.latest')} items={latest} href="/new" />
    <Row title={$t('home.rows.trending')} items={trending} ranked />
    {#each featured as f (f.id)}<Row title={$t('home.rows.featured', { name: f.name, owner: f.owner.name })} items={f.items} href="/lists/{f.id}" />{/each}
    <Row title={$t('home.rows.myList')} items={mine} href="/watchlist" />
  {:else}
  <Row title={$t('home.rows.friendsRated')} items={friendsRated} priority={firstRow === 'friends'} />
  {#if because}<Row title={$t('home.rows.because', { name: because.name })} items={becauseItems} reco={{ row: 'because', engine: becauseEngine }} />{/if}
  <Row title={$t('home.rows.latest')} items={latest} href="/new" />
  <Row title={$t('home.rows.trending')} items={trending} ranked />
  {#if more[0]}<Row title={$t('together.because', { name: more[0].because.name })} items={more[0].items} reco={{ row: 'because_more', engine: more[0].engine ?? becauseEngine }} />{/if}
  {#each featured as f (f.id)}<Row title={$t('home.rows.featured', { name: f.name, owner: f.owner.name })} items={f.items} href="/lists/{f.id}" />{/each}
  <Row title={$t('home.rows.myList')} items={mine} href="/watchlist" />
  {#if more[1]}<Row title={$t('together.because', { name: more[1].because.name })} items={more[1].items} reco={{ row: 'because_more', engine: more[1].engine ?? becauseEngine }} />{/if}
  {/if}
  <UpcomingRow type="movie" title={$t('home.rows.upcomingWish')} />
  <!-- the second ranked row never directly follows the first one -->
  {#each views as v, i (v.id)}
    <LazyRow title={v.name} href="/library/{v.id}" cacheKey="view:{v.id}" load={viewLoader(v.id)} />
    {#if i === 0}<Row title={$t('home.rows.top10')} items={top} ranked />{/if}
  {/each}
  {#if !views.length}<Row title={$t('home.rows.top10')} items={top} ranked />{/if}
  {#each genres as g, i (g)}
    <LazyRow title={g} href="/browse/movies?genre={encodeURIComponent(g)}" cacheKey="genre:{g}" load={genreLoader(g)} />
    {#if i === 0 && !homeOrder && more[2]}<Row title={$t('together.because', { name: more[2].because.name })} items={more[2].items} reco={{ row: 'because_more', engine: more[2].engine ?? becauseEngine }} />{/if}
  {/each}
</div>

<style>.rows { position: relative; z-index: 2; padding-bottom: 5rem; }
  @media (max-width: 720px) { .rows { padding-top: .4rem; } }</style>
