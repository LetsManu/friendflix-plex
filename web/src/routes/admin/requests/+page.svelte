<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t, hasKey, trDynamic } from '#lib/i18n';
  let list: any[] = [], filter = 'pending';
  const load = async () => (list = (await api(`/api/admin/requests?filter=${filter}`)).requests);
  onMount(load);
  async function act(id: number, action: 'approve' | 'decline') { await api(`/api/admin/requests/${id}/${action}`, { method: 'POST' }); load(); }
  const statusLabel = (s: string) => (hasKey(`social.requests.status.${s}`) ? trDynamic(`social.requests.status.${s}`) : s);
</script>
<div class="flex"><select bind:value={filter} on:change={load}><option value="pending">{$t('admin.requests.filter.pending')}</option><option value="approved">{$t('admin.requests.filter.approved')}</option><option value="processing">{$t('admin.requests.filter.processing')}</option><option value="available">{$t('admin.requests.filter.available')}</option><option value="all">{$t('admin.requests.filter.all')}</option></select></div>
<table style="margin-top:1rem">
  <thead><tr><th>{$t('admin.requests.title')}</th><th>{$t('admin.requests.from')}</th><th>{$t('admin.requests.type')}</th><th>{$t('admin.requests.status')}</th><th></th></tr></thead>
  <tbody>{#each list as r}<tr><td>{r.title}</td><td>{r.requestedBy}</td><td>{r.mediaType === 'tv' ? $t('admin.kind.series') : $t('admin.kind.movie')}</td><td>{statusLabel(r.status)}</td>
    <td class="flex">{#if r.status === 'angefragt'}<button on:click={() => act(r.id, 'approve')}>{$t('admin.approve')}</button><button class="sec" on:click={() => act(r.id, 'decline')}>{$t('admin.decline')}</button>{/if}</td></tr>{/each}</tbody>
</table>
