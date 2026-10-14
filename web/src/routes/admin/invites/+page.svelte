<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Admin: invitations – create form (role, expiry, note), one-time link with copy + QR, list with status, revoke (confirm). */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t, tr, trDynamic, type TKey } from '#lib/i18n';
  import { refreshSummary } from '#lib/admin/summary';
  import { EXPIRY_PRESETS, inviteStatus, type InviteStatus } from '#lib/admin/people';
  import { roleName, type RoleInfo } from '#lib/roles';
  import { runAction, errorText } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import CopyField from '#lib/ui/CopyField.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import type { MoreAction } from '#lib/MoreActions.svelte';

  interface I { id: string; role: string; note: string | null; created_at?: string; expires_at: string; used_at: string | null; used_by_name: string | null }
  interface Created { link: string; authentik?: 'off' | 'skipped' | 'ok' | 'failed' }
  const PAGE = 25;
  let rows: I[] | null = null, total = 0, error: string | null = null;
  let roles: Record<string, RoleInfo> = {}, invitable: string[] = ['friend', 'family', 'guest'];
  let q = '', sort: SortState | null = null, page = 0, statusFilter = '';
  let cur: Query = { q: '', sort: null, offset: 0, limit: PAGE };
  let seq = 0;
  // form
  let role = 'friend', expiry = 'd2', note = '', hasAccount = false, creating = false;
  let created: Created | null = null;

  async function load() {
    const my = ++seq;
    const p = new URLSearchParams({ limit: String(cur.limit), offset: String(cur.offset) });
    if (cur.q.trim()) p.set('q', cur.q.trim());
    if (cur.sort) { p.set('sort', cur.sort.key); p.set('dir', cur.sort.dir); }
    if (statusFilter) p.set('status', statusFilter);
    try {
      const r = await api<{ invites: I[]; total: number }>(`/api/admin/invites?${p}`);
      if (my !== seq) return;
      rows = r.invites; total = r.total; error = null;
    } catch {
      if (my === seq) error = tr('adminPeople.loadFailed');
    }
  }
  function retry() { error = null; rows = null; void load(); }
  function onQuery(e: CustomEvent<Query>) { cur = e.detail; void load(); }
  function refilter() { page = 0; cur = { ...cur, offset: 0 }; void load(); }
  onMount(() => {
    void load();
    api<{ roles: Record<string, RoleInfo>; invitable?: string[] }>('/api/admin/roles').then((r) => {
      roles = r.roles;
      if (r.invitable?.length) { invitable = r.invitable; if (!invitable.includes(role)) role = invitable[0]!; }
    }, () => undefined);
  });

  $: rname = (k: string): string => roleName(k, roles[k]);
  // a new function whenever a running action starts/ends, so the table re-renders the row state
  $: roleOptions = invitable.map((k) => ({ value: k, label: rname(k) }));
  $: expiryOptions = EXPIRY_PRESETS.map((p) => ({ value: p.id, label: trDynamic(`adminPeople.invites.expiryOptions.${p.id}`) }));
  $: statusOptions = [{ value: '', label: $t('adminPeople.invites.all') }, { value: 'open', label: $t('adminPeople.invites.open') }, { value: 'used', label: $t('adminPeople.invites.used') }, { value: 'expired', label: $t('adminPeople.invites.expired') }];
  $: columns = [
    { key: 'role', sortable: true, label: $t('adminPeople.invites.col.role'), primary: true },
    { key: 'note', sortable: true, label: $t('adminPeople.invites.col.note') },
    { key: 'validUntil', sortable: true, label: $t('adminPeople.invites.col.validUntil') },
    { key: 'status', sortable: true, label: $t('adminPeople.invites.col.status') },
  ] satisfies Column<I>[];
  const TONE: Record<InviteStatus, Tone> = { open: 'info', used: 'ok', expired: 'muted' };

  async function create() {
    if (creating) return;
    creating = true;
    try {
      const hours = EXPIRY_PRESETS.find((p) => p.id === expiry)?.hours ?? 48;
      created = await api<Created>('/api/admin/invites', { method: 'POST', body: { role, ttlHours: hours, note: note.trim() || undefined, enroll: !hasAccount } });
      note = '';
      toast.success(tr('adminPeople.invites.createdToast'));
      page = 0; cur = { ...cur, offset: 0 };
      void load(); void refreshSummary();
    } catch (e) { toast.error(errorText(e), { action: { label: tr('ui.retry'), run: create } }); }
    finally { creating = false; }
  }

  /** takes the row out of the list; the returned rollback puts it back */
  function withdraw(i: I): () => void {
    const prevRows = rows, prevTotal = total;
    rows = (rows ?? []).filter((x) => x !== i); total = Math.max(0, total - 1);
    return () => { rows = prevRows; total = prevTotal; };
  }
  async function revoke(i: I) {
    const ok = await confirm({ title: tr('adminPeople.invites.confirmRevokeTitle'), body: tr('adminPeople.invites.confirmRevokeBody'), danger: true, confirmLabel: tr('adminPeople.invites.revoke') });
    if (!ok) return;
    void runAction({
      key: `inv:${i.id}`, apply: () => withdraw(i),
      run: () => api(`/api/admin/invites/${i.id}`, { method: 'DELETE' }),
      success: tr('adminPeople.invites.revokedToast'),
    }).then(() => refreshSummary());
  }
  function removeExpired(i: I) {
    // junk entry: postponed instead of asked – Undo keeps it
    void runAction({
      key: `inv:${i.id}`, defer: true, apply: () => withdraw(i),
      run: () => api(`/api/admin/invites/${i.id}`, { method: 'DELETE' }),
      success: tr('adminPeople.invites.removedToast'),
    });
  }
  $: actions = (i: I): MoreAction[] => {
    const s = inviteStatus(i);
    if (s === 'used') return [{ id: 'used', label: i.used_by_name ? tr('adminPeople.invites.usedBy', { name: i.used_by_name }) : tr('adminPeople.invites.used'), icon: 'check', disabled: true }];
    return s === 'open'
      ? [{ id: 'revoke', label: $t('adminPeople.invites.revoke'), icon: 'x', danger: true, run: () => revoke(i) }]
      : [{ id: 'remove', label: $t('adminPeople.invites.remove'), icon: 'x', danger: true, run: () => removeExpired(i) }];
  };
  const AUTH: Record<string, TKey> = { ok: 'adminPeople.invites.authOk', failed: 'adminPeople.invites.authFailed', off: 'adminPeople.invites.authOff' };
