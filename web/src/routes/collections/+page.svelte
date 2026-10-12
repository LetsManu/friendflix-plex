<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { t } from '#lib/i18n';

  let items: Item[] | null = null, studios: string[] = [];
  onMount(() => { api('/api/library/collections').then((r) => { items = r.items; studios = r.studios; }).catch(() => (items = [])); });
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('home.collections.pageTitle') })}</title></svelte:head>
<h1>{$t('home.collections.title')}</h1>
{#if studios.length}
  <h2>{$t('home.collections.studios')}</h2>
  <div class="chips">{#each studios as s}<a class="chip" href="/browse/movies?studio={encodeURIComponent(s)}">{s}</a>{/each}</div>
{/if}
<h2>{$t('home.collections.collections')}</h2>
{#if items === null}<div class="tiles">{#each Array(6) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if !items.length}<p class="muted">{$t('home.collections.empty')}</p>
{:else}<div class="tiles">{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>{/if}
<style>.chips { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; } .chip { background: var(--surface-2); padding: .5rem 1rem; border-radius: 99px; min-height: 44px; display: inline-flex; align-items: center; } .chip:hover { background: #3a3a3a; }</style>
