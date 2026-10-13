<script lang="ts">
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { goto } from '$app/navigation';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { activeChips, applyDraft, browseQuery, draftOf, filterCount, parseBrowse, type FilterDraft } from '#lib/discovery';
  import { dialogKeys } from '#lib/actions';
  import { onDestroy, tick } from 'svelte';
  import { langLabel } from '#lib/langs';
  import LazyRow from '#lib/LazyRow.svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  let items: Item[] | null = null, total = 0, start = 0, genres: string[] = [], langs: { audio: Array<{ code: string }>; subs: Array<{ code: string }> } = { audio: [], subs: [] }, busy = false, failed = false, seq = 0, lastKey = '';
  let personName: Record<string, string> = {};
  const PAGE = 60;
  const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];

  $: kind = $page.params.kind === 'series' ? 'Series' : 'Movie';
  $: s = parseBrowse($page.url.searchParams);
  // Block 17: quality filter chips 4K / HDR (?quality=4k,hdr), answered from the quality index (GET /api/library/quality)
  const QUALITIES = ['4k', 'hdr'] as const;
  $: qlist = QUALITIES.filter((q) => ($page.url.searchParams.get('quality') ?? '').split(',').includes(q));
  $: qparam = qlist.join(',');
  const qLabel = (q: string) => (q === '4k' ? $t('fresh.q.4k') : $t('fresh.q.hdr'));
  function toggleQuality(q: (typeof QUALITIES)[number]) { set('quality', (qlist.includes(q) ? qlist.filter((x) => x !== q) : [...qlist, q]).join(',')); }
  $: key = kind + '?' + browseQuery(s, kind, 0, PAGE).toString() + '|' + qparam;
  // rows per genre while nothing is filtered (or the grid when the viewer prefers it); filters always show the grid
  const VIEW_KEY = 'ff_browse_view';
  let view: 'rows' | 'grid' = 'rows';
  try { if (typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'grid') view = 'grid'; } catch { /* storage blocked */ }
  function setView(v: 'rows' | 'grid') { view = v; try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage blocked */ } }
  $: plain = !activeChips(s).length && !s.person && s.sort === 'SortName' && !qlist.length;
  $: showGrid = view === 'grid' || !plain;
  $: if (showGrid && key !== lastKey) { lastKey = key; void load(true); }
  $: if (!showGrid) lastKey = '';
  $: rowsQ = (extra: Record<string, string>) => () => api(`/api/library/items?${new URLSearchParams({ types: kind, limit: '24', ...extra })}`).then((r) => r.items as Item[]);
  $: decades = s.decade !== null && !DECADES.includes(s.decade) ? [...DECADES, s.decade].sort((a, b) => b - a) : DECADES;
  $: chips = [...activeChips(s, { person: s.person ? personName[s.person] : undefined }), ...qlist.map((q) => ({ key: `quality:${q}`, label: qLabel(q) }))];
  const dropChip = (k: string) => (k.startsWith('quality:') ? toggleQuality(k.slice(8) as (typeof QUALITIES)[number]) : set(k, ''));
  $: if (s.person && personName[s.person] === undefined) void fetchPerson(s.person);

  async function load(reset: boolean) {
    const my = reset ? ++seq : seq; // a newer query invalidates everything still in flight
    busy = true; failed = false;
    if (reset) { start = 0; items = null; total = 0; }
    try {
      const qp = browseQuery(s, kind, start, PAGE);
      if (qparam) qp.set('quality', qparam);
      const r = await api(`${qparam ? '/api/library/quality' : '/api/library/items'}?${qp}`);
      if (my !== seq) return;
      items = [...(reset ? [] : items ?? []), ...r.items]; total = r.total; start += PAGE;
    } catch {
      if (my !== seq) return;
      failed = true; items = items ?? [];
    }
    if (my === seq) busy = false;
  }
  async function fetchPerson(id: string) {
    personName[id] = ''; // mark as requested (falls back to "Person")
    try { personName[id] = (await api(`/api/people/${id}`)).person?.name ?? ''; } catch { /* keep fallback */ }
    personName = personName;
  }
  $: if (!genres.length) api('/api/library/genres').then((r) => (genres = r.genres)).catch(() => undefined);

  $: if (!langs.audio.length && !langs.subs.length) api('/api/library/languages').then((r) => (langs = { audio: r.audio ?? [], subs: r.subs ?? [] })).catch(() => undefined);
  $: audioCodes = withCurrent(langs.audio.map((l) => l.code), s.audio);
  $: subCodes = withCurrent(langs.subs.map((l) => l.code), s.subs);
  const withCurrent = (codes: string[], cur: string | null) => (cur && !codes.includes(cur) ? [...codes, cur] : codes);

  function set(k: string, value: string) {
    const u = new URL($page.url.href);
    if (value) u.searchParams.set(k, value); else u.searchParams.delete(k);
    if (k === 'year') u.searchParams.delete('decade');
    if (k === 'decade') u.searchParams.delete('year');
    goto(u, { reset: false });
  }
  const reset = () => goto($page.url.pathname, { reset: false });

  // ---- phones: the row of selects becomes one "Filter" button + bottom sheet (same pattern as the "Mehr" sheet in +layout) ----
  let fsheet = false, draft: FilterDraft = { genre: '', decade: '', minRating: '', sort: 'SortName', filter: '', audio: '', subs: '' }, fbtn: HTMLButtonElement, dragY = 0, dragging = false, dragStart = 0;
  $: fcount = filterCount(s) + qlist.length;
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  $: if (typeof document !== 'undefined') document.documentElement.style.overflow = fsheet ? 'hidden' : ''; // no page scroll behind the sheet
  onDestroy(() => { if (typeof document !== 'undefined') document.documentElement.style.overflow = ''; });
  function openFilters() { draft = draftOf(s); dragY = 0; fsheet = true; }
  async function closeFilters(refocus = true) { fsheet = false; dragY = 0; dragging = false; if (refocus) { await tick(); fbtn?.focus(); } }
  async function applyFilters() { await goto(applyDraft(new URL($page.url.href), draft), { reset: false }); void closeFilters(); }
  async function resetFilters() { await reset(); void closeFilters(); }
  // swipe down on the grab zone closes the sheet (threshold 80 px)
  function dragDown(e: PointerEvent) { dragging = true; dragStart = e.clientY; dragY = 0; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
  function dragMove(e: PointerEvent) { if (dragging) dragY = Math.max(0, e.clientY - dragStart); }
  function dragEnd() { if (!dragging) return; const far = dragY > 80; dragging = false; dragY = 0; if (far) void closeFilters(); }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: kind === 'Series' ? $t('common.series') : $t('common.movies') })}</title></svelte:head>
