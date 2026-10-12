<script lang="ts">
  /** Admin: devices – waiting devices first with approve / decline (undo), approved ones can be revoked (confirm). */
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { bumpPending, refreshSummary } from '#lib/admin/summary';
  import { deviceKind } from '#lib/admin/people';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import type { MoreAction } from '#lib/MoreActions.svelte';

  /** current: the device this admin is using right now (cannot be revoked here – that would lock them out) */
  interface D { user_id: string; device_id: string; label: string | null; approved: boolean; last_seen: string | null; name: string; current?: boolean }
  const PAGE = 25;
  let rows: D[] | null = null, total = 0, pending = 0, error: string | null = null;
  let q = '', sort: SortState | null = null, page = 0, statusFilter = '';
  let cur: Query = { q: '', sort: null, offset: 0, limit: PAGE };
  let seq = 0;

  const rkey = (d: D) => `${d.user_id}:${d.device_id}`;
  const dname = (d: D) => d.label || tr('adminPeople.devices.unknownDevice');

  async function load() {
    const my = ++seq;
    const p = new URLSearchParams({ limit: String(cur.limit), offset: String(cur.offset) });
    if (cur.q.trim()) p.set('q', cur.q.trim());
    if (cur.sort) { p.set('sort', cur.sort.key); p.set('dir', cur.sort.dir); }
    if (statusFilter) p.set('status', statusFilter);
    try {
      const r = await api<{ devices: D[]; total: number; pending?: number }>(`/api/admin/devices?${p}`);
      if (my !== seq) return;
      rows = r.devices; total = r.total; pending = r.pending ?? r.devices.filter((d) => !d.approved).length; error = null;
    } catch {
      if (my === seq) error = tr('adminPeople.loadFailed');
    }
  }
  function retry() { error = null; rows = null; void load(); }
  function onQuery(e: CustomEvent<Query>) { cur = e.detail; void load(); }
  function refilter() { page = 0; cur = { ...cur, offset: 0 }; void load(); }
  onMount(load);

  $: statusOptions = [{ value: '', label: $t('adminPeople.devices.all') }, { value: 'pending', label: $t('adminPeople.devices.pending') }, { value: 'approved', label: $t('adminPeople.devices.approved') }];
  $: columns = [
    { key: 'user', sortable: true, label: $t('adminPeople.devices.col.user'), primary: true },
    { key: 'device', sortable: true, label: $t('adminPeople.devices.col.device') },
    { key: 'lastSeen', sortable: true, label: $t('adminPeople.devices.col.lastSeen') },
    { key: 'status', sortable: true, label: $t('adminPeople.devices.col.status') },
  ] satisfies Column<D>[];

  const lockoutError = (e: unknown) => (e instanceof ApiError && e.body?.error === 'cannot_lock_yourself_out' ? tr('adminPeople.devices.ownDevice') : errorText(e));
  const body = (d: D) => ({ method: 'POST', body: { userId: d.user_id, deviceId: d.device_id } });
  /** takes the row out of the list (decline / revoke / filtered approve); the returned rollback puts everything back */
  function withdraw(d: D, wasPending: boolean): () => void {
    const prevRows = rows, prevTotal = total, prevPending = pending;
    rows = (rows ?? []).filter((x) => x !== d);
    total = Math.max(0, total - 1);
    if (wasPending) { pending = Math.max(0, pending - 1); bumpPending('devices', -1); }
    return () => { rows = prevRows; total = prevTotal; pending = prevPending; if (wasPending) bumpPending('devices', 1); };
  }

  function approve(d: D) {
    void runAction({
      key: `dev:${rkey(d)}`,
      apply: () => {
        if (statusFilter === 'pending') return withdraw(d, true);
        d.approved = true; rows = rows; pending = Math.max(0, pending - 1); bumpPending('devices', -1);
        return () => { d.approved = false; rows = rows; pending += 1; bumpPending('devices', 1); };
      },
      run: () => api('/api/admin/devices/approve', body(d)),
      success: tr('adminPeople.devices.approvedToast', { device: dname(d), name: d.name }),
      undo: { run: () => api('/api/admin/devices/unapprove', body(d)) },
    }).then(() => refreshSummary());
  }
  function decline(d: D) {
    // nothing happens before the toast is gone, so Undo is just "keep it"
    void runAction({
      key: `dev:${rkey(d)}`, defer: true,
      apply: () => withdraw(d, !d.approved),
      run: () => api('/api/admin/devices/remove', body(d)),
      success: tr('adminPeople.devices.declinedToast', { device: dname(d), name: d.name }),
    }).then(() => refreshSummary());
  }
  async function revoke(d: D) {
    const ok = await confirm({
      title: tr('adminPeople.devices.confirmRevokeTitle', { device: dname(d) }), body: tr('adminPeople.devices.confirmRevokeBody', { name: d.name }),
      danger: true, confirmLabel: tr('adminPeople.devices.revoke'),
    });
    if (!ok) return;
    void runAction({
      key: `dev:${rkey(d)}`,
      apply: () => withdraw(d, false),
      run: () => api('/api/admin/devices/remove', body(d)),
      success: tr('adminPeople.devices.revokedToast', { device: dname(d), name: d.name }),
      error: lockoutError,
    });
  }

  $: actions = (d: D): MoreAction[] => d.current ? [] : d.approved
    ? [{ id: 'revoke', label: $t('adminPeople.devices.revoke'), icon: 'x', danger: true, run: () => revoke(d) }]
    : [{ id: 'approve', label: $t('adminPeople.devices.approve'), icon: 'check', run: () => approve(d) }, { id: 'decline', label: $t('adminPeople.devices.decline'), icon: 'x', danger: true, run: () => decline(d) }];
