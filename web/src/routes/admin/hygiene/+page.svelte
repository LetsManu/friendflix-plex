<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Bibliothekspflege (Block 22): titles that need care in the media server. Category tiles act as filters, issue /
   * type / search filters and sorting run on the server (paged), every issue can be ignored (Undo), info issues can ask the
   * media server to reload the metadata. FriendFlix only reports; nothing is changed in the files.
   */
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import { fmtNumber, fmtRelative, t, tr, type TKey } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { poll } from '#lib/adminContent/poll';
  import {
    CATEGORIES, categoryOf, codesOf, hygieneQuery, issueHint, issueLabel, rowTitle,
    type Category, type HygieneRow, type HygieneSort, type HygieneSummary, type IssueCode, type ItemType,
  } from '#lib/admin/hygiene';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { fmtBytes } from '#lib/ui/format';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import { toast } from '#lib/ui/toast';

  const PAGE = 50;
  const ICON: Record<Category, string> = { info: 'image', language: 'globe', duplicate: 'copy', file: 'film' };
  const SORTS: readonly string[] = ['name', 'issues', 'size', 'bitrate'];

  let sum: HygieneSummary | null = null, sumErr: string | null = null;
  let rows: HygieneRow[] | null = null, total = 0, error: string | null = null;
  let category: Category | '' = '', issue: IssueCode | '' = '', type: ItemType | '' = '', q = '', page = 0;
  let sort: SortState | null = null;
  let seq = 0;

  async function loadSum() {
    try { sum = await api<HygieneSummary>('/api/admin/hygiene/summary'); sumErr = null; } catch (e) { sumErr = errorText(e); }
  }
  async function load(offset = page * PAGE) {
    const my = ++seq;
    error = null;
    const s = sort && SORTS.includes(sort.key) ? sort : null;
    const p = hygieneQuery({ category, issue, type, q, sort: (s?.key ?? 'name') as HygieneSort, dir: s?.dir, offset, limit: PAGE });
    try {
      const r = await api<{ items: HygieneRow[]; total: number }>(`/api/admin/hygiene?${p}`);
      if (my !== seq) return;
      rows = r.items; total = r.total;
    } catch (e) { if (my !== seq) return; rows = []; total = 0; error = errorText(e); }
  }
  const reloadAll = () => { void loadSum(); void load(0); };
  const onQuery = (e: CustomEvent<Query>) => { q = e.detail.q; sort = e.detail.sort; page = Math.floor(e.detail.offset / PAGE); void load(e.detail.offset); };
  const restart = () => { page = 0; rows = null; void load(0); };
  function setCategory(c: Category) {
    category = category === c ? '' : c;
    if (issue && category && categoryOf(issue) !== category) issue = '';
    restart();
  }
  function setIssue(v: string) { issue = v as IssueCode | ''; if (issue) category = categoryOf(issue); restart(); }
  function setType(v: string) { type = v as ItemType | ''; restart(); }

  // a running scan: the summary is polled until it is done, then the list is reloaded
  let stop = () => {};
  let wasRunning = false;
  $: running = Boolean(sum?.state.running);
  $: if (wasRunning && !running) { wasRunning = false; void load(); }
  $: if (running) wasRunning = true;
  onMount(() => { reloadAll(); stop = poll(() => { if (running) void loadSum(); }, 10_000); });
  onDestroy(() => stop());

  function scan() {
    void runAction({
      key: 'hyg:scan',
      run: () => api<{ started: boolean }>('/api/admin/hygiene/scan', { method: 'POST' }),
      success: (r) => (r?.started ? tr('adminContent.hygiene.scanStarted') : tr('adminContent.hygiene.scanBusy')),
    }).then((res) => { if (res.ok && sum) sum = { ...sum, state: { ...sum.state, running: true } }; });
  }

  function ignore(r: HygieneRow, code: IssueCode) {
    const label = tr(issueLabel(code));
    void runAction({
      key: `hyg:${r.itemId}`,
      apply: () => {
        const prevRows = rows, prevTotal = total, prevSum = sum;
        const left = r.issues.filter((i) => i.code !== code);
        rows = left.length ? (rows ?? []).map((x) => (x === r ? { ...x, issues: left } : x)) : (rows ?? []).filter((x) => x !== r);
        if (!left.length) total = Math.max(0, total - 1);
        return () => { rows = prevRows; total = prevTotal; sum = prevSum; };
      },
      run: () => api('/api/admin/hygiene/ignore', { method: 'POST', body: { itemId: r.itemId, code } }),
      success: tr('adminContent.hygiene.ignored', { issue: label, name: rowTitle(r) }),
      undo: { run: async () => { await api('/api/admin/hygiene/ignore', { method: 'DELETE', body: { itemId: r.itemId, code } }); void loadSum(); } },
    }).then((res) => { if (res.ok) void loadSum(); });
  }
  function refresh(r: HygieneRow) {
    void runAction({
      key: `hyg:${r.itemId}`,
      run: () => api(`/api/admin/hygiene/${encodeURIComponent(r.itemId)}/refresh`, { method: 'POST' }),
      success: tr('adminContent.hygiene.refreshed', { name: rowTitle(r) }),
    });
  }
  const actions = (r: HygieneRow) => [
    ...r.issues.map((i) => ({ id: `ignore:${i.code}`, label: tr('adminContent.hygiene.ignore', { issue: tr(issueLabel(i.code)) }), icon: 'x', run: () => ignore(r, i.code) })),
    ...(sum?.canRefresh && r.issues.some((i) => categoryOf(i.code) === 'info') ? [{ id: 'refresh', label: tr('adminContent.hygiene.refresh'), icon: 'refresh', run: () => refresh(r) }] : []),
  ];

  const mbps = (b: number | null) => (b ? $t('adminContent.hygiene.mbps', { n: fmtNumber(b / 1e6, { maximumFractionDigits: 1 }) }) : '');
  $: columns = [
    { key: 'name', label: $t('adminContent.hygiene.col.title'), value: (r) => rowTitle(r), primary: true },
    { key: 'issues', label: $t('adminContent.hygiene.col.issues'), value: (r) => r.issues.length },
    { key: 'file', label: $t('adminContent.hygiene.col.file'), value: (r) => [r.container, r.video].filter(Boolean).join(' · '), sortable: false },
    { key: 'size', label: $t('adminContent.hygiene.col.size'), value: (r) => r.sizeBytes ?? 0, align: 'end' },
    { key: 'bitrate', label: $t('adminContent.hygiene.col.bitrate'), value: (r) => r.bitrate ?? 0, align: 'end', hideOnCard: true },
  ] as Column<HygieneRow>[];
  $: issueOptions = [{ value: '', label: $t('adminContent.hygiene.allIssues') }, ...codesOf(category).map((c) => ({ value: c, label: $t(issueLabel(c)) }))];
  $: typeOptions = [{ value: '', label: $t('adminContent.hygiene.allTypes') }, ...(['Movie', 'Series', 'Episode'] as const).map((x) => ({ value: x, label: $t(`adminContent.hygiene.types.${x}`) }))];
  $: supported = sum ? sum.state.supported : true;
  $: when = (iso: string | null, _l: unknown) => (iso ? fmtRelative(iso) : tr('adminContent.hygiene.never'));
