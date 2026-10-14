<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Admin → Wochenrückblick: weekly summary for every account (weekday, hour, on/off) + a test send. */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDate, fmtDateTime, t, tr } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';

  interface Digest { enabled: boolean; day: number; hour: number; source: 'config' | 'admin'; lastRun: { week: string; sentAt: string; count: number } | null }
  /** weekday names (0 = Sunday) in the UI language; 7 Jan 2024 was a Sunday */
  $: days = Array.from({ length: 7 }, (_, i) => ({ value: String(i), label: fmtDate(new Date(2024, 0, 7 + i), { weekday: 'long' }) }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

  let saved: Digest | null = null, loadFailed = false;
  let enabled = true, day = '0', hour = '18';
  $: dirty = Boolean(saved) && (enabled !== saved!.enabled || Number(day) !== saved!.day || Number(hour) !== saved!.hour);
  $: saving = $busyKeys.has('digest:save');

  function apply(r: Digest) { saved = r; enabled = r.enabled; day = String(r.day); hour = String(r.hour); }
  async function load() {
    loadFailed = false;
    try { apply(await api<Digest>('/api/admin/digest')); } catch { loadFailed = true; }
  }
  onMount(load);

  async function save() {
    const res = await runAction({
      key: 'digest:save', run: () => api<Digest>('/api/admin/digest', { method: 'PUT', body: { enabled, day: Number(day), hour: Number(hour) } }),
      success: tr('admin.digest.saved'), error: tr('common.saveFailed'),
    });
    if (res.ok && res.value) apply(res.value);
  }
  const reset = () => { if (saved) apply(saved); };
  function test() {
    void runAction({
      key: 'digest:test', run: () => api<{ sent: number; data?: unknown }>('/api/admin/digest/test', { method: 'POST' }),
      success: (r) => (r?.sent ? tr('admin.digest.sent') : r?.data ? tr('admin.digest.duplicate') : tr('admin.digest.nothing')),
      error: tr('admin.digest.sendFailed'),
    });
  }
</script>

<div class="wrap">
  <p class="intro muted">{$t('admin.digest.intro')}</p>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('admin.digest.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !saved}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="2rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {:else}
    <AdminCard title={$t('adminContent.digest.settings')}>
      <form on:submit|preventDefault={save}>
        <Toggle label={$t('admin.digest.enabled')} bind:checked={enabled} />
        <div class="grid">
          <Select label={$t('admin.digest.weekday')} bind:value={day} options={days} disabled={!enabled} />
          <Select label={$t('admin.digest.time')} bind:value={hour} options={hours} disabled={!enabled} hint={$t('adminContent.digest.serverTime')} />
        </div>
        <p class="muted small">
          {$t('admin.digest.source', { source: saved.source === 'admin' ? $t('admin.digest.sourceAdmin') : $t('admin.digest.sourceConfig') })}
          {#if saved.lastRun}{$t('admin.digest.lastRun', { week: saved.lastRun.week, n: saved.lastRun.count, date: fmtDateTime(saved.lastRun.sentAt) })}{:else}{$t('admin.digest.neverSent')}{/if}
        </p>
        <div class="btns">
          <Button type="submit" icon="check" pending={saving} disabled={!dirty}>{$t('common.save')}</Button>
          <Button variant="ghost" disabled={!dirty || saving} on:click={reset}>{$t('adminContent.digest.discard')}</Button>
          {#if dirty}<span class="muted small" role="status">{$t('adminContent.digest.unsaved')}</span>{/if}
        </div>
      </form>
    </AdminCard>
    <AdminCard title={$t('adminContent.digest.testTitle')} description={$t('adminContent.digest.testHint')}>
      <Button variant="secondary" icon="send" pending={$busyKeys.has('digest:test')} on:click={test}>{$t('admin.digest.test')}</Button>
    </AdminCard>
  {/if}
</div>

<style>
  .wrap { max-width: 640px; }
  .intro { margin: 0 0 1rem; }
  form { display: grid; gap: 1.1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: .9rem; }
  .small { font-size: .85rem; margin: 0; }
  .btns { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .sk { display: grid; gap: 1rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
