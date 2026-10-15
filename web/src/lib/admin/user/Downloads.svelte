<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail, downloads tab: the account's active offline licences (title, profile, state, valid until); revoke one (with confirm). */
  import { createEventDispatcher } from 'svelte';
  import { api } from '#lib/api';
  import { fmtDate, fmtRelative, hasKey, t, tr, trDynamic } from '#lib/i18n';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import { runAction } from '#lib/ui/action';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';
  import type { DetailLicense, DetailProfile } from './detail';

  export let licenses: DetailLicense[];
  export let profiles: DetailProfile[];

  $: columns = [
    { key: 'title', label: $t('adminPeople.detail.downloads.col.title'), primary: true },
    { key: 'profile', label: $t('adminPeople.detail.downloads.col.profile') },
    { key: 'status', label: $t('adminPeople.detail.downloads.col.status') },
    { key: 'validUntil', label: $t('adminPeople.detail.downloads.col.validUntil') },
  ] satisfies Column<DetailLicense>[];
  $: profileName = (id: string): string => profiles.find((p) => p.id === id)?.name ?? '';
  const dispatch = createEventDispatcher<{ changed: void }>();
  const name = (l: DetailLicense): string => (l.seriesName ? `${l.seriesName} · ${l.title}` : l.title);
  async function revoke(l: DetailLicense) {
    const title = name(l);
    const ok = await confirm({ title: tr('adminPeople.detail.downloads.revokeTitle', { title }), body: tr('adminPeople.detail.downloads.revokeBody'), danger: true, confirmLabel: tr('adminPeople.detail.downloads.revoke') });
    if (!ok) return;
    const r = await runAction({ key: `licence:${l.id}`, run: () => api(`/api/admin/downloads/${l.id}`, { method: 'DELETE' }), success: tr('adminPeople.detail.downloads.revoked', { title }) });
    if (r.ok) dispatch('changed');
  }
  $: actions = (l: DetailLicense): MoreAction[] => [{ id: 'revoke', label: $t('adminPeople.detail.downloads.revoke'), icon: 'x', danger: true, run: () => revoke(l) }];
  const statusText = (s: string): string => (hasKey(`adminPeople.detail.downloads.${s}`) ? trDynamic(`adminPeople.detail.downloads.${s}`) : s);
</script>

<DataTable caption={$t('adminPeople.detail.tabs.downloads')} rows={licenses} {columns} key={(l) => l.id} pageSize={25} {actions} rowLabel={name} busyKey={(l) => `licence:${l.id}`} emptyText={$t('adminPeople.detail.downloads.empty')}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'title'}
      {#if row.seriesName}<span class="n">{row.seriesName}</span> <span class="sub">{row.season !== null && row.episode !== null ? `S${row.season} E${row.episode} · ` : ''}{row.title}</span>
      {:else}<span class="n">{row.title}</span>{/if}
    {:else if col.key === 'profile'}{profileName(row.profileId)}
    {:else if col.key === 'status'}<StatusPill tone={row.status === 'fetched' ? 'ok' : 'info'} label={statusText(row.status)} />
    {:else if col.key === 'validUntil'}<time datetime={row.validUntil} title={fmtRelative(row.validUntil)}>{fmtDate(row.validUntil, { dateStyle: 'medium' })}</time>
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .n { font-weight: 600; }
  .sub { color: var(--mut); font-weight: 400; }
  time { white-space: nowrap; }
</style>
