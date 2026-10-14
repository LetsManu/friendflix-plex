<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { goto } from '$app/navigation';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { parseBrowse } from '#lib/discovery';
  import { t } from '#lib/i18n';

  let items: Item[] | null = null, total = 0, start = 0, busy = false, failed = false, seq = 0, lastKey = '', qInput = '', lastQ = '*', names: Record<string, string> = {};
  const PAGE = 60;

  $: id = $page.params.id ?? '';
  $: sp = $page.url.searchParams;
  $: q = (sp.get('q') ?? '').trim();
  $: sort = parseBrowse(sp).sort;
  $: filter = parseBrowse(sp).filter;
  $: if (q !== lastQ) { lastQ = q; qInput = q; } // URL is the source of truth (also for back/forward)
  $: key = [id, sort, filter, q].join('|');
  $: if (id && key !== lastKey) { lastKey = key; void load(true); }
  $: name = names[id] ?? '';
  $: if (id && names[id] === undefined) void loadName(id);

  async function loadName(lib: string) {
    names[lib] = '';
    try { names[lib] = ((await api('/api/library/views')).items as Item[]).find((v) => v.id === lib)?.name ?? ''; } catch { /* generic title */ }
    names = names;
  }

  async function load(reset: boolean) {
    const my = reset ? ++seq : seq;
    busy = true; failed = false;
    if (reset) { start = 0; items = null; total = 0; }
    const p = new URLSearchParams({ parentId: id, sort, limit: String(PAGE), start: String(start) });
    if (sort === 'DateCreated' || sort === 'CommunityRating' || sort === 'PremiereDate') p.set('desc', 'true');
    if (filter) p.set('filter', filter);
    if (q) p.set('q', q);
    try {
      const r = await api(`/api/library/items?${p}`);
      if (my !== seq) return;
      items = [...(reset ? [] : items ?? []), ...r.items]; total = r.total; start += PAGE;
    } catch {
      if (my !== seq) return;
      failed = true; items = items ?? [];
    }
    if (my === seq) busy = false;
  }

  function set(k: string, value: string) {
    const u = new URL($page.url.href);
    if (value) u.searchParams.set(k, value); else u.searchParams.delete(k);
    goto(u, { replace: true, reset: false });
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: name || $t('home.library.title') })}</title></svelte:head>
<h1>{name || $t('home.library.title')}</h1>
<form class="flex bar" role="search" on:submit|preventDefault={() => set('q', qInput.trim())}>
  <input type="search" aria-label={$t('home.library.search')} placeholder={$t('home.library.search')} bind:value={qInput} on:change={() => set('q', qInput.trim())} />
  <select aria-label={$t('home.sort.label')} value={sort} on:change={(e) => set('sort', e.currentTarget.value === 'SortName' ? '' : e.currentTarget.value)}><option value="SortName">{$t('home.sort.name')}</option><option value="DateCreated">{$t('home.sort.added')}</option><option value="PremiereDate">{$t('home.sort.premiere')}</option><option value="CommunityRating">{$t('home.sort.rating')}</option></select>
  <select aria-label={$t('home.browse.filter')} value={filter} on:change={(e) => set('filter', e.currentTarget.value)}><option value="">{$t('home.status.all')}</option><option value="unplayed">{$t('home.status.unplayed')}</option><option value="played">{$t('home.status.played')}</option><option value="favorites">{$t('home.status.favorites')}</option></select>
</form>
<div class="tiles" aria-busy={items === null}>
  {#if items === null}{#each Array(12) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}{:else}{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}{/if}
</div>
{#if failed}
  <div class="state" role="alert"><p class="err">{$t('home.browse.loadFailed')}</p><button type="button" on:click={() => load(!items?.length)}>{$t('home.browse.retry')}</button></div>
{:else if items && !items.length}
  <p class="muted state">{q || filter ? $t('home.library.emptySearch') : $t('home.library.empty')}</p>
{/if}
{#if items && items.length < total && !failed}<p style="text-align:center"><button class="sec" disabled={busy} on:click={() => load(false)}>{$t('home.browse.loadMore')}</button></p>{/if}

<style>
  .bar { margin-bottom: 1.2rem; }
  .tiles { row-gap: .5rem; }
  .bar input { flex: 1; min-width: 200px; max-width: 420px; }
  .state { text-align: center; padding: 1rem 0 3rem; }
</style>
