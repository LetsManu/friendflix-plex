<script lang="ts">
  import { t, tr, fmtDate, fmtDateTime } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  /** weekday names (0 = Sunday) in the UI language; 7 Jan 2024 was a Sunday */
  const DAYS = Array.from({ length: 7 }, (_, i) => fmtDate(new Date(2024, 0, 7 + i), { weekday: 'long' }));
  let s: { enabled: boolean; day: number; hour: number; source: 'config' | 'admin'; lastRun: { week: string; sentAt: string; count: number } | null } | null = null;
  let busy = false, msg = '', err = '';
  const apply = (r: NonNullable<typeof s>) => (s = r);
  onMount(() => { api('/api/admin/digest').then(apply).catch(() => (err = tr('admin.digest.loadFailed'))); });
  async function save() {
    if (!s) return;
    busy = true; msg = ''; err = '';
    try { apply(await api('/api/admin/digest', { method: 'PUT', body: { enabled: s.enabled, day: Number(s.day), hour: Number(s.hour) } })); msg = tr('admin.digest.saved'); } catch { err = tr('common.saveFailed'); }
    busy = false;
  }
  async function test() {
    busy = true; msg = ''; err = '';
    try {
      const r = await api('/api/admin/digest/test', { method: 'POST' });
      msg = r.sent ? tr('admin.digest.sent') : r.data ? tr('admin.digest.duplicate') : tr('admin.digest.nothing');
    } catch { err = tr('admin.digest.sendFailed'); }
    busy = false;
  }
</script>
<svelte:head><title>{$t('admin.digest.pageTitle')}</title></svelte:head>
<p class="muted">{$t('admin.digest.intro')}</p>
{#if s}
  <form class="panel form" on:submit|preventDefault={save}>
    <label class="row"><input type="checkbox" bind:checked={s.enabled} /><span><b>{$t('admin.digest.enabled')}</b></span></label>
    <div class="grid">
      <label>{$t('admin.digest.weekday')}<select bind:value={s.day}>{#each DAYS as d, i}<option value={i}>{d}</option>{/each}</select></label>
      <label>{$t('admin.digest.time')}<select bind:value={s.hour}>{#each Array(24) as _, h}<option value={h}>{String(h).padStart(2, '0')}:00</option>{/each}</select></label>
    </div>
    <small class="muted">{$t('admin.digest.source', { source: s.source === 'admin' ? $t('admin.digest.sourceAdmin') : $t('admin.digest.sourceConfig') })}
      {#if s.lastRun}{$t('admin.digest.lastRun', { week: s.lastRun.week, n: s.lastRun.count, date: fmtDateTime(s.lastRun.sentAt) })}{:else}{$t('admin.digest.neverSent')}{/if}</small>
    <div class="flex">
      <button disabled={busy}>{$t('common.save')}</button>
      <button type="button" class="sec" disabled={busy} on:click={test}>{$t('admin.digest.test')}</button>
      {#if msg}<span class="ok" role="status">{msg}</span>{/if}{#if err}<span class="err" role="alert">{err}</span>{/if}
    </div>
  </form>
{:else if err}<p class="err" role="alert">{err}</p>{/if}
<style>
  .form { max-width: 560px; display: grid; gap: 1.1rem; }
  .row { display: flex; gap: .8rem; align-items: center; color: var(--fg); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .8rem; } .grid label { display: grid; gap: .3rem; font-size: .9rem; }
  small { font-size: .85rem; }
</style>
