<script lang="ts">
  /** Admin → Wünsche: Seerr requests, server-side paging + status filter, approve / decline (decline with Undo). */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '#lib/api';
  import { fmtDateTime, fmtRelative, t, tr, type TKey } from '#lib/i18n';
  import { bumpPending, refreshSummary } from '#lib/admin/summary';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import type { Column, Query } from '#lib/ui/table';

  type StateKey = 'pending' | 'approved' | 'processing' | 'available' | 'partial' | 'declined' | 'unknown';
  interface Req { id: number; title: string; mediaType: string; requestedBy: string; statusKey: StateKey; createdAt?: string }
  const FILTERS = ['pending', 'approved', 'processing', 'available', 'all'] as const;
  type Filter = (typeof FILTERS)[number];
  const TONE: Record<StateKey, Tone> = { pending: 'warn', approved: 'info', processing: 'info', available: 'ok', partial: 'info', declined: 'muted', unknown: 'muted' };
  const ICON: Record<StateKey, string> = { pending: 'clock', approved: 'check', processing: 'download', available: 'check', partial: 'download', declined: 'x', unknown: 'info' };
  const PAGE = 25;

  let filter: Filter = 'pending';
  let rows: Req[] | null = null, total = 0, error: string | null = null, page = 0;
  let seq = 0;

  async function load(offset = page * PAGE) {
    const my = ++seq;
    error = null;
    try {
      const r = await api<{ requests: Req[]; total: number }>(`/api/admin/requests?${new URLSearchParams({ filter, take: String(PAGE), skip: String(offset) })}`);
      if (my !== seq) return;
      rows = r.requests; total = r.total;
      // a page that emptied (last rows handled) steps back instead of showing "nothing"
      if (!rows.length && offset > 0) { page = Math.max(0, Math.ceil(total / PAGE) - 1); void load(); }
    } catch (e) {
      if (my !== seq) return;
      rows = []; total = 0;
      error = e instanceof ApiError && e.status === 502 ? tr('adminContent.requests.unreachable') : errorText(e);
    }
  }
  const onQuery = (e: CustomEvent<Query>) => { page = Math.floor(e.detail.offset / PAGE); void load(e.detail.offset); };
  function setFilter(f: string) {
    filter = (FILTERS as readonly string[]).includes(f) ? (f as Filter) : 'pending';
    page = 0; rows = null;
    void goto(filter === 'pending' ? '?' : `?status=${filter}`, { replace: true, reset: false });
    void load(0);
  }
  onMount(() => {
    const f = new URLSearchParams(location.search).get('status');
    if (f && (FILTERS as readonly string[]).includes(f)) filter = f as Filter;
    void load(0);
  });

  /** optimistic: the row leaves a "pending" list, else it just changes state; the rollback restores both */
  function mark(r: Req, to: StateKey) {
    return () => {
      const prevRows = rows, prevTotal = total, prevKey = r.statusKey;
      if (filter === 'pending') { rows = (rows ?? []).filter((x) => x !== r); total = Math.max(0, total - 1); } else { r.statusKey = to; rows = rows; }
      bumpPending('requests', -1);
      return () => { r.statusKey = prevKey; rows = prevRows; total = prevTotal; bumpPending('requests', 1); };
    };
  }
  function approve(r: Req) {
    // Seerr has no "un-approve": no Undo, the result is visible right away
    void runAction({
      key: `req:${r.id}`, apply: mark(r, 'approved'),
      run: () => api(`/api/admin/requests/${r.id}/approve`, { method: 'POST' }),
      success: tr('adminContent.requests.approved', { title: r.title }),
    }).then((res) => { if (res.ok) void refreshSummary(); });
  }
  function decline(r: Req) {
    // one-way in Seerr, but cheap to postpone: delay-commit with Undo instead of a dialog
    void runAction({
      key: `req:${r.id}`, defer: true, apply: mark(r, 'declined'),
      run: () => api(`/api/admin/requests/${r.id}/decline`, { method: 'POST' }),
      success: tr('adminContent.requests.declined', { title: r.title }),
    }).then((res) => { if (res.ok) void refreshSummary(); });
  }

  $: columns = [
    { key: 'title', label: $t('admin.requests.title'), value: (r) => r.title, primary: true },
    { key: 'by', label: $t('admin.requests.from'), value: (r) => r.requestedBy, sortable: false },
    { key: 'type', label: $t('admin.requests.type'), value: (r) => (r.mediaType === 'tv' ? $t('admin.kind.series') : $t('admin.kind.movie')), sortable: false },
    { key: 'status', label: $t('admin.requests.status'), value: (r) => r.statusKey, sortable: false },
    { key: 'when', label: $t('adminContent.requests.when'), value: (r) => r.createdAt ?? '', sortable: false },
    { key: 'act', label: $t('ui.table.actions'), sortable: false, filter: false, align: 'end' },
  ] as Column<Req>[];
  $: options = FILTERS.map((f) => ({ value: f, label: $t(`admin.requests.filter.${f}` as TKey) }));
</script>

<DataTable
  caption={$t('admin.tabs.requests')} {rows} {columns} key={(r) => String(r.id)} {error} pageSize={PAGE} bind:page total={rows === null ? null : total}
  skeletonRows={6} emptyText={$t(`adminContent.requests.empty.${filter}` as TKey)} busyKey={(r) => `req:${r.id}`}
  on:query={onQuery} on:retry={() => load(0)}>
  <svelte:fragment slot="toolbar">
    <div class="flt"><Select label={$t('admin.requests.status')} value={filter} {options} on:change={(e) => setFilter((e.currentTarget as HTMLSelectElement).value)} /></div>
  </svelte:fragment>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'status'}
      <StatusPill tone={TONE[row.statusKey]} icon={ICON[row.statusKey]} label={$t(`adminContent.requests.state.${row.statusKey}` as TKey)} />
    {:else if col.key === 'when'}
      <time datetime={row.createdAt} title={row.createdAt ? fmtDateTime(row.createdAt) : undefined}>{row.createdAt ? fmtRelative(row.createdAt) : ''}</time>
    {:else if col.key === 'act'}
      {#if row.statusKey === 'pending'}
        <span class="acts">
          <Button size="sm" icon="check" pending={$busyKeys.has(`req:${row.id}`)} aria-label={$t('adminContent.requests.approveAria', { title: row.title })} on:click={() => approve(row)}>{$t('admin.approve')}</Button>
          <Button size="sm" variant="ghost" icon="x" disabled={$busyKeys.has(`req:${row.id}`)} aria-label={$t('adminContent.requests.declineAria', { title: row.title })} on:click={() => decline(row)}>{$t('admin.decline')}</Button>
        </span>
      {/if}
    {:else}{col.value?.(row) ?? ''}{/if}
  </svelte:fragment>
</DataTable>

<style>
  .flt { min-width: 12rem; }
  .acts { display: inline-flex; gap: .4rem; flex-wrap: wrap; justify-content: flex-end; }
  time { color: var(--mut); font-size: .9rem; white-space: nowrap; }
  :global(td.primary) { overflow-wrap: anywhere; }
</style>
