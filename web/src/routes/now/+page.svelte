<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, img } from '#lib/api';
  import { t } from '#lib/i18n';
  let items: any[] = [], timer: ReturnType<typeof setInterval>;
  const load = async () => (items = (await api('/api/nowplaying')).items);
  onMount(() => { load(); timer = setInterval(load, 5000); });
  onDestroy(() => clearInterval(timer));
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('social.now.title') })}</title></svelte:head>
<h1>{$t('social.now.title')}</h1>
{#if !items.length}<p class="muted">{$t('social.now.empty')}</p>{/if}
<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
  {#each items as i}
    <div class="panel"><div class="flex"><img src={img(i.itemId, 120)} alt="" style="width:60px;border-radius:4px" />
      <div><b>{i.user}</b><br />{i.seriesName ? i.seriesName + ' – ' : ''}{i.title}<br /><span class="muted">{i.isPaused ? $t('social.now.paused') : $t('social.now.playing')}</span></div></div>
      {#if i.runtimeTicks}<div class="bar" style="margin-top:.6rem"><i style="width:{Math.min(100, (i.positionTicks / i.runtimeTicks) * 100)}%"></i></div>{/if}</div>
  {/each}
</div>
