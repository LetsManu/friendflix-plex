<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail, devices tab: last seen, live sessions, approval; approve / withdraw approval, sign out one device, remove (with confirm). */
  import { createEventDispatcher } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtNumber, fmtRelative, t, tr } from '#lib/i18n';
  import { deviceKind } from '#lib/admin/people';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';
  import type { DetailDevice } from './detail';

  export let userId: string;
  export let devices: DetailDevice[];
  const dispatch = createEventDispatcher<{ changed: void }>();

  $: columns = [
    { key: 'name', label: $t('adminPeople.detail.devices.col.name'), primary: true },
    { key: 'lastSeen', label: $t('adminPeople.detail.devices.col.lastSeen') },
    { key: 'sessions', label: $t('adminPeople.detail.devices.col.sessions'), align: 'end' },
    { key: 'status', label: $t('adminPeople.detail.devices.col.status') },
  ] satisfies Column<DetailDevice>[];
  const key = (d: DetailDevice) => `device:${userId}:${d.id}`;
  const label = (d: DetailDevice): string => d.name || tr('adminPeople.devices.unknownDevice');

  async function signOut(d: DetailDevice) {
    const device = label(d);
    const ok = await confirm({
      title: tr('adminPeople.detail.devices.confirmTitle', { device }), body: tr('adminPeople.detail.devices.confirmBody'),
      danger: true, confirmLabel: tr('adminPeople.detail.devices.signOut'),
    });
    if (!ok) return;
    const r = await runAction({
      key: key(d),
      run: () => api<{ revoked: number }>(`/api/admin/users/${userId}/sessions/${encodeURIComponent(d.id)}/revoke`, { method: 'POST' }),
      success: (res) => tr('adminPeople.detail.devices.done', { device, n: res?.revoked ?? 0 }),
    });
    if (r.ok) dispatch('changed');
  }

  /** the admin's own current device: the backend refuses to unapprove/remove it */
  const ownError = (e: unknown): string => (e instanceof ApiError && (e.body as { error?: string } | null)?.error === 'cannot_lock_yourself_out' ? tr('adminPeople.devices.ownDevice') : errorText(e));
  async function call(d: DetailDevice, what: 'approve' | 'unapprove' | 'remove', success: string) {
    const r = await runAction({
      key: key(d), error: ownError, success,
      run: () => api(`/api/admin/devices/${what}`, { method: 'POST', body: { userId, deviceId: d.id } }),
    });
    if (r.ok) dispatch('changed');
  }
  const approve = (d: DetailDevice) => call(d, 'approve', tr('adminPeople.detail.devices.approved', { device: label(d) }));
  const unapprove = (d: DetailDevice) => call(d, 'unapprove', tr('adminPeople.detail.devices.unapproved', { device: label(d) }));
  async function remove(d: DetailDevice) {
    const device = label(d);
    const ok = await confirm({ title: tr('adminPeople.detail.devices.removeTitle', { device }), body: tr('adminPeople.detail.devices.removeBody'), danger: true, confirmLabel: tr('adminPeople.detail.devices.remove') });
    if (ok) await call(d, 'remove', tr('adminPeople.detail.devices.removed', { device }));
  }
  $: actions = (d: DetailDevice): MoreAction[] => [
    d.approved
      ? { id: 'unapprove', label: $t('adminPeople.detail.devices.unapprove'), icon: 'x', run: () => unapprove(d) }
      : { id: 'approve', label: $t('adminPeople.detail.devices.approve'), icon: 'check', run: () => approve(d) },
    { id: 'signout', label: $t('adminPeople.detail.devices.signOut'), icon: 'log-out', danger: true, run: () => signOut(d) },
    { id: 'remove', label: $t('adminPeople.detail.devices.remove'), icon: 'x', danger: true, run: () => remove(d) },
  ];
</script>

<DataTable caption={$t('adminPeople.detail.tabs.devices')} rows={devices} {columns} key={(d) => d.id} pageSize={0} busyKey={key} {actions} rowLabel={label} emptyText={$t('adminPeople.detail.devices.empty')}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      <span class="who">
        <Icon name={deviceKind(row.name).icon} size={18} />
        <span class="n">{label(row)}</span>
        {#if !row.approved}<Button size="sm" icon="check" disabled={$busyKeys.has(key(row))} aria-label={$t('adminPeople.detail.devices.approveFor', { device: label(row) })} on:click={() => approve(row)}>{$t('adminPeople.detail.devices.approve')}</Button>{/if}
      </span>
    {:else if col.key === 'lastSeen'}<time datetime={row.lastSeen} title={fmtDateTime(row.lastSeen)}>{fmtRelative(row.lastSeen)}</time>
    {:else if col.key === 'sessions'}<span class="num">{fmtNumber(row.sessions)}</span>
    {:else if col.key === 'status'}
      {#if row.approved}<StatusPill tone="ok" label={$t('adminPeople.devices.approved')} />{:else}<StatusPill tone="warn" label={$t('adminPeople.devices.pending')} />{/if}
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .who { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; min-width: 0; }
  .who > :global(svg) { color: var(--mut); flex: none; }
  .n { font-weight: 600; overflow-wrap: anywhere; margin-right: auto; }
  .num { font-variant-numeric: tabular-nums; }
  time { white-space: nowrap; }
</style>
