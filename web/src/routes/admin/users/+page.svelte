<script lang="ts">
  /** Admin: users – server-side search/sort/paging, role select (optimistic, rollback), lock/unlock (confirm + undo), sign out everywhere (confirm). */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { avatarBg, initial } from '#lib/avatars';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { refreshSummary } from '#lib/admin/summary';
  import { roleName, type RoleInfo } from '#lib/roles';
  import { busyKeys, runAction } from '#lib/ui/action';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import type { MoreAction } from '#lib/MoreActions.svelte';

  interface U { id: string; name: string; email: string | null; role: string; disabled: boolean; jellyfin_username: string | null; created_at: string; last_seen: string | null }
  const PAGE = 25;
  let rows: U[] | null = null, total = 0, error: string | null = null;
  let roles: Record<string, RoleInfo> = {}, meId = '';
  let q = '', sort: SortState | null = null, page = 0, roleFilter = '', statusFilter = '';
  let cur: Query = { q: '', sort: null, offset: 0, limit: PAGE };
  let seq = 0;

  async function load() {
    const my = ++seq;
    const p = new URLSearchParams({ limit: String(cur.limit), offset: String(cur.offset) });
    if (cur.q.trim()) p.set('q', cur.q.trim());
    if (cur.sort) { p.set('sort', cur.sort.key); p.set('dir', cur.sort.dir); }
    if (roleFilter) p.set('role', roleFilter);
    if (statusFilter) p.set('status', statusFilter);
    try {
      const r = await api<{ users: U[]; total: number }>(`/api/admin/users?${p}`);
      if (my !== seq) return;
      rows = r.users; total = r.total; error = null;
    } catch {
      if (my === seq) error = tr('adminPeople.loadFailed');
    }
  }
  function retry() { error = null; rows = null; void load(); }
  function onQuery(e: CustomEvent<Query>) { cur = e.detail; void load(); }
  function refilter() { page = 0; cur = { ...cur, offset: 0 }; void load(); }

  onMount(() => {
    void load();
    api<{ roles: Record<string, RoleInfo> }>('/api/admin/roles').then((r) => (roles = r.roles), () => undefined);
    api<{ id: string }>('/api/me').then((m) => (meId = m.id), () => undefined);
  });

  $: rname = (k: string): string => roleName(k, roles[k]);
  // a new function whenever a running action starts/ends, so the table re-renders the row state
  $: roleOptions = Object.keys(roles).map((k) => ({ value: k, label: rname(k) }));
  $: roleFilterOptions = [{ value: '', label: $t('adminPeople.users.allRoles') }, ...roleOptions];
  $: statusOptions = [{ value: '', label: $t('adminPeople.users.allStatus') }, { value: 'active', label: $t('adminPeople.users.active') }, { value: 'locked', label: $t('adminPeople.users.locked') }];
  $: columns = [
    { key: 'name', sortable: true, label: $t('adminPeople.users.col.name'), primary: true },
    { key: 'email', sortable: true, label: $t('adminPeople.users.col.email') },
    { key: 'role', sortable: true, label: $t('adminPeople.users.col.role') },
    { key: 'status', sortable: true, label: $t('adminPeople.users.col.status') },
    { key: 'lastSeen', sortable: true, label: $t('adminPeople.users.col.lastSeen') },
  ] satisfies Column<U>[];
  const optionsFor = (opts: Array<{ value: string; label: string }>, role: string) => (opts.some((o) => o.value === role) ? opts : [...opts, { value: role, label: rname(role) }]);

  function changeRole(u: U, role: string) {
    const prev = u.role;
    if (role === prev) return;
    const patch = (r: string) => () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: r } });
    void runAction({
      key: `user:${u.id}`,
      apply: () => { u.role = role; rows = rows; return () => { u.role = prev; rows = rows; }; },
      run: patch(role),
      success: tr('adminPeople.users.roleChanged', { name: u.name, role: rname(role) }),
      undo: { run: patch(prev) },
    });
  }

  function setLocked(u: U, disabled: boolean) {
    const patch = (d: boolean) => () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: d } });
    void runAction({
      key: `user:${u.id}`,
      apply: () => { const prev = u.disabled; u.disabled = disabled; rows = rows; return () => { u.disabled = prev; rows = rows; }; },
      run: patch(disabled),
      success: tr(disabled ? 'adminPeople.users.lockedToast' : 'adminPeople.users.unlockedToast', { name: u.name }),
      undo: { run: patch(!disabled) },
    }).then(() => refreshSummary());
  }
  async function lock(u: U) {
    const ok = await confirm({
      title: tr('adminPeople.users.confirmLockTitle', { name: u.name }), body: tr('adminPeople.users.confirmLockBody', { name: u.name }),
      danger: true, confirmLabel: tr('adminPeople.users.lock'),
      ...(u.role === 'admin' ? { typed: u.name } : {}), // locking an admin: type the name
    });
    if (ok) setLocked(u, true);
  }
  async function signOut(u: U) {
    const ok = await confirm({
      title: tr('adminPeople.users.confirmSignOutTitle', { name: u.name }), body: tr('adminPeople.users.confirmSignOutBody', { name: u.name }),
      danger: true, confirmLabel: tr('adminPeople.users.signOut'),
    });
    if (!ok) return;
    void runAction({
      key: `user:${u.id}`,
      run: () => api<{ revoked: number }>(`/api/admin/users/${u.id}/revoke-sessions`, { method: 'POST' }),
      success: (r) => tr('adminPeople.users.signedOutToast', { name: u.name, n: r?.revoked ?? 0 }),
    });
  }

  $: actions = (u: U): MoreAction[] => u.id === meId
    ? [{ id: 'self', label: $t('adminPeople.users.selfNote'), icon: 'lock', disabled: true }]
    : [
      u.disabled ? { id: 'unlock', label: $t('adminPeople.users.unlock'), icon: 'unlock', run: () => setLocked(u, false) } : { id: 'lock', label: $t('adminPeople.users.lock'), icon: 'lock', danger: true, run: () => lock(u) },
      { id: 'signout', label: $t('adminPeople.users.signOut'), icon: 'log-out', danger: true, run: () => signOut(u) },
    ];