<div class="head">
  <h1>{kind === 'Series' ? $t('common.series') : $t('common.movies')}{#if s.studio}{' · '}{s.studio}{/if}</h1>
  <label class="sr-only" for="g">{$t('home.browse.genre')}</label>
  <select id="g" class="genres" value={s.genre} on:change={(e) => set('genre', e.currentTarget.value)}><option value="">{$t('home.browse.genres')}</option>{#each genres as g}<option>{g}</option>{/each}{#if s.genre && !genres.includes(s.genre)}<option>{s.genre}</option>{/if}</select>
  <div class="views" role="group" aria-label={$t('home.browse.view')}>
    <button type="button" class="vbtn" aria-pressed={!showGrid} disabled={!plain} title={plain ? $t('home.browse.rows') : $t('home.browse.rowsOnlyPlain')} aria-label={$t('home.browse.rows')} on:click={() => setView('rows')}><Icon name="menu" size={20} /></button>
    <button type="button" class="vbtn" aria-pressed={showGrid} title={$t('home.browse.grid')} aria-label={$t('home.browse.grid')} on:click={() => setView('grid')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></svg></button>
  </div>
</div>
<div class="flex filters">
  <button type="button" class="fbtn" bind:this={fbtn} aria-haspopup="dialog" aria-expanded={fsheet} on:click={openFilters}>{$t('home.browse.filter')}{#if fcount}<span class="cnt" aria-hidden="true">{fcount}</span><span class="sr-only"> {$t('home.browse.activeCount', { n: fcount })}</span>{/if}</button>
  <span class="qgrp" role="group" aria-label={$t('fresh.browse.quality')}>
    {#each QUALITIES as q (q)}<button type="button" class="chip quick" aria-pressed={qlist.includes(q)} on:click={() => toggleQuality(q)}>{qLabel(q)}</button>{/each}
  </span>
  {#if audioCodes.includes('deu')}
    <button type="button" class="chip quick" aria-pressed={s.audio === 'deu'} on:click={() => set('audio', s.audio === 'deu' ? '' : 'deu')}>{$t('home.browse.germanAudio')}</button>
  {/if}
</div>
{#if fsheet}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" use:portal on:click={() => closeFilters()}></div>
  <div class="sheet" class:dragging use:portal role="dialog" aria-modal="true" aria-label={$t('home.browse.filter')} use:dialogKeys={{ close: closeFilters, focusFirst: true }} style={dragY ? `transform:translateY(${dragY}px)` : undefined}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="grab" on:pointerdown={dragDown} on:pointermove={dragMove} on:pointerup={dragEnd} on:pointercancel={dragEnd}>
      <span class="handle" aria-hidden="true"></span>
      <h2 class="sht">{$t('home.browse.filter')}</h2>
    </div>
    <form on:submit|preventDefault={applyFilters}>
      <label class="fl"><span>{$t('home.browse.genre')}</span><select bind:value={draft.genre}><option value="">{$t('home.browse.allGenres')}</option>{#each genres as g}<option value={g}>{g}</option>{/each}{#if draft.genre && !genres.includes(draft.genre)}<option value={draft.genre}>{draft.genre}</option>{/if}</select></label>
      <label class="fl"><span>{$t('home.browse.decade')}</span><select bind:value={draft.decade}><option value="">{$t('home.browse.allDecades')}</option>{#each decades as d}<option value={String(d)}>{$t('home.browse.decadeLabel', { d: String(d) })}</option>{/each}</select></label>
      <label class="fl"><span>{$t('home.browse.rating')}</span><select bind:value={draft.minRating}><option value="">{$t('home.browse.allRatings')}</option>{#each [6, 7, 8] as n}<option value={String(n)}>{$t('home.browse.minRating', { n })}</option>{/each}</select></label>
      <label class="fl"><span>{$t('home.sort.label')}</span><select bind:value={draft.sort}><option value="SortName">{$t('home.sort.name')}</option><option value="DateCreated">{$t('home.sort.added')}</option><option value="PremiereDate">{$t('home.sort.premiere')}</option><option value="CommunityRating">{$t('home.sort.rating')}</option></select></label>
      <label class="fl"><span>{$t('home.status.label')}</span><select bind:value={draft.filter}><option value="">{$t('home.status.all')}</option><option value="unplayed">{$t('home.status.unplayed')}</option><option value="played">{$t('home.status.played')}</option><option value="favorites">{$t('home.status.favorites')}</option></select></label>
      {#if audioCodes.length}<label class="fl"><span>{$t('home.browse.audio')}</span><select bind:value={draft.audio}><option value="">{$t('home.browse.all')}</option>{#each audioCodes as c}<option value={c}>{langLabel(c)}</option>{/each}</select></label>{/if}
      {#if subCodes.length}<label class="fl"><span>{$t('home.browse.subtitles')}</span><select bind:value={draft.subs}><option value="">{$t('home.browse.all')}</option>{#each subCodes as c}<option value={c}>{langLabel(c)}</option>{/each}</select></label>{/if}
      <div class="sacts"><button type="submit">{$t('home.browse.apply')}</button><button type="button" class="sec" on:click={resetFilters}>{$t('home.browse.reset')}</button></div>
    </form>
  </div>
{/if}
{#if chips.length}
  <ul class="flex chips" aria-label={$t('home.browse.activeFilters')}>
    {#each chips as c (c.key)}<li><button type="button" class="chip" aria-label={$t('home.browse.removeFilter', { label: c.label })} on:click={() => dropChip(c.key)}>{c.label}<span aria-hidden="true"> ✕</span></button></li>{/each}
    <li><button type="button" class="sec" on:click={reset}>{$t('home.browse.resetAll')}</button></li>
  </ul>
{/if}
{#if !showGrid}
  <div class="rowsv">
    <LazyRow title={$t('home.browse.newRow')} cacheKey="browse:{kind}:new" load={rowsQ({ sort: 'DateCreated', desc: 'true' })} />
    <LazyRow title={$t('home.browse.popularRow')} cacheKey="browse:{kind}:top" load={rowsQ({ sort: 'CommunityRating', desc: 'true' })} />
    {#each genres.slice(0, 12) as g (g)}
      <LazyRow title={g} href="?genre={encodeURIComponent(g)}" cacheKey="browse:{kind}:g:{g}" load={rowsQ({ genre: g, sort: 'Random' })} />
    {/each}
  </div>
{:else}
<div class="tiles" aria-busy={items === null}>
  {#if items === null}{#each Array(18) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}
  {:else}{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}{/if}
</div>
{#if failed}
  <div class="state" role="alert"><p class="err">{$t('home.browse.loadFailed')}</p><button type="button" on:click={() => load(!items?.length)}>{$t('home.browse.retry')}</button></div>
{:else if items && !items.length}
  <div class="state"><p class="muted">{$t('home.browse.empty')}</p>{#if chips.length || s.sort !== 'SortName'}<button type="button" class="sec" on:click={reset}>{$t('home.browse.resetFilters')}</button>{/if}</div>
{/if}
{#if items && items.length < total && !failed}<p style="text-align:center"><button class="sec" disabled={busy} on:click={() => load(false)}>{$t('home.browse.loadMore')}</button></p>{/if}
{/if}

<style>
  .head { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem 1.4rem; margin-bottom: .9rem; } .head h1 { margin: 0; }
  .genres { min-height: 38px; padding: .2rem 2.2rem .2rem .8rem; background-color: #000; border: 1px solid rgba(255,255,255,.85); border-radius: 2px; font-weight: 600; font-size: .95rem; cursor: pointer; }
  .genres:hover { background-color: rgba(255,255,255,.1); }
  .views { margin-left: auto; display: inline-flex; border: 1px solid rgba(255,255,255,.6); border-radius: 2px; }
  .vbtn { min-height: 38px; width: 44px; padding: 0; border-radius: 0; background: transparent; color: #fff; }
  .vbtn[aria-pressed='true'] { background: rgba(255,255,255,.18); }
  .vbtn:hover:not(:disabled) { background: rgba(255,255,255,.12); }
  .filters { margin-bottom: 1rem; }
  .rowsv { margin: 0 calc(var(--pad-x) * -1); padding-bottom: 4rem; }
  .rowsv :global(.row:first-child) { margin-top: .4rem; }
  .tiles { row-gap: .5rem; }
  .fbtn { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; padding: 0 1.1rem; border-radius: 99px; background: var(--surface-2); font-weight: 600; }
  .cnt { display: inline-grid; place-items: center; min-width: 1.4rem; height: 1.4rem; padding: 0 .3rem; border-radius: 99px; background: #fff; color: #000; font-size: .78rem; font-weight: 800; }
  .sheet { display: flex; }
  @media (max-width: 720px) { .genres, .views { display: none; } }
  .quick[aria-pressed='true'] { background: #fff; color: #000; }
  .qgrp { display: inline-flex; gap: .5rem; }
  .chips { list-style: none; padding: 0; margin: 0 0 1.2rem; }
  .chip { background: var(--surface-2); border-radius: 99px; padding: 0 1rem; font-weight: 500; }
  .chip:hover:not(:disabled) { background: #323a43; }
  .state { text-align: center; padding: 1rem 0 3rem; }
  .backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.6); animation: fade .2s ease-out; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 71; flex-direction: column; max-height: 85vh; max-height: 85dvh; overflow-y: auto; overscroll-behavior: contain; background: #0d1115; border-top: 1px solid #2b333c; border-radius: 16px 16px 0 0; padding: 0 1rem calc(1rem + var(--safe-bottom)); animation: rise .26s var(--ease, ease-out); }
  .sheet.dragging { transition: none; }
  .grab { touch-action: none; cursor: grab; position: sticky; top: 0; background: #0d1115; z-index: 1; padding: 0 0 .4rem; margin: 0 -1rem; }
  .handle { display: block; width: 40px; height: 4px; border-radius: 99px; background: #4a5560; margin: 10px auto 8px; }
  .sht { margin: 0 1rem; font-size: 1.1rem; }
  .sheet form { display: grid; gap: .9rem; margin-top: .6rem; }
  .fl { display: grid; gap: .3rem; color: var(--mut); font-size: .82rem; font-weight: 600; }
  .fl select { width: 100%; min-height: 48px; color: var(--fg); font-size: 1rem; font-weight: 400; }
  .sheet form { gap: .7rem; }
  .sacts { display: flex; gap: .6rem; position: sticky; bottom: calc(-1rem - var(--safe-bottom)); margin: .2rem -1rem calc(-1rem - var(--safe-bottom)); padding: .7rem 1rem calc(1rem + var(--safe-bottom)); background: #0d1115; border-top: 1px solid #20262d; }
  .sacts button { flex: 1; min-height: 48px; }
  @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sheet, .backdrop { animation: none; } }
  /* desktop: the same filter panel as a drawer on the right */
  @media (min-width: 721px) {
    .sheet { left: auto; top: 0; width: min(400px, 92vw); max-height: none; border-radius: 0; border-top: 0; border-left: 1px solid #2b333c; animation-name: slidein; }
    .grab { cursor: default; } .handle { visibility: hidden; height: 0; margin: 14px 0 0; }
  }
  @keyframes slidein { from { transform: translateX(100%); } to { transform: none; } }
  @media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }
</style>