</script>

<p class="intro muted">{$t('adminContent.hygiene.intro')}</p>

{#if !supported}
  <AdminCard title={$t('adminContent.hygiene.unsupportedTitle')}><p class="muted">{$t('adminContent.hygiene.unsupported')}</p></AdminCard>
{:else}
  <div class="stats" role="group" aria-label={$t('adminContent.hygiene.issue')}>
    {#each CATEGORIES as c (c)}
      <StatTile icon={ICON[c]} label={$t(`adminContent.hygiene.cat.${c}`)} value={sum ? fmtNumber(sum.byCategory[c] ?? 0) : null} pressed={category === c}
        tone={sum?.byCategory[c] ? 'warn' : 'default'} on:click={() => setCategory(c)} />
    {/each}
  </div>

  <div class="scan">
    <p class="muted small" role="status">
      {#if running}{$t('adminContent.hygiene.running')}
      {:else if sum?.state.lastDone}{$t('adminContent.hygiene.scanned', { time: when(sum.state.lastDone, $t), full: when(sum.state.lastFull, $t) })}
      {:else if sum}{$t('adminContent.hygiene.notYet')}{/if}
      {#if sum?.ignored}{' · '}{$t('adminContent.hygiene.ignoredCount', { n: sum.ignored })}{/if}
    </p>
    <Button variant="secondary" icon="refresh" pending={$busyKeys.has('hyg:scan')} disabled={running || !sum} on:click={scan}>{$t('adminContent.hygiene.checkNow')}</Button>
  </div>
  {#if sumErr && !sum}<p class="muted small" role="alert">{$t('adminContent.hygiene.loadFailed')}</p>{/if}

  <DataTable
    caption={$t('admin.tabs.hygiene')} {rows} {columns} key={(r) => r.itemId} {error} pageSize={PAGE} bind:page bind:q bind:sort {total}
    filterable filterPlaceholder={$t('adminContent.hygiene.search')} emptyText={$t('adminContent.hygiene.empty')} busyKey={(r) => `hyg:${r.itemId}`}
    rowLabel={(r) => rowTitle(r)} on:query={onQuery} on:retry={reloadAll} {actions}>
    <svelte:fragment slot="toolbar">
      <div class="flt"><Select label={$t('adminContent.hygiene.issue')} value={issue} options={issueOptions} on:change={(e) => setIssue((e.currentTarget as HTMLSelectElement).value)} /></div>
      <div class="flt"><Select label={$t('adminContent.hygiene.type')} value={type} options={typeOptions} on:change={(e) => setType((e.currentTarget as HTMLSelectElement).value)} /></div>
      {#if issue}<p class="hint muted small">{$t(issueHint(issue))}</p>{/if}
    </svelte:fragment>
    <svelte:fragment slot="cell" let:row let:col>
      {#if col.key === 'name'}
        <a class="nm" href="/item/{row.itemId}">{rowTitle(row)}</a>
        <span class="sub muted">{[row.year ?? '', $t(`adminContent.hygiene.types.${row.type}` as TKey), row.versions > 1 ? $t('adminContent.hygiene.versions', { n: row.versions }) : ''].filter(Boolean).join(' · ')}</span>
        {#if row.dupOf.length}
          <span class="sub muted">{$t('adminContent.hygiene.dupOf')}: {#each row.dupOf as d, i (d)}{#if i}, {/if}<a class="dup" href="/item/{d}">{$t('adminContent.hygiene.dupItem', { n: i + 1 })}</a>{/each}</span>
        {/if}
      {:else if col.key === 'issues'}
        <span class="pills">
          {#each row.issues as i (i.code)}<span title={$t(issueHint(i.code))}><StatusPill tone={i.severity === 'warn' ? 'warn' : 'info'} icon={i.severity === 'warn' ? 'alert' : 'info'} label={$t(issueLabel(i.code))} /></span>{/each}
        </span>
      {:else if col.key === 'file'}
        <span class="file">
          {#if row.container || row.video}<span>{[row.container, row.video].filter(Boolean).join(' · ')}</span>{/if}
          {#if row.audio.length}<span class="muted">{$t('adminContent.hygiene.audio', { list: row.audio.join(', ') })}</span>{/if}
          <span class="muted">{row.subtitles.length ? $t('adminContent.hygiene.subtitles', { list: row.subtitles.join(', ') }) : $t('adminContent.hygiene.noSubs')}</span>
        </span>
      {:else if col.key === 'size'}{row.sizeBytes ? fmtBytes(row.sizeBytes) : ''}
      {:else if col.key === 'bitrate'}{mbps(row.bitrate)}
      {:else}{col.value?.(row) ?? ''}{/if}
    </svelte:fragment>
  </DataTable>
{/if}

<style>
  .intro { margin: 0 0 1rem; max-width: 75ch; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: .8rem; margin-bottom: .8rem; }
  .scan { display: flex; align-items: center; justify-content: space-between; gap: .5rem 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .scan p { margin: 0; }
  .small { font-size: .85rem; }
  .flt { min-width: 11rem; }
  .hint { flex-basis: 100%; margin: 0; }
  .nm { font-weight: 600; overflow-wrap: anywhere; color: var(--fg); }
  .nm:hover { text-decoration: underline; }
  .sub { display: block; font-weight: 400; font-size: .82rem; margin-top: .15rem; }
  .dup { color: var(--info); display: inline-flex; align-items: center; min-height: 24px; }
  @media (max-width: 720px), (pointer: coarse) { .nm, .dup { display: inline-flex; align-items: center; min-height: 44px; } }
  .dup:hover { text-decoration: underline; }
  .pills { display: flex; flex-wrap: wrap; gap: .3rem; }
  .file { display: flex; flex-direction: column; gap: .1rem; font-size: .85rem; }
</style>
