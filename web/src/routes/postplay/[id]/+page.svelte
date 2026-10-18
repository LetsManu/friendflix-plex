<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** 1.1 post-play screen without the player: TV mode, phones, deep links, the detail page after the last episode. */
  import { pageStore } from '#lib/page';
  import PostPlay from '#lib/PostPlay.svelte';
  import { features } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  const page = pageStore();
  $: id = $page.params.id!;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('postplay.pageTitle') })}</title></svelte:head>
{#if $features.postplay}
  {#key id}<PostPlay itemId={id} variant="page" />{/key}
{:else}
  <p class="muted pad">{$t('postplay.empty')}</p>
{/if}

<style>.pad { padding: 2rem var(--pad-x, 1rem); }</style>
