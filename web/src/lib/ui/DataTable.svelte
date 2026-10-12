<script lang="ts" generics="T">
  /**
   * Data table (docs/ui-kit.md): columns config, sort, text filter, paging (client or server), sticky header,
   * row actions (ActionMenu), per-row busy state, skeleton rows, empty / error + retry. At ≤720px every row
   * becomes a card (label: value), so nothing overflows horizontally.
   *
   *   <DataTable caption={$t('admin.tabs.users')} rows={users} key={(u) => u.id} filterable
   *     columns={[{ key: 'name', label: $t('admin.users.name'), value: (u) => u.name, primary: true }, …]}
   *     actions={(u) => [{ id: 'lock', label: …, run: () => lock(u), danger: true }]} busyKey={(u) => 'user:' + u.id}
   *     error={loadErr} on:retry={load}>
   *     <svelte:fragment slot="cell" let:row let:col>{#if col.key === 'status'}<StatusPill …/>{:else}{col.value?.(row) ?? ''}{/if}</svelte:fragment>
   *   </DataTable>
   *
   * Server paging: pass `total` (all matching rows on the server) and handle `on:query` ({ q, sort, offset, limit });
   * `rows` is then the current page only and filtering/sorting happen on the server.
   */
  import { createEventDispatcher } from 'svelte';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, t } from '#lib/i18n';
  import ActionMenu from './ActionMenu.svelte';
  import Button from './Button.svelte';
  import Skeleton from './Skeleton.svelte';
  import { cellText, filterRows, nextSort, pageInfo, sortRows, type Column, type Query, type SortState } from './table';
  import { uid } from './ids';
  import { busyKeys } from './action';

  /** null = loading (skeleton rows) */
  export let rows: T[] | null;
  export let columns: Column<T>[];
  export let key: (row: T) => string;
  /** accessible table name (visually hidden unless showCaption) */
  export let caption: string;
  export let showCaption = false;
  export let filterable = false;
  /** custom text the filter searches (default: all columns with a value) */
  export let filterText: ((row: T) => string) | undefined = undefined;
  export let filterPlaceholder = '';
  /** current filter text (bindable, e.g. to mirror it in the URL) */
  export let q = '';
  /** current sort (bindable) */
  export let sort: SortState | null = null;
  /** 0 = no paging */
  export let pageSize = 25;
  export let page = 0;
  /** server paging: total number of matching rows; switches filter/sort/paging to `on:query` */
  export let total: number | null = null;
  export let error: string | null = null;
  export let emptyText = '';
  export let actions: ((row: T) => MoreAction[]) | undefined = undefined;
  /** name of the row for the actions button ("Aktionen für Anna") */
  export let rowLabel: ((row: T) => string) | undefined = undefined;
  /** runAction key of a row: the table follows $busyKeys itself (row dimmed, actions disabled while it runs) */
  export let busyKey: ((row: T) => string) | undefined = undefined;
  /** custom busy test (when the busy state is not a runAction key) */
  export let busy: ((row: T) => boolean) | undefined = undefined;
  export let skeletonRows = 5;

  const dispatch = createEventDispatcher<{ retry: void; query: Query }>();
  const id = uid('dt');
  $: server = total !== null;
  $: filtered = rows === null ? [] : server ? rows : sortRows(filterRows(rows, columns, q, filterText), columns, sort);
  $: count = server ? (total ?? 0) : filtered.length;
  $: info = pageInfo(count, page, pageSize);
  $: shown = server || !pageSize ? filtered : filtered.slice((info.from || 1) - 1, info.to);
  $: hasActions = Boolean(actions);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => dispatch('query', { q, sort, offset: page * pageSize, limit: pageSize });
  function onFilter() {
    page = 0;
    if (server) { clearTimeout(timer); timer = setTimeout(emit, 300); }
  }
  function sortBy(c: Column<T>) {
    sort = nextSort(sort, c.key);
    page = 0;
    if (server) emit();
  }
  function go(p: number) {
    page = p;
    if (server) emit();
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }
  function clear() { q = ''; onFilter(); }
  const sortable = (c: Column<T>) => c.sortable ?? Boolean(c.value || c.sort);
  const ariaSort = (c: Column<T>): 'ascending' | 'descending' | undefined => (sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined);
