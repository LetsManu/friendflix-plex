<script lang="ts">
  import { t, fmtDateTime } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  let entries: any[] = [];
  onMount(async () => (entries = (await api('/api/admin/audit?limit=200')).entries));
</script>
<table>
  <thead><tr><th>{$t('admin.audit.time')}</th><th>{$t('admin.audit.who')}</th><th>{$t('admin.audit.action')}</th><th>{$t('admin.audit.details')}</th></tr></thead>
  <tbody>{#each entries as e}<tr><td>{fmtDateTime(e.at)}</td><td>{e.actor ?? $t('admin.audit.system')}</td><td>{e.action}</td><td class="muted">{JSON.stringify(e.meta)}</td></tr>{/each}</tbody>
</table>
