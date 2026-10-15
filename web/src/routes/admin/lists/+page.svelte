<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Admin → Listen: which member lists are shown on everybody's home page (at most 5). Server paging + search. */
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { Column, Query } from '#lib/ui/table';

  interface AdminList { id: string; name: string; owner: { id: string; name: string }; itemCount: number; featured: boolean }
  const PAGE = 25;
  let rows: AdminList[] | null = null, total = 0, featuredCount = 0, max = 5, error: string | null = null;
  let page = 0, q = '';
  let seq = 0;

  async function load(offset = page * PAGE) {
    const my = ++seq;
    error = null;
    try {
      const r = await api<{ lists: AdminList[]; total: number; featuredCount: number; max: number }>(`/api/admin/lists?${new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(q.trim() ? { q: q.trim() } : {}) })}`);
      if (my !== seq) return;
      rows = r.lists; total = r.total; featuredCount = r.featuredCount; max = r.max;
    } catch (e) { if (my !== seq) return; rows = []; total = 0; error = errorText(e); }
  }
  const onQuery = (e: CustomEvent<Query>) => { q = e.detail.q; page = Math.floor(e.detail.offset / PAGE); void load(e.detail.offset); };
  onMount(() => load(0));

  const put = (l: AdminList, featured: boolean) => api(`/api/admin/lists/${l.id}/featured`, { method: 'PUT', body: { featured } });
  function toggle(l: AdminList, next: boolean) {
    const set = (v: boolean) => { l.featured = v; featuredCount += v ? 1 : -1; rows = rows; };
    void runAction({
      key: `list:${l.id}`,
      apply: () => { const prev = l.featured; set(next); return () => { l.featured = prev; featuredCount += prev ? 1 : -1; rows = rows; }; },
      run: () => put(l, next),
      success: next ? tr('admin.lists.shown', { name: l.name }) : tr('admin.lists.hidden', { name: l.name }),
      undo: { run: () => put(l, !next) },
      error: (e) => e instanceof ApiError && e.status === 409 ? tr('admin.lists.tooMany', { max })
        : e instanceof ApiError && e.status === 404 ? tr('admin.lists.gone') : errorText(e),
    }).then((res) => { if (!res.ok && res.error instanceof ApiError && res.error.status === 404) void load(); });
  }

  $: columns = [
    { key: 'name', label: $t('adminContent.lists.name'), value: (l) => l.name, primary: true, sortable: false },
    { key: 'owner', label: $t('adminContent.lists.owner'), value: (l) => l.owner.name, sortable: false },
    { key: 'items', label: $t('adminContent.lists.items'), value: (l) => l.itemCount, sortable: false, align: 'end' },
    { key: 'featured', label: $t('admin.lists.feature'), value: (l) => l.featured, sortable: false, filter: false, align: 'end' },
  ] as Column<AdminList>[];
</script>

<p class="intro muted">{$t('admin.lists.intro', { max, count: featuredCount })}</p>
<div class="slots"><Progress value={featuredCount} max={max} tone={featuredCount >= max ? 'warn' : 'acc'} label={$t('adminContent.lists.slots', { count: featuredCount, max })} /></div>

<DataTable
  caption={$t('admin.tabs.lists')} {rows} {columns} key={(l) => l.id} {error} pageSize={PAGE} bind:page bind:q {total}
  filterable filterPlaceholder={$t('adminContent.lists.search')} emptyText={$t('admin.lists.empty')} busyKey={(l) => `list:${l.id}`}
  on:query={onQuery} on:retry={() => load(0)}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      <a class="nm" href="/lists/{row.id}">{row.name}</a>
    {:else if col.key === 'items'}
      {fmtNumber(row.itemCount)}
    {:else if col.key === 'featured'}
      <Toggle hideLabel label={$t('adminContent.lists.featureName', { name: row.name })} checked={row.featured} pending={$busyKeys.has(`list:${row.id}`)}
        on:change={(e) => toggle(row, e.detail)} />
    {:else}{col.value?.(row) ?? ''}{/if}
  </svelte:fragment>
</DataTable>

<style>
  .intro { margin: 0 0 .8rem; max-width: 70ch; }
  .slots { max-width: 24rem; margin-bottom: 1rem; }
  .nm { color: var(--fg); text-decoration: underline; text-decoration-color: rgba(255,255,255,.3); text-underline-offset: 3px; }
  .nm:hover { text-decoration-color: currentColor; }
</style>
