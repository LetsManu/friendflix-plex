<script lang="ts">
  import { fmtDateTime, t, tr } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  interface Dev { id: string; label: string; approved: boolean; current: boolean; last_seen: string }
  let devices: Dev[] = [], me: { deviceApproved: boolean } | null = null, msg = '', err = '', busy = '';
  const load = async () => { devices = (await api('/api/devices')).devices; };
  onMount(() => {
    void load();
    api('/api/me').then((m) => (me = m)).catch(() => undefined);
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000); // a newly signed-in device shows up by itself
    return () => clearInterval(t);
  });
  $: pending = devices.filter((d) => !d.approved && !d.current);
  $: others = devices.filter((d) => d.approved || d.current);
  async function approve(d: Dev) {
    busy = d.id; err = ''; msg = '';
    try { await api(`/api/devices/${d.id}/approve`, { method: 'POST' }); msg = tr('account.devices.approved', { name: d.label }); }
    catch (e) {
      err = e instanceof ApiError && e.status === 403
        ? tr('account.devices.approveForbidden')
        : tr('account.devices.approveFailed');
    } finally { busy = ''; await load(); }
  }
  async function revokeOthers() { const r = await api('/api/sessions/revoke-others', { method: 'POST' }); msg = tr('account.devices.revoked', { n: Number(r.revoked) }); }
  async function remove(d: Dev) { if (!confirm(tr('account.devices.confirmRemove', { name: d.label }))) return; await api(`/api/devices/${d.id}`, { method: 'DELETE' }); await load(); }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.devices.pageTitle') })}</title></svelte:head>
<h1>{$t('account.devices.title')}</h1>

<section class="panel how" aria-label={$t('account.devices.addAria')}>
  <h2>{$t('account.devices.addTitle')}</h2>
  <ol>
    <li>{$t('account.devices.step1')}</li>
    <li><Rich text={$t('account.devices.step2')} /></li>
    <li><Rich text={$t('account.devices.step3')} /></li>
  </ol>
  {#if me && !me.deviceApproved}<p class="warn">{$t('account.devices.notApprovedSelf')}</p>{/if}
</section>

{#if msg}<p class="ok" role="status">{msg}</p>{/if}
{#if err}<p class="err" role="alert">{err}</p>{/if}

{#if pending.length}
  <section class="panel waiting" aria-label={$t('account.devices.waitingAria')}>
    <h2>{$t('account.devices.waiting', { n: pending.length })}</h2>
    {#each pending as d (d.id)}
      <div class="flex row">
        <div><b>{d.label}</b><div class="muted">{$t('account.devices.lastSeenAt', { when: fmtDateTime(d.last_seen) })}</div></div>
        <span class="sp"></span>
        <button disabled={busy === d.id} on:click={() => approve(d)}>{busy === d.id ? $t('account.devices.approving') : $t('account.devices.approve')}</button>
        <button class="sec" on:click={() => remove(d)}>{$t('account.devices.reject')}</button>
      </div>
    {/each}
  </section>
{:else}
  <p class="muted">{$t('account.devices.noneWaiting')}</p>
{/if}

<h2>{$t('account.devices.approvedTitle')}</h2>
<p><button class="sec" on:click={revokeOthers}>{$t('account.devices.revokeOthers')}</button></p>
<table>
  <thead><tr><th>{$t('account.devices.device')}</th><th>{$t('account.devices.lastSeen')}</th><th></th></tr></thead>
  <tbody>
    {#each others as d (d.id)}
      <tr>
        <td>{d.label} {#if d.current}<span class="badge">{$t('account.devices.thisDevice')}</span>{/if}</td>
        <td>{fmtDateTime(d.last_seen)}</td>
        <td>{#if !d.current}<button class="sec" on:click={() => remove(d)}>{$t('account.devices.remove')}</button>{/if}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .how ol { margin: .3rem 0 0; padding-left: 1.3rem; display: grid; gap: .3rem; color: var(--mut); } .how b { color: var(--fg); }
  .waiting { border-color: var(--warn); }
  .row { padding: .5rem 0; border-top: 1px solid var(--line); } .row:first-of-type { border-top: 0; }
  .sp { flex: 1; }
  h2 { font-size: 1.15rem; }
</style>
