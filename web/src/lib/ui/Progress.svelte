<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Styled progress bar (role=progressbar). value=null → indeterminate.
   *   <Progress value={done} max={total} label={$t('…')} showValue />
   */
  import { fmtNumber, t } from '#lib/i18n';
  export let value: number | null = null;
  export let max = 100;
  export let label = '';
  /** show "42 %" next to the label */
  export let showValue = false;
  export let tone: 'acc' | 'ok' | 'warn' | 'err' = 'acc';
  $: pct = value === null || !max ? null : Math.max(0, Math.min(100, (value / max) * 100));
</script>

<div class="prog">
  {#if label || showValue}<div class="top"><span class="lbl">{label}</span>{#if showValue && pct !== null}<span class="val">{$t('ui.percent', { n: fmtNumber(Math.round(pct)) })}</span>{/if}</div>{/if}
  <div class="track {tone}" role="progressbar" aria-label={label || undefined} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined} aria-busy={pct === null ? 'true' : undefined}>
    <i class:indet={pct === null} style={pct === null ? undefined : `width:${pct}%`}></i>
  </div>
</div>

<style>
  .prog { display: grid; gap: .3rem; min-width: 0; }
  .top { display: flex; justify-content: space-between; gap: .5rem; font-size: .85rem; color: var(--mut); }
  .val { font-variant-numeric: tabular-nums; color: var(--fg); }
  .track { height: 6px; background: #323a43; border-radius: 99px; overflow: hidden; position: relative; }
  i { display: block; height: 100%; border-radius: inherit; background: var(--acc); transition: width var(--t-med) var(--ease); }
  .ok i { background: var(--ok); } .warn i { background: var(--warn); } .err i { background: var(--err); }
  i.indet { width: 35%; animation: ff-indet 1.2s ease-in-out infinite; }
  @keyframes ff-indet { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
  @media (prefers-reduced-motion: reduce) { i.indet { width: 100%; opacity: .5; animation: none; } }
</style>