</script>

<section class="card" aria-labelledby="inv-new">
  <h2 id="inv-new">{$t('adminPeople.invites.newTitle')}</h2>
  <p class="hint">{$t('adminPeople.invites.singleUse')}</p>
  <form class="form" on:submit|preventDefault={create}>
    <Select label={$t('adminPeople.invites.role')} options={roleOptions} bind:value={role} />
    <Select label={$t('adminPeople.invites.expiry')} options={expiryOptions} bind:value={expiry} />
    <div class="wide"><Field label={$t('adminPeople.invites.note')} bind:value={note} placeholder={$t('adminPeople.invites.notePlaceholder')} hint={$t('adminPeople.invites.noteHint')} maxlength={100} /></div>
    <div class="wide"><Toggle label={$t('adminPeople.invites.hasAccount')} hint={$t('adminPeople.invites.hasAccountHint')} bind:checked={hasAccount} /></div>
    <div class="wide"><Button type="submit" icon="plus" pending={creating}>{$t('adminPeople.invites.create')}</Button></div>
  </form>
</section>

{#if created}
  <section class="card result" aria-labelledby="inv-link">
    <div class="rh"><h2 id="inv-link">{$t('adminPeople.invites.linkTitle')}</h2><Button variant="ghost" size="sm" icon="x" on:click={() => (created = null)}>{$t('adminPeople.invites.closeLink')}</Button></div>
    <CopyField label={$t('adminPeople.invites.link')} value={created.link} qr hint={$t('adminPeople.invites.linkHint')} />
    {#if created.authentik && AUTH[created.authentik]}
      <p class="auth {created.authentik}"><Icon name={created.authentik === 'ok' ? 'check' : created.authentik === 'failed' ? 'alert' : 'info'} size={18} />{trDynamic(AUTH[created.authentik]!)}</p>
    {/if}
  </section>
{/if}

<DataTable
  caption={$t('admin.tabs.invites')} {rows} {columns} key={(i) => i.id} {total} {error} pageSize={PAGE}
  filterable filterPlaceholder={$t('adminPeople.invites.searchPlaceholder')}
  bind:q bind:sort bind:page emptyText={statusFilter ? $t('adminPeople.invites.emptyFiltered') : $t('adminPeople.invites.empty')}
  {actions} rowLabel={(i) => tr('adminPeople.invites.inviteOf', { role: rname(i.role) })} busyKey={(i) => `inv:${i.id}`}
  on:query={onQuery} on:retry={retry}
>
  <svelte:fragment slot="toolbar">
    <Select label={$t('adminPeople.invites.filterStatus')} options={statusOptions} bind:value={statusFilter} on:change={refilter} hideLabel />
  </svelte:fragment>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'role'}{rname(row.role)}
    {:else if col.key === 'note'}<span class="sub">{row.note ?? ''}</span>
    {:else if col.key === 'validUntil'}<time datetime={row.expires_at} title={fmtRelative(row.expires_at)}>{fmtDateTime(row.expires_at)}</time>
    {:else if col.key === 'status'}
      {@const s = inviteStatus(row)}
      <span class="stc">
        <StatusPill tone={TONE[s]} label={$t(`adminPeople.invites.${s}`)} icon={s === 'open' ? 'clock' : undefined} />
        {#if s === 'used' && row.used_by_name}<span class="sub">{$t('adminPeople.invites.usedBy', { name: row.used_by_name })}</span>{/if}
      </span>
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
  h2 { margin: 0 0 .3rem; font-size: 1.05rem; }
  .hint { margin: 0 0 .9rem; color: var(--mut); font-size: .9rem; }
  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: .9rem; max-width: 46rem; }
  .wide { grid-column: 1 / -1; }
  .form .wide:last-child { display: flex; }
  .result { display: flex; flex-direction: column; gap: .8rem; border-color: var(--ok); }
  .rh { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
  .rh h2 { margin: 0; }
  .auth { display: flex; gap: .5rem; align-items: flex-start; margin: 0; font-size: .9rem; color: var(--mut); }
  .auth.ok { color: var(--ok); } .auth.failed { color: var(--warn); }
  .auth :global(svg) { flex: none; margin-top: .1rem; }
  .sub { color: var(--mut); font-size: .85rem; }
  .stc { display: inline-flex; flex-direction: column; align-items: flex-end; gap: .15rem; }
  @media (min-width: 721px) { .stc { align-items: flex-start; } }
  time { white-space: nowrap; }
  :global(.dt .bar .field) { min-width: 10rem; }
</style>
