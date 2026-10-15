<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail, profiles tab: kind, last use, PIN; rename inline (the owner profile too) and reset a PIN (with confirm). */
  import { createEventDispatcher, tick } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { avatarBg, initial } from '#lib/avatars';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Field from '#lib/ui/Field.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';
  import type { DetailProfile } from './detail';

  export let userId: string;
  export let profiles: DetailProfile[];
  const dispatch = createEventDispatcher<{ changed: void }>();
  /** the DB limit of a profile name */
  const NAME_MAX = 20;

  let editing: string | null = null, draft = '';
  $: columns = [
    { key: 'name', label: $t('adminPeople.detail.profiles.col.name'), primary: true },
    { key: 'kind', label: $t('adminPeople.detail.profiles.col.kind') },
    { key: 'lastUsed', label: $t('adminPeople.detail.profiles.col.lastUsed') },
    { key: 'pin', label: $t('adminPeople.detail.profiles.col.pin') },
  ] satisfies Column<DetailProfile>[];
  const kind = (p: DetailProfile): string => (p.isOwner ? tr('adminPeople.detail.profiles.owner')
    : p.kids ? (p.maxRating ? tr('adminPeople.detail.profiles.kidsMax', { rating: p.maxRating }) : tr('adminPeople.detail.profiles.kids')) : tr('adminPeople.detail.profiles.regular'));
  const key = (p: DetailProfile) => `profile:${p.id}`;

  async function edit(p: DetailProfile) {
    editing = p.id; draft = p.name;
    await tick();
    document.getElementById(`udp-name-${p.id}`)?.focus();
  }
  const update = (p: DetailProfile, body: Record<string, unknown>) => () =>
    api<{ profile: { name: string; hasPin: boolean } }>(`/api/admin/users/${userId}/profiles/${p.id}`, { method: 'PATCH', body });
  const nameError = (e: unknown): string => (e instanceof ApiError && e.status === 409 ? tr('adminPeople.detail.profiles.nameTaken') : errorText(e));

  async function save(p: DetailProfile) {
    const name = draft.trim();
    if (!name || name === p.name) { editing = null; return; }
    const r = await runAction({ key: key(p), run: update(p, { name }), error: nameError, success: (res) => tr('adminPeople.detail.profiles.renamed', { name: res?.profile.name ?? name }) });
    if (r.ok) { editing = null; dispatch('changed'); }
  }
  async function resetPin(p: DetailProfile) {
    const ok = await confirm({
      title: tr('adminPeople.detail.profiles.resetPinTitle', { name: p.name }), body: tr('adminPeople.detail.profiles.resetPinBody'),
      danger: true, confirmLabel: tr('adminPeople.detail.profiles.resetPin'),
    });
    if (!ok) return;
    const r = await runAction({ key: key(p), run: update(p, { resetPin: true }), success: tr('adminPeople.detail.profiles.pinReset', { name: p.name }) });
    if (r.ok) dispatch('changed');
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); editing = null; } }
</script>

<DataTable caption={$t('adminPeople.detail.tabs.profiles')} rows={profiles} {columns} key={(p) => p.id} pageSize={0} busyKey={key} emptyText={$t('adminPeople.detail.profiles.empty')}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      {#if editing === row.id}
        <form class="ren" on:submit|preventDefault={() => save(row)}>
          <Field id="udp-name-{row.id}" label={$t('adminPeople.detail.profiles.newName')} bind:value={draft} maxlength={NAME_MAX} hideLabel required on:keydown={onKey} />
          <Button type="submit" size="sm" disabled={$busyKeys.has(key(row))}>{$t('adminPeople.detail.profiles.save')}</Button>
          <Button variant="ghost" size="sm" on:click={() => (editing = null)}>{$t('adminPeople.detail.profiles.cancel')}</Button>
        </form>
      {:else}
        <span class="who">
          <span class="av" style:background={avatarBg(row.avatar ?? undefined)} aria-hidden="true">{initial(row.name)}</span>
          <span class="n">{row.name}</span>
          <span class="acts">
            <Button variant="ghost" size="sm" aria-label={$t('adminPeople.detail.profiles.rename', { name: row.name })} on:click={() => edit(row)}>{$t('adminPeople.detail.profiles.renameShort')}</Button>
            {#if row.hasPin}<Button variant="ghost" size="sm" icon="key" aria-label={$t('adminPeople.detail.profiles.resetPinFor', { name: row.name })} on:click={() => resetPin(row)}>{$t('adminPeople.detail.profiles.resetPin')}</Button>{/if}
          </span>
        </span>
      {/if}
    {:else if col.key === 'kind'}{kind(row)}
    {:else if col.key === 'lastUsed'}
      {#if row.lastUsed}<time datetime={row.lastUsed} title={fmtDateTime(row.lastUsed)}>{fmtRelative(row.lastUsed)}</time>{:else}<span class="sub">{$t('adminPeople.never')}</span>{/if}
    {:else if col.key === 'pin'}
      {#if row.hasPin}<StatusPill tone="info" icon="lock" label={$t('adminPeople.detail.profiles.hasPin')} />{:else}<span class="sub">{$t('adminPeople.detail.profiles.noPin')}</span>{/if}
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .who { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .7rem; min-width: 0; }
  .av { width: 30px; height: 30px; flex: none; border-radius: 6px; display: grid; place-items: center; font-weight: 800; font-size: .9rem; color: #fff; }
  .n { font-weight: 600; overflow-wrap: anywhere; }
  .acts { display: inline-flex; flex-wrap: wrap; gap: .3rem; font-weight: 400; }
  .ren { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .ren :global(.field) { flex: 1 1 10rem; max-width: 16rem; }
  .sub { color: var(--mut); font-size: .85rem; }
  time { white-space: nowrap; }
</style>
