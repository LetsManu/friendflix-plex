<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { pageStore } from '#lib/page';
  import type { Item } from '#lib/api';
  import DetailView from '#lib/detail/DetailView.svelte';
  import { t } from '#lib/i18n';
  const page = pageStore();

  let item: Item | null = null;
  $: id = $page.params.id ?? '';
</script>

<svelte:head><title>{$t('common.pageTitle', { page: item?.name ?? $t('detail.view.pageTitle') })}</title></svelte:head>
{#if id}<DetailView {id} variant="page" bind:item />{/if}