</script>

<div class="dt" {id}>
  {#if filterable || $$slots.toolbar}
    <div class="bar">
      {#if filterable}
        <label class="search">
          <span class="sr-only">{$t('ui.table.filter')}</span>
          <Icon name="search" size={18} />
          <input type="search" bind:value={q} placeholder={filterPlaceholder || $t('ui.table.filterPlaceholder')} on:input={onFilter} aria-controls="{id}-t" />
        </label>
      {/if}
      <slot name="toolbar" />
    </div>
  {/if}

  {#if error}
    <div class="state err" role="alert">
      <Icon name="alert" size={22} /><p>{error}</p>
      <Button variant="secondary" icon="refresh" on:click={() => dispatch('retry')}>{$t('ui.retry')}</Button>
    </div>
  {:else}
    <table id="{id}-t" aria-busy={rows === null ? 'true' : undefined} aria-rowcount={rows === null ? undefined : count}>
      <caption class:sr-only={!showCaption}>{caption}</caption>
      <thead>
        <tr>
          {#each columns as c (c.key)}
            <th scope="col" aria-sort={ariaSort(c)} style:width={c.width} class="al-{c.align ?? 'start'}">
              {#if sortable(c) && rows !== null}
                <button type="button" class="sorter" class:on={sort?.key === c.key} on:click={() => sortBy(c)}>
                  {c.label}<span class="sr-only">{sort?.key === c.key ? (sort.dir === 'asc' ? $t('ui.table.sortAsc') : $t('ui.table.sortDesc')) : ''}</span>
                  <Icon name={sort?.key === c.key ? (sort.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort'} size={14} />
                </button>
              {:else}{c.label}{/if}
            </th>
          {/each}
          {#if hasActions}<th scope="col" class="act"><span class="sr-only">{$t('ui.table.actions')}</span></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#if rows === null}
          {#each Array(skeletonRows) as _, i (i)}
            <tr class="sk" aria-hidden="true">
              {#each columns as c (c.key)}<td class:primary={c.primary}><Skeleton w={c.primary ? '70%' : '50%'} h=".95rem" /></td>{/each}
              {#if hasActions}<td class="act"><Skeleton w="44px" h="44px" radius="50%" /></td>{/if}
            </tr>
          {/each}
        {:else}
          {#each shown as row (key(row))}
            {@const b = (busyKey ? $busyKeys.has(busyKey(row)) : false) || (busy?.(row) ?? false)}
            <tr class:busy={b} aria-busy={b ? 'true' : undefined}>
              {#each columns as c (c.key)}
                <td data-label={c.label} class="al-{c.align ?? 'start'}" class:primary={c.primary} class:nocard={c.hideOnCard}>
                  <slot name="cell" {row} col={c}>{cellText(c, row)}</slot>
                </td>
              {/each}
              {#if hasActions && actions}
                {@const items = actions(row)}
                <td class="act">{#if items.length}<ActionMenu {items} busy={b} label={rowLabel ? $t('ui.table.actionsFor', { name: rowLabel(row) }) : $t('ui.table.actions')} title={rowLabel?.(row) ?? ''} />{/if}</td>
              {/if}
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
    {#if rows === null}<p class="sr-only" role="status">{$t('ui.table.loading')}</p>{/if}

    {#if rows !== null && !count}
      <div class="state">
        {#if q.trim()}
          <p>{$t('ui.table.noMatch', { q: q.trim() })}</p>
          <Button variant="ghost" size="sm" on:click={clear}>{$t('ui.table.clearFilter')}</Button>
        {:else}<slot name="empty"><p>{emptyText || $t('ui.table.empty')}</p></slot>{/if}
      </div>
    {/if}

    {#if rows !== null && pageSize && info.pages > 1}
      <nav class="pager" aria-label={$t('ui.table.pages')}>
        <span class="range" aria-live="polite">{$t('ui.table.range', { from: fmtNumber(info.from), to: fmtNumber(info.to), total: fmtNumber(info.total) })}</span>
        <button type="button" class="ghost pg" disabled={info.page === 0} aria-label={$t('ui.table.prev')} on:click={() => go(info.page - 1)}><Icon name="chevron-left" size={20} /></button>
        <button type="button" class="ghost pg" disabled={info.page >= info.pages - 1} aria-label={$t('ui.table.next')} on:click={() => go(info.page + 1)}><Icon name="chevron-right" size={20} /></button>
      </nav>
    {/if}
  {/if}
</div>

<style>
  .dt { min-width: 0; scroll-margin-top: calc(var(--nav-h) + 1rem); }
  .bar { height: auto; background: none; overflow: visible; display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .8rem; }
  .search { position: relative; display: flex; align-items: center; flex: 1 1 240px; max-width: 420px; color: var(--mut); }
  .search :global(svg) { position: absolute; left: .75rem; pointer-events: none; }
  .search input { width: 100%; padding-left: 2.4rem; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  caption.sr-only { position: absolute; }
  th { position: sticky; top: var(--nav-h); z-index: 2; background: #181e24; text-align: left; padding: .55rem .8rem; font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--mut); border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child { border-top-left-radius: 8px; } th:last-child { border-top-right-radius: 8px; }
  td { padding: .6rem .8rem; border-bottom: 1px solid var(--line); vertical-align: middle; overflow-wrap: anywhere; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr { transition: background var(--t-fast), opacity var(--t-fast); }
  tbody tr:not(.sk):hover { background: rgba(255,255,255,.03); }
  tr.busy { opacity: .6; }
  td.primary { font-weight: 600; }
  .al-end { text-align: right; } .al-center { text-align: center; }
  .act { width: 60px; text-align: right; }
  .sorter { background: transparent; color: inherit; font: inherit; text-transform: inherit; letter-spacing: inherit; padding: 0 .2rem; min-height: 32px; gap: .3rem; margin-left: -.2rem; border-radius: 4px; }
  .sorter:hover:not(:disabled) { background: rgba(255,255,255,.06); color: var(--fg); }
  .sorter.on { color: var(--fg); }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; color: var(--mut); background: var(--surface); border: 1px solid var(--line); border-top: 0; border-radius: 0 0 8px 8px; }
  .state p { margin: 0; }
  .state.err { border-top: 1px solid var(--line); border-radius: 8px; color: var(--fg); }
  .state.err :global(svg) { color: var(--err); }
  .pager { display: flex; align-items: center; justify-content: flex-end; gap: .4rem; margin-top: .6rem; }
  .range { color: var(--mut); font-size: .88rem; margin-right: .4rem; font-variant-numeric: tabular-nums; }
  .pg { width: 44px; padding: 0; border-radius: 50%; }
  :global(html.tv) th { top: 0; }

  /* phone: every row is a card (label: value); the primary column is the title, actions sit top-right */
  @media (max-width: 720px) {
    table, tbody, tr, td { display: block; width: 100%; }
    table { background: transparent; border: 0; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    tbody { display: flex; flex-direction: column; gap: .6rem; }
    tbody tr { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .7rem .9rem; }
    td { display: flex; gap: .8rem; justify-content: space-between; align-items: center; padding: .3rem 0; border: 0; text-align: right; min-height: 0; }
    td::before { content: attr(data-label); color: var(--mut); font-size: .85rem; text-align: left; flex: none; max-width: 45%; }
    td.primary { display: block; text-align: left; font-size: 1.02rem; padding-right: 3.2rem; }
    td.primary::before, td.act::before, tr.sk td::before { content: none; }
    td.nocard { display: none; }
    td.act { position: absolute; top: .35rem; right: .4rem; width: auto; padding: 0; }
    .state { border-top: 1px solid var(--line); border-radius: 8px; }
    .pager { justify-content: center; }
  }
</style>
