<script lang="ts">
  import { pageStore } from '#lib/page';
  import { t, type TKey } from '#lib/i18n';
  const page = pageStore();
  const tabs: Array<[string, TKey]> = [['/admin', 'admin.tabs.users'], ['/admin/status', 'admin.tabs.status'], ['/admin/previews', 'admin.tabs.previews'], ['/admin/playback', 'admin.tabs.playback'], ['/admin/digest', 'admin.tabs.digest'], ['/admin/invites', 'admin.tabs.invites'], ['/admin/requests', 'admin.tabs.requests'], ['/admin/polls', 'admin.tabs.polls'], ['/admin/lists', 'admin.tabs.lists'], ['/admin/roles', 'admin.tabs.roles'], ['/admin/devices', 'admin.tabs.devices'], ['/admin/audit', 'admin.tabs.audit'], ['/admin/update', 'admin.tabs.update']];
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('admin.title') })}</title></svelte:head>
<h1>{$t('admin.title')}</h1>
<div class="flex" style="margin-bottom:1rem">
  {#each tabs as [href, label]}<a {href} class="btn" class:sec={$page.url.pathname !== href}>{$t(label)}</a>{/each}
</div>
<slot />
