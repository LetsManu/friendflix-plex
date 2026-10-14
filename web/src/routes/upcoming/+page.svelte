<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import UpcomingRow from '#lib/UpcomingRow.svelte';
  import { t } from '#lib/i18n';
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('social.upcoming.title') })}</title></svelte:head>
<h1>{$t('social.upcoming.title')}</h1>
<p class="muted">{$t('social.upcoming.intro')}</p>
<div class="bleed"><UpcomingRow type="movie" title={$t('social.upcoming.movies')} /><UpcomingRow type="tv" title={$t('social.upcoming.series')} /></div>
<style>.bleed { margin: 0 calc(var(--pad-x) * -1); }</style>
