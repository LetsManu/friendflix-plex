<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t, type TKey } from '#lib/i18n';

  /** true = the original file plays directly; otherwise `label` is the rung ("720p") and `reason` the server's transcodeReason */
  export let direct = false;
  export let label = '';
  export let reason = 'other';
  export let open = false;
  /** phone top bar: a 44 px tall tap target around the small pill, the explanation opens below it, right-aligned */
  export let compact = false;
  const REASONS = {
    network: 'player.quality.reasonNetwork', remoteCap: 'player.quality.reasonRemoteCap', roleCap: 'player.quality.reasonRoleCap', container: 'player.quality.reasonContainer',
    videoCodec: 'player.quality.reasonVideoCodec', audioCodec: 'player.quality.reasonAudioCodec', audioTrack: 'player.quality.reasonAudioTrack', subtitles: 'player.quality.reasonSubtitles',
    height: 'player.quality.reasonHeight', manual: 'player.quality.reasonManual', other: 'player.quality.reasonOther',
  } as const satisfies Record<string, TKey>;
  const reasonKey = (r: string): TKey => (r in REASONS ? REASONS[r as keyof typeof REASONS] : REASONS.other);
</script>

<svelte:window on:pointerdown={() => (open = false)} />
<span class="chipwrap" class:compact>
  <button type="button" class="chip" title={$t('player.quality.chipLabel')} aria-expanded={open} on:pointerdown|stopPropagation on:click={() => (open = !open)}>
    {#if compact}<span class="pill">{direct ? $t('player.quality.chipOriginal') : $t('player.quality.chipConverted', { q: label })}</span>{:else}{direct ? $t('player.quality.chipOriginal') : $t('player.quality.chipConverted', { q: label })}{/if}
  </button>
  {#if open}
    <span class="why" role="status">{direct ? $t('player.quality.directInfo') : $t(reasonKey(reason))}</span>
  {/if}
</span>

<style>
  .chipwrap { position: relative; display: inline-flex; margin-left: .6rem; }
  .chip { background: rgba(255, 255, 255, .14); color: #e8e8e8; border: 0; border-radius: 999px; padding: .2rem .7rem; font-size: .8rem; line-height: 1.3; cursor: pointer; white-space: nowrap; min-height: 28px; }
  .chip:hover { background: rgba(255, 255, 255, .24); }
  .chip:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .why { position: absolute; left: 0; bottom: calc(100% + .5rem); width: max-content; max-width: min(18rem, 80vw); background: rgba(20, 20, 24, .96); color: #fff; border-radius: 8px; padding: .5rem .75rem; font-size: .85rem; line-height: 1.35; box-shadow: 0 4px 18px rgba(0, 0, 0, .5); }
  :global(html.tv) .chip { font-size: 1.05rem; min-height: 48px; padding: .3rem 1rem; }
  :global(html.tv) .chip:focus-visible { background: rgba(255, 255, 255, .22); box-shadow: 0 0 0 4px #fff; outline: none; }
  :global(html.tv) .why { font-size: 1.1rem; }
  .chipwrap.compact { margin-left: 0; }
  .compact .chip, .compact .chip:hover { background: transparent; padding: 0; min-height: 44px; min-width: 44px; display: inline-grid; place-items: center; font-size: .75rem; }
  .pill { display: block; background: rgba(255, 255, 255, .16); border-radius: 999px; padding: .2rem .6rem; line-height: 1.3; }
  .compact .chip:hover .pill { background: rgba(255, 255, 255, .26); }
  .compact .why { left: auto; right: 0; bottom: auto; top: calc(100% + .25rem); z-index: 9; }
  @media (max-width: 720px) { .chipwrap { margin-left: .2rem; } .chip { font-size: .72rem; padding: .15rem .55rem; } }
</style>
