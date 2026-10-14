<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { t } from '#lib/i18n';
  let items: Item[] | null = null;
  onMount(() => { api('/api/library/items?filter=favorites&types=Movie,Series,Episode&limit=200').then((r) => r.items).then((r: Item[]) => (items = r)).catch(() => (items = [])); });
  /** un-favouriting through a card takes it off this page */
  const unfav = (e: CustomEvent<{ item: Item; favorite: boolean }>) => { if (!e.detail.favorite) items = (items ?? []).filter((x) => x.id !== e.detail.item.id); };
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('social.favorites.title') })}</title></svelte:head>
<h1>{$t('social.favorites.title')}</h1>
{#if items === null}<div class="tiles">{#each Array(8) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if !items.length}<p class="muted">{$t('social.favorites.empty')}</p>
{:else}<div class="tiles">{#each items as i (i.id)}<div class="slot"><Card item={i} on:favchange={unfav} /></div>{/each}</div>{/if}