</script>

<DataTable
  caption={$t('admin.tabs.users')} {rows} {columns} key={(u) => u.id} {total} {error} pageSize={PAGE}
  filterable filterPlaceholder={$t('adminPeople.users.searchPlaceholder')}
  bind:q bind:sort bind:page emptyText={roleFilter || statusFilter ? $t('adminPeople.users.emptyFiltered') : $t('adminPeople.users.empty')}
  {actions} rowLabel={(u) => u.name} busyKey={(u) => `user:${u.id}`}
  on:query={onQuery} on:retry={retry}
>
  <svelte:fragment slot="toolbar">
    <Select label={$t('adminPeople.users.filterRole')} options={roleFilterOptions} bind:value={roleFilter} on:change={refilter} hideLabel />
    <Select label={$t('adminPeople.users.filterStatus')} options={statusOptions} bind:value={statusFilter} on:change={refilter} hideLabel />
  </svelte:fragment>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      <span class="who">
        <span class="av" style:background={avatarBg(undefined)} aria-hidden="true">{initial(row.name)}</span>
        <span class="nm"><span class="n">{row.name}{#if row.id === meId} <StatusPill tone="info" label={$t('adminPeople.users.you')} icon="" />{/if}</span>{#if row.jellyfin_username}<span class="sub">{row.jellyfin_username}</span>{/if}</span>
      </span>
    {:else if col.key === 'email'}<span class="sub">{row.email ?? ''}</span>
    {:else if col.key === 'role'}
      <Select label={$t('adminPeople.users.roleOf', { name: row.name })} options={optionsFor(roleOptions, row.role)} value={row.role} hideLabel
        disabled={row.id === meId || $busyKeys.has(`user:${row.id}`)} on:change={(e) => changeRole(row, (e.target as HTMLSelectElement).value)} />
    {:else if col.key === 'status'}
      {#if row.disabled}<StatusPill tone="err" label={$t('adminPeople.users.locked')} icon="lock" />{:else}<StatusPill tone="ok" label={$t('adminPeople.users.active')} />{/if}
    {:else if col.key === 'lastSeen'}
      {#if row.last_seen}<time datetime={row.last_seen} title={fmtDateTime(row.last_seen)}>{fmtRelative(row.last_seen)}</time>{:else}<span class="sub">{$t('adminPeople.never')}</span>{/if}
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .who { display: inline-flex; align-items: center; gap: .7rem; min-width: 0; }
  .av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: .95rem; color: #fff; }
  .nm { display: flex; flex-direction: column; min-width: 0; text-align: left; }
  .n { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; font-weight: 600; }
  .sub { color: var(--mut); font-size: .85rem; font-weight: 400; }
  time { white-space: nowrap; }
  :global(.dt .bar .field) { min-width: 9.5rem; }
</style>
