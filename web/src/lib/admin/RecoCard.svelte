<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin overview card (R4): click rate and play rate per recommendation engine, from GET /api/admin/reco (the server's counters).
   * Click rate = clicks / rows shown, play rate = plays / rows shown. Numbers only, no titles or users. Below: which engine is active,
   * whether the environment locks it (RECO_ENGINE in .env), and a link to Admin → Settings, group recommendations, to change it.
   */
  import { onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { api } from '#lib/api';
  import { fmtDateTime, fmtNumber, locale, t } from '#lib/i18n';
  import Skeleton from '#lib/ui/Skeleton.svelte';

  interface EngineStats { impressions: number; clicks: number; plays: number; dismisses: number; ctr: number | null; playRate: number | null }
  /** locked: RECO_ENGINE comes from the environment (older backends send no flag: treated as not locked) */
  interface RecoStats { engine: 'v1' | 'v2' | 'shadow'; locked?: boolean; engines: { v1: EngineStats; v2: EngineStats }; fallbacks: number; since: string }
  let stats: RecoStats | null = null, failed = false;
  onMount(() => { api<RecoStats>('/api/admin/reco').then((s) => (stats = s), () => (failed = true)); });
  $: pct = (v: number | null) => (v === null ? $t('reco.admin.empty') : new Intl.NumberFormat($locale, { style: 'percent', maximumFractionDigits: 1 }).format(v));
  const ENGINES = ['v1', 'v2'] as const;
  /** the settings group of the engine (Admin → Settings scrolls to it) */
  const SETTINGS_HREF = '/admin/settings#settings-recommendations';
</script>

<section class="card" aria-labelledby="dash-reco" data-testid="reco-card">
  <div class="ch">
    <h2 id="dash-reco">{$t('reco.admin.title')}</h2>
    {#if stats}<span class="muted small">{$t('reco.admin.active', { engine: $t(`reco.admin.engine.${stats.engine}`) })}</span>{/if}
  </div>
  {#if failed}<p class="muted">{$t('reco.admin.loadFailed')}</p>
  {:else if !stats}<Skeleton lines={3} h="1.1rem" />
  {:else}
    <div class="scroll">
      <table>
        <thead><tr>
          <th scope="col">{$t('reco.admin.col.engine')}</th><th scope="col">{$t('reco.admin.col.shown')}</th><th scope="col">{$t('reco.admin.col.clicks')}</th>
          <th scope="col">{$t('reco.admin.col.plays')}</th><th scope="col">{$t('reco.admin.col.dismissed')}</th><th scope="col">{$t('reco.admin.col.ctr')}</th><th scope="col">{$t('reco.admin.col.playRate')}</th>
        </tr></thead>
        <tbody>
          {#each ENGINES as e (e)}
            {@const x = stats.engines[e]}
            <tr data-engine={e}>
              <th scope="row">{$t(`reco.admin.engine.${e}`)}</th>
              <td>{fmtNumber(x.impressions)}</td><td>{fmtNumber(x.clicks)}</td><td>{fmtNumber(x.plays)}</td><td>{fmtNumber(x.dismisses)}</td>
              <td class="ctr">{pct(x.ctr)}</td><td class="pr">{pct(x.playRate)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted small">{$t('reco.admin.fallbacks', { n: fmtNumber(stats.fallbacks) })} · {$t('reco.admin.since', { date: fmtDateTime(stats.since) })}</p>
    <p class="muted small">{$t('reco.admin.intro')}</p>
    <div class="engine" data-testid="reco-engine">
      <p class="small">
        {#if stats.locked}<Icon name="lock" size={14} />{/if}
        {$t('reco.admin.activeLine', { engine: $t(`reco.admin.engine.${stats.engine}`), source: $t(stats.locked ? 'reco.admin.source.env' : 'reco.admin.source.db') })}
      </p>
      <a class="change" href={SETTINGS_HREF} data-testid="reco-change">{$t('reco.admin.change')}<Icon name="chevron-right" size={16} /></a>
    </div>
  {/if}
</section>

<style>
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; min-width: 0; margin-bottom: 1rem; }
  .card h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  .ch { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; margin-bottom: .8rem; flex-wrap: wrap; }
  .small { font-size: .85rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 30rem; font-variant-numeric: tabular-nums; }
  th, td { padding: .45rem .6rem; text-align: right; border-bottom: 1px solid rgba(255, 255, 255, .06); }
  th:first-child { text-align: left; }
  thead th { font-size: .8rem; color: var(--mut); font-weight: 600; }
  tbody th { font-weight: 600; }
  .ctr, .pr { font-weight: 800; }
  .engine { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem 1rem; padding-top: .7rem; margin-top: .4rem; border-top: 1px solid var(--line); }
  .engine p { margin: 0; flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
  .engine :global(svg) { flex: none; }
  .change { display: inline-flex; align-items: center; gap: .2rem; font-size: .9rem; font-weight: 600; color: var(--acc); min-height: 44px; }
  .change:hover, .change:focus-visible { text-decoration: underline; }
</style>
