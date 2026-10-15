<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: invitations (tab of /admin/users) – create form (role, expiry, max uses, access days, note), link with copy + QR
   * (shown once), list with uses ("1/3", accounts unfold), status, revoke (confirm).
   */
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

  /** role labels and the roles an invite may grant (loaded by the page) */
  export let roles: Record<string, RoleInfo> = {};
  export let invitable: string[] = ['friend', 'family', 'guest'];

  interface I {
    id: string; role: string; note: string | null; created_at?: string; expires_at: string; used_at: string | null; used_by_name: string | null
    uses: number; max_uses: number; access_days: number | null
  }
  interface Use { id: string; name: string }
  interface Created { link: string; authentik?: 'off' | 'skipped' | 'ok' | 'failed' }
  const PAGE = 25;
  let rows: I[] | null = null, total = 0, error: string | null = null;
  let q = '', sort: SortState | null = null, page = 0, statusFilter = '';
  let cur: Query = { q: '', sort: null, offset: 0, limit: PAGE };
  let seq = 0;
  // form
  let role = 'friend', expiry = 'd2', note = '', hasAccount = false, creating = false;
  let maxUses: string | number | null = 1, accessDays: string | number | null = '';
  let created: Created | null = null;
  /** accounts per invite (undefined = not loaded, null = failed) */
  let uses: Record<string, Use[] | null | undefined> = {};

  $: if (invitable.length && !invitable.includes(role)) role = invitable[0]!;

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
  onMount(() => { void load(); });

  async function loadUses(i: I) {
    if (uses[i.id]) return;
    uses = { ...uses, [i.id]: undefined };
    try { uses = { ...uses, [i.id]: (await api<{ uses: Use[] }>(`/api/admin/invites/${i.id}/uses`)).uses }; }
    catch { uses = { ...uses, [i.id]: null }; }
  }

  $: rname = (k: string): string => roleName(k, roles[k]);
  $: roleOptions = invitable.map((k) => ({ value: k, label: rname(k) }));
  $: expiryOptions = EXPIRY_PRESETS.map((p) => ({ value: p.id, label: trDynamic(`adminPeople.invites.expiryOptions.${p.id}`) }));
  $: statusOptions = [{ value: '', label: $t('adminPeople.invites.all') }, { value: 'open', label: $t('adminPeople.invites.open') }, { value: 'used', label: $t('adminPeople.invites.used') }, { value: 'expired', label: $t('adminPeople.invites.expired') }];
  $: columns = [
    { key: 'role', sortable: true, label: $t('adminPeople.invites.col.role'), primary: true },
    { key: 'note', sortable: true, label: $t('adminPeople.invites.col.note') },
    { key: 'uses', sortable: false, label: $t('adminPeople.invites.col.uses') },
    { key: 'access', sortable: false, label: $t('adminPeople.invites.col.access') },
    { key: 'validUntil', sortable: true, label: $t('adminPeople.invites.col.validUntil') },
    { key: 'status', sortable: true, label: $t('adminPeople.invites.col.status') },
  ] satisfies Column<I>[];
  const TONE: Record<InviteStatus, Tone> = { open: 'info', used: 'ok', expired: 'muted' };

  // '' (empty number field) = no end; otherwise a whole number in range
  const intOrNull = (v: string | number | null | undefined): number | null => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
  $: maxUsesN = intOrNull(maxUses);
  $: accessDaysN = intOrNull(accessDays);
  $: maxUsesErr = maxUsesN === null || !Number.isInteger(maxUsesN) || maxUsesN < 1 || maxUsesN > 50 ? $t('adminPeople.invites.errMaxUses') : '';
  $: accessDaysErr = accessDaysN !== null && (!Number.isInteger(accessDaysN) || accessDaysN < 1 || accessDaysN > 3650) ? $t('adminPeople.invites.errAccessDays') : '';

  async function create() {
    if (creating || maxUsesErr || accessDaysErr) return;
    creating = true;
    try {
      const hours = EXPIRY_PRESETS.find((p) => p.id === expiry)?.hours ?? 48;
      created = await api<Created>('/api/admin/invites', {
        method: 'POST',
        body: { role, ttlHours: hours, note: note.trim() || undefined, enroll: !hasAccount, maxUses: maxUsesN, accessDays: accessDaysN },
      });
      note = '';
      toast.success(tr('adminPeople.invites.createdToast'));
      page = 0; cur = { ...cur, offset: 0 };
      void load(); void refreshSummary();
    } catch (e) { toast.error(errorText(e), { action: { label: tr('ui.retry'), run: create } }); }
    finally { creating = false; }
  }

  /** takes the row out of the list (an unused invite is deleted); the returned rollback puts it back */
  function withdraw(i: I): () => void {
    const prevRows = rows, prevTotal = total;
    rows = (rows ?? []).filter((x) => x !== i); total = Math.max(0, total - 1);
    return () => { rows = prevRows; total = prevTotal; };
  }
  /** a partly used invite is closed instead (max uses = uses), so the accounts it made stay listed */
  function close(i: I): () => void {
    const prev = i.max_uses;
    i.max_uses = i.uses; rows = rows;
    return () => { i.max_uses = prev; rows = rows; };
  }
  async function revoke(i: I) {
    const ok = await confirm({ title: tr('adminPeople.invites.confirmRevokeTitle'), body: tr('adminPeople.invites.confirmRevokeBody'), danger: true, confirmLabel: tr('adminPeople.invites.revoke') });
    if (!ok) return;
    void runAction({
      key: `inv:${i.id}`, apply: () => (i.uses ? close(i) : withdraw(i)),
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
    if (s === 'used') return [{ id: 'used', label: i.used_by_name && i.max_uses === 1 ? tr('adminPeople.invites.usedBy', { name: i.used_by_name }) : tr('adminPeople.invites.used'), icon: 'check', disabled: true }];
    if (s === 'open') return [{ id: 'revoke', label: $t('adminPeople.invites.revoke'), icon: 'x', danger: true, run: () => revoke(i) }];
    // an expired invite that made accounts stays as their record
    return i.uses ? [] : [{ id: 'remove', label: $t('adminPeople.invites.remove'), icon: 'x', danger: true, run: () => removeExpired(i) }];
  };
  const AUTH: Record<string, TKey> = { ok: 'adminPeople.invites.authOk', failed: 'adminPeople.invites.authFailed', off: 'adminPeople.invites.authOff' };
</script>

<section class="card" aria-labelledby="inv-new">
  <h2 id="inv-new">{$t('adminPeople.invites.newTitle')}</h2>
  <p class="hint">{$t('adminPeople.invites.intro')}</p>
  <form class="form" on:submit|preventDefault={create} novalidate>
    <Select label={$t('adminPeople.invites.role')} options={roleOptions} bind:value={role} />
    <Select label={$t('adminPeople.invites.expiry')} options={expiryOptions} bind:value={expiry} />
    <Field type="number" label={$t('adminPeople.invites.maxUses')} bind:value={maxUses} min={1} max={50} step={1} hint={$t('adminPeople.invites.maxUsesHint')} error={maxUsesErr} />
    <Field type="number" label={$t('adminPeople.invites.accessDays')} bind:value={accessDays} min={1} max={3650} step={1} placeholder={$t('adminPeople.invites.accessUnlimited')} hint={$t('adminPeople.invites.accessDaysHint')} error={accessDaysErr} />
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
  caption={$t('adminPeople.tabs.invites')} {rows} {columns} key={(i) => i.id} {total} {error} pageSize={PAGE}
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
    {:else if col.key === 'uses'}
      {@const label = $t('adminPeople.invites.usesOf', { uses: row.uses, max: row.max_uses })}
      {#if row.uses}
        <details class="uses" on:toggle={(e) => { if (e.currentTarget.open) void loadUses(row); }}>
          <summary title={$t('adminPeople.invites.usesShow')}>{label}<span class="sr-only"> – {$t('adminPeople.invites.usesShow')}</span></summary>
          {#if uses[row.id] === null}<p class="sub">{$t('adminPeople.invites.usesFailed')}</p>
          {:else if uses[row.id] === undefined}<p class="sub">{$t('adminPeople.invites.usesLoading')}</p>
          {:else}
            <ul>{#each uses[row.id] ?? [] as u (u.id)}<li><a href="/admin/users/{u.id}">{u.name}</a></li>{/each}</ul>
          {/if}
        </details>
      {:else}<span class="num">{label}</span>{/if}
    {:else if col.key === 'access'}
      <span class="sub">{row.access_days ? $t('adminPeople.invites.accessDaysN', { n: row.access_days }) : $t('adminPeople.invites.accessUnlimited')}</span>
    {:else if col.key === 'validUntil'}<time datetime={row.expires_at} title={fmtRelative(row.expires_at)}>{fmtDateTime(row.expires_at)}</time>
    {:else if col.key === 'status'}
      {@const s = inviteStatus(row)}
      <span class="stc">
        <StatusPill tone={TONE[s]} label={$t(`adminPeople.invites.${s}`)} icon={s === 'open' ? 'clock' : undefined} />
        {#if s === 'used' && row.max_uses === 1 && row.used_by_name}<span class="sub">{$t('adminPeople.invites.usedBy', { name: row.used_by_name })}</span>{/if}
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
  .num { font-variant-numeric: tabular-nums; }
  .uses summary { cursor: pointer; font-variant-numeric: tabular-nums; min-height: 32px; display: inline-flex; align-items: center; }
  .uses ul { margin: .3rem 0 0; padding-left: 1.1rem; text-align: left; }
  .uses p { margin: .3rem 0 0; }
  .stc { display: inline-flex; flex-direction: column; align-items: flex-end; gap: .15rem; }
  @media (min-width: 721px) { .stc { align-items: flex-start; } }
  time { white-space: nowrap; }
  :global(.dt .bar .field) { min-width: 10rem; }
</style>
