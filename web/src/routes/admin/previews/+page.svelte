<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Vorschauen: hover-preview clips of the library. Server paging / filter / sort; while clips are being built only
   * those rows are polled (`?ids=`) and only changed rows re-render. Retry (regenerate) and clear per row.
   */
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import { fmtNumber, t, tr, type TKey } from '#lib/i18n';
  import { poll } from '#lib/adminContent/poll';
  import { refreshSummary } from '#lib/admin/summary';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { fmtBytes } from '#lib/ui/format';
  import type { Column, Query, SortState } from '#lib/ui/table';

  type St = 'ok' | 'failed' | 'missing' | 'preparing';
  interface Row { itemId: string; name: string; type: string; status: St; bytes: number | null; audioLang: string | null; error: string | null }
  interface Sum { total: number; ok: number; failed: number; missing: number; preparing: number; totalBytes: number }
  const PAGE = 25;
  const TONE: Record<St, Tone> = { ok: 'ok', failed: 'err', missing: 'muted', preparing: 'warn' };
  const ICON: Record<St, string> = { ok: 'check', failed: 'alert', missing: 'x', preparing: 'clock' };

  let sum: Sum | null = null;
  let rows: Row[] | null = null, total = 0, error: string | null = null;
  let status: '' | St = '', q = '', page = 0;
  let sort: SortState | null = null;
  let seq = 0;

  const params = (offset: number): URLSearchParams => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (status) p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    if (sort) { p.set('sort', sort.key); p.set('dir', sort.dir); }
    return p;
  };
  async function load(offset = page * PAGE) {
    const my = ++seq;
    error = null;
    try {
      const r = await api<{ summary: Sum; items: Row[]; total: number }>(`/api/admin/previews?${params(offset)}`);
      if (my !== seq) return;
      sum = r.summary; rows = r.items; total = r.total;
    } catch (e) { if (my !== seq) return; rows = []; total = 0; error = errorText(e); }
  }
  const onQuery = (e: CustomEvent<Query>) => { q = e.detail.q; sort = e.detail.sort; page = Math.floor(e.detail.offset / PAGE); void load(e.detail.offset); };
  function setStatus(v: string) { status = v as '' | St; page = 0; rows = null; void load(0); }

  /** only the rows being built (+ the summary) are asked for; unchanged rows keep their object, so they do not re-render */
  const same = (a: Row, b: Row) => a.status === b.status && a.bytes === b.bytes && a.error === b.error && a.audioLang === b.audioLang;
  async function tickRows() {
    if (!rows || error || $busyKeys.has('prev:bulk')) return;
    const ids = rows.filter((r) => r.status === 'preparing').map((r) => r.itemId);
    if (!ids.length && !sum?.preparing) return;
    const my = seq;
    try {
      const r = await api<{ summary: Sum; items: Row[] }>(`/api/admin/previews?ids=${ids.join(',')}`);
      if (my !== seq || !rows) return;
      sum = r.summary;
      const fresh = new Map(r.items.map((x) => [x.itemId, x]));
      let changed = false;
      const next = rows.map((old) => { const n = fresh.get(old.itemId); if (n && !same(old, n)) { changed = true; return n; } return old; });
      if (changed) {
        rows = next;
        // a finished build changes what the status filter shows: reload when a row no longer matches
        if (status && next.some((x) => x.status !== status)) void load();
        void refreshSummary();
      }
    } catch { /* the next tick tries again */ }
  }
  let stop = () => {};
  onMount(() => { void load(0); stop = poll(tickRows, 4000); });
  onDestroy(() => stop());

  const mb = (b: number | null) => (b ? fmtBytes(b) : '');
  function retry(r: Row) {
    void runAction({
      key: `prev:${r.itemId}`,
      apply: () => { const prev = r.status, prevErr = r.error; r.status = 'preparing'; r.error = null; rows = rows; if (sum) { sum = { ...sum, preparing: sum.preparing + 1, failed: Math.max(0, sum.failed - (prev === 'failed' ? 1 : 0)) }; } return () => { r.status = prev; r.error = prevErr; rows = rows; void load(); }; },
      run: () => api('/api/admin/previews/regenerate', { method: 'POST', body: { itemId: r.itemId } }),
      success: tr('adminContent.previews.queued', { name: r.name }),
    });
  }
  function clear(r: Row) {
    void runAction({
      key: `prev:${r.itemId}`,
      apply: () => { const prevRows = rows, prevTotal = total; rows = (rows ?? []).filter((x) => x !== r); total = Math.max(0, total - 1); return () => { rows = prevRows; total = prevTotal; }; },
      run: () => api(`/api/admin/previews/${r.itemId}`, { method: 'DELETE' }),
      success: tr('adminContent.previews.cleared', { name: r.name }),
    }).then((res) => { if (res.ok) void load(); });
  }
  function retryFailed() {
    void runAction({
      key: 'prev:bulk',
      run: () => api<{ count: number }>('/api/admin/previews/regenerate-failed', { method: 'POST' }),
      success: (r) => tr('adminContent.previews.queuedMany', { n: r?.count ?? 0 }),
    }).then((res) => { if (res.ok) void load(); });
  }

  $: columns = [
    { key: 'name', label: $t('adminContent.previews.title'), value: (r) => r.name, primary: true },
    { key: 'type', label: $t('admin.requests.type'), value: (r) => (r.type === 'Series' ? $t('admin.kind.series') : $t('admin.kind.movie')), sortable: false },
    { key: 'status', label: $t('admin.requests.status'), value: (r) => r.status },
    { key: 'size', label: $t('admin.previews.size'), value: (r) => r.bytes ?? 0, align: 'end' },
    { key: 'audio', label: $t('adminContent.previews.audioLabel'), value: (r) => r.audioLang ?? '', sortable: false, hideOnCard: true },
  ] as Column<Row>[];
  $: options = [{ value: '', label: $t('admin.requests.filter.all') }, ...(['failed', 'preparing', 'missing', 'ok'] as const).map((s) => ({ value: s, label: $t(`admin.previews.state.${s}` as TKey) }))];
  $: pct = sum ? sum.ok : 0;