</script>

{#if pending > 0}
  <p class="waiting" role="status"><Icon name="clock" size={18} />{$t('adminPeople.devices.waitingCount', { n: pending })}</p>
{/if}

<DataTable
  caption={$t('admin.tabs.devices')} {rows} {columns} key={rkey} {total} {error} pageSize={PAGE}
  filterable filterPlaceholder={$t('adminPeople.devices.searchPlaceholder')}
  bind:q bind:sort bind:page emptyText={statusFilter ? $t('adminPeople.devices.emptyFiltered') : $t('adminPeople.devices.empty')}
  {actions} rowLabel={(d) => `${dname(d)} · ${d.name}`} busyKey={(d) => `dev:${rkey(d)}`}
  on:query={onQuery} on:retry={retry}
>
  <svelte:fragment slot="toolbar">
    <Select label={$t('adminPeople.devices.filterStatus')} options={statusOptions} bind:value={statusFilter} on:change={refilter} hideLabel />
  </svelte:fragment>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'user'}{row.name}
    {:else if col.key === 'device'}
      <span class="dev"><Icon name={deviceKind(row.label).icon} size={18} /><span>{dname(row)}</span></span>
    {:else if col.key === 'lastSeen'}
      {#if row.last_seen}<time datetime={row.last_seen} title={fmtDateTime(row.last_seen)}>{fmtRelative(row.last_seen)}</time>{:else}<span class="sub">{$t('adminPeople.never')}</span>{/if}
    {:else if col.key === 'status'}
      {#if row.current}
        <span class="st"><StatusPill tone="ok" label={$t('adminPeople.devices.approved')} /><StatusPill tone="info" icon="monitor" label={$t('adminPeople.devices.thisDevice')} /></span>
      {:else if row.approved}
        <StatusPill tone="ok" label={$t('adminPeople.devices.approved')} />
      {:else}
        <span class="st">
          <StatusPill tone="warn" label={$t('adminPeople.devices.pending')} />
          <span class="btns">
            <Button size="sm" icon="check" pending={$busyKeys.has(`dev:${rkey(row)}`)} aria-label={$t('adminPeople.devices.approveFor', { device: dname(row), name: row.name })} on:click={() => approve(row)}>{$t('adminPeople.devices.approve')}</Button>
            <Button size="sm" variant="secondary" disabled={$busyKeys.has(`dev:${rkey(row)}`)} aria-label={$t('adminPeople.devices.declineFor', { device: dname(row), name: row.name })} on:click={() => decline(row)}>{$t('adminPeople.devices.decline')}</Button>
          </span>
        </span>
      {/if}
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .waiting { display: flex; align-items: center; gap: .5rem; margin: 0 0 .9rem; padding: .65rem .9rem; border-radius: 8px; background: var(--tone-warn); color: var(--warn); font-weight: 600; }
  .dev { display: inline-flex; align-items: center; gap: .5rem; min-width: 0; color: var(--fg); }
  .dev :global(svg) { color: var(--mut); flex: none; }
  .sub { color: var(--mut); }
  time { white-space: nowrap; }
  .st { display: inline-flex; align-items: center; flex-wrap: wrap; gap: .5rem; justify-content: flex-end; }
  .btns { display: inline-flex; gap: .4rem; flex-wrap: wrap; }
  :global(.dt .bar .field) { min-width: 11rem; }
</style>
