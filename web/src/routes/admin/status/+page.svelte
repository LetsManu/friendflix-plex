<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t } from '#lib/i18n';
  let s: any = null;
  onMount(async () => (s = await api('/api/admin/status')));
</script>
{#if s}
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
    {#each [[$t('admin.status.users'), s.users], [$t('admin.status.activeStreams'), s.activeStreams], [$t('admin.status.partyRooms'), s.partyRooms], [$t('admin.status.openInvites'), s.openInvites], [$t('admin.status.pendingDevices'), s.pendingDevices], [$t('admin.status.pendingPolls'), s.pendingPolls]] as [l, v]}
      <div class="panel"><h2>{v}</h2><span class="muted">{l}</span></div>{/each}
    <div class="panel"><h2 class={s.jellyfin ? 'ok' : 'err'}>{s.jellyfin ? $t('admin.status.ok') : $t('admin.status.error')}</h2><span class="muted">{$t('admin.status.jellyfin')}</span></div>
  </div>
{/if}