</script>

<p class="intro muted">{$t('admin.previews.intro')}</p>

<div class="stats">
  <StatTile icon="film" label={$t('admin.previews.titles')} value={sum ? fmtNumber(sum.total) : null} />
  <StatTile icon="check" label={$t('admin.previews.state.ok')} value={sum ? fmtNumber(sum.ok) : null} tone={sum && sum.ok === sum.total && sum.total ? 'ok' : 'default'} />
  <StatTile icon="alert" label={$t('admin.previews.state.failed')} value={sum ? fmtNumber(sum.failed) : null} tone={sum?.failed ? 'err' : 'default'} />
  <StatTile icon="clock" label={$t('admin.previews.state.preparing')} value={sum ? fmtNumber(sum.preparing) : null} tone={sum?.preparing ? 'warn' : 'default'} hint={sum ? `${$t('admin.previews.missing')}: ${fmtNumber(sum.missing)}` : ''} />
  <StatTile icon="hard-drive" label={$t('admin.previews.size')} value={sum ? fmtBytes(sum.totalBytes) : null} />
</div>
<div class="prog">
  <Progress value={sum ? pct : null} max={sum?.total || 1} label={sum ? $t('admin.previews.done', { ok: fmtNumber(sum.ok), total: fmtNumber(sum.total) }) : $t('ui.table.loading')} tone={sum && sum.failed ? 'warn' : 'ok'} />
</div>

<DataTable
  caption={$t('admin.tabs.previews')} {rows} {columns} key={(r) => r.itemId} {error} pageSize={PAGE} bind:page bind:q bind:sort {total}
  filterable filterPlaceholder={$t('adminContent.previews.search')} emptyText={$t('adminContent.previews.empty')} busyKey={(r) => `prev:${r.itemId}`}
  rowLabel={(r) => r.name} on:query={onQuery} on:retry={() => load(0)}
  actions={(r) => [
    { id: 'retry', label: $t('admin.previews.regen'), icon: 'refresh', disabled: r.status === 'preparing', run: () => retry(r) },
    ...(r.status === 'ok' ? [{ id: 'watch', label: $t('admin.previews.watch'), icon: 'play', href: `/api/items/${r.itemId}/preview.mp4` }] : []),
    ...(r.status === 'ok' || r.status === 'failed' ? [{ id: 'clear', label: $t('adminContent.previews.clear'), icon: 'x', danger: true, run: () => clear(r) }] : []),
  ]}>
  <svelte:fragment slot="toolbar">
    <div class="flt"><Select label={$t('admin.requests.status')} value={status} {options} on:change={(e) => setStatus((e.currentTarget as HTMLSelectElement).value)} /></div>
    <Button variant="secondary" icon="refresh" pending={$busyKeys.has('prev:bulk')} disabled={!sum?.failed} on:click={retryFailed}>{$t('admin.previews.regenFailed')}</Button>
  </svelte:fragment>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      <span class="nm">{row.name}</span>
      {#if row.error}<details class="err"><summary>{$t('adminContent.previews.errorDetails')}</summary><code>{row.error}</code></details>{/if}
    {:else if col.key === 'status'}
      <StatusPill tone={TONE[row.status]} icon={ICON[row.status]} label={$t(`admin.previews.state.${row.status}` as TKey)} />
    {:else if col.key === 'size'}{mb(row.bytes)}
    {:else if col.key === 'audio'}{row.audioLang ?? ''}
    {:else}{col.value?.(row) ?? ''}{/if}
  </svelte:fragment>
</DataTable>

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: .8rem; margin-bottom: 1rem; }
  .prog { margin-bottom: 1.2rem; max-width: 40rem; }
  .flt { min-width: 11rem; }
  .nm { overflow-wrap: anywhere; }
  details { margin-top: .3rem; font-weight: 400; font-size: .85rem; }
  summary { cursor: pointer; color: var(--mut); min-height: 28px; }
  code { display: block; margin-top: .3rem; padding: .4rem .6rem; background: rgba(255,255,255,.05); border-radius: 4px; word-break: break-all; font-size: .8rem; color: var(--err); white-space: pre-wrap; }
</style>
