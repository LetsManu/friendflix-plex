<script lang="ts">
  import { qualityChips } from '#lib/badges';
  import type { MediaTraits } from '#lib/fresh';
  import { t } from '#lib/i18n';

  /** Quality chips (4K / HD, HDR / Dolby Vision, Dolby Atmos / Surround / Stereo) from the media streams; renders nothing without traits. */
  export let traits: MediaTraits | null | undefined = null;
  $: chips = qualityChips(traits);
</script>

{#if chips.length}
  <ul class="qc" aria-label={$t('fresh.q.label')}>
    {#each chips as c (c.id)}<li>{$t(c.key)}</li>{/each}
  </ul>
{/if}

<style>
  .qc { display: flex; flex-wrap: wrap; gap: .3rem; list-style: none; margin: .55rem 0 0; padding: 0; }
  li { padding: 0 .4rem; line-height: 1.4; border: 1px solid rgba(255, 255, 255, .45); border-radius: 3px; font-size: .68rem; font-weight: 700; letter-spacing: .03em; color: #e6e6e6; white-space: nowrap; }
</style>
