<script lang="ts">
  import { t, fmtDateTime } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  let devices: any[] = [];
  const load = async () => (devices = (await api('/api/admin/devices')).devices);
  onMount(load);
  async function approve(d: any) { await api('/api/admin/devices/approve', { method: 'POST', body: { userId: d.user_id, deviceId: d.device_id } }); load(); }
</script>
<table>
  <thead><tr><th>{$t('admin.devices.user')}</th><th>{$t('admin.devices.device')}</th><th>{$t('admin.devices.lastSeen')}</th><th>{$t('admin.devices.status')}</th><th></th></tr></thead>
  <tbody>{#each devices as d}<tr><td>{d.name}</td><td>{d.label}</td><td>{fmtDateTime(d.last_seen)}</td>
    <td>{#if d.approved}<span class="ok">{$t('admin.devices.ok')}</span>{:else}<span class="warn">{$t('admin.devices.waiting')}</span>{/if}</td><td>{#if !d.approved}<button on:click={() => approve(d)}>{$t('admin.approve')}</button>{/if}</td></tr>{/each}</tbody>
</table>
