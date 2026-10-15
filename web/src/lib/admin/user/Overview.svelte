<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail, overview tab: watch time / streams (7, 30 days, all), downloads and requests; linked accounts with health and "Repair". */
  import { createEventDispatcher } from 'svelte';
  import { api } from '#lib/api';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { toast } from '#lib/ui/toast';
  import type { Tone } from '#lib/ui/StatusPill.svelte';
  import type { UserDetail } from './detail';

  export let userId: string;
  export let detail: UserDetail;
  const dispatch = createEventDispatcher<{ changed: void }>();

  $: periods = [['d7', detail.totals.d7], ['d30', detail.totals.d30], ['all', detail.totals.all]] as const;
  $: links = [
    { id: 'jellyfin', label: $t('adminPeople.detail.overview.jellyfin'), ok: detail.linked.jellyfin.ok, sub: detail.linked.jellyfin.username },
    { id: 'requests', label: $t('adminPeople.detail.overview.requestService'), ok: detail.linked.requests.ok, sub: null },
  ];
  // null = cannot be checked: a neutral "unknown", never "broken", and nothing to repair
  const health = (ok: boolean | null): { tone: Tone; key: 'ok' | 'broken' | 'unknown' } => (ok === null ? { tone: 'muted', key: 'unknown' } : ok ? { tone: 'ok', key: 'ok' } : { tone: 'err', key: 'broken' });
  $: broken = links.some((l) => l.ok === false);
  $: busy = $busyKeys.has(`repair:${userId}`);

  async function repair() {
    const r = await runAction({ key: `repair:${userId}`, run: () => api<{ ok: boolean }>(`/api/admin/users/${userId}/repair`, { method: 'POST' }) });
    if (!r.ok) return;
    // a partial repair is not a success
    if (r.value?.ok) toast.success(tr('adminPeople.detail.overview.repaired')); else toast.error(tr('adminPeople.detail.overview.repairPartial'));
    dispatch('changed');
  }
</script>

<section class="card" aria-labelledby="udo-totals">
  <h3 id="udo-totals">{$t('adminPeople.detail.overview.totals')}</h3>
  <dl class="totals">
    {#each periods as [k, v] (k)}
      <div><dt>{$t(`adminPeople.detail.overview.${k}`)}</dt><dd><strong>{$t('adminPeople.detail.overview.hours', { n: fmtNumber(v.hours, { maximumFractionDigits: 1 }) })}</strong><span>{$t('adminPeople.detail.overview.streams', { n: v.streams })}</span></dd></div>
    {/each}
    <div><dt>{$t('adminPeople.detail.overview.downloads')}</dt><dd><strong>{fmtNumber(detail.totals.downloads)}</strong></dd></div>
    <div><dt>{$t('adminPeople.detail.overview.requests')}</dt><dd><strong>{fmtNumber(detail.totals.requests)}</strong></dd></div>
  </dl>
</section>

<section class="card" aria-labelledby="udo-linked">
  <h3 id="udo-linked">{$t('adminPeople.detail.overview.linked')}</h3>
  <ul class="links">
    {#each links as l (l.id)}
      {@const h = health(l.ok)}
      <li>
        <span class="dot {h.tone}" aria-hidden="true"></span>
        <span class="nm">{l.label}{#if l.sub}<span class="sub">{l.sub}</span>{/if}</span>
        <span class="st {h.tone}" title={h.key === 'unknown' ? $t('adminPeople.detail.overview.unknownHint') : undefined}>{$t(`adminPeople.detail.overview.${h.key}`)}</span>
      </li>
    {/each}
  </ul>
  {#if broken}
    <Button variant="secondary" size="sm" icon="refresh" pending={busy} on:click={repair}>{$t('adminPeople.detail.overview.repair')}</Button>
  {/if}
</section>

<style>
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  h3 { margin: 0 0 .8rem; font-size: 1rem; font-weight: 700; }
  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .8rem; margin: 0; }
  .totals div { min-width: 0; }
  dt { color: var(--mut); font-size: .85rem; }
  dd { margin: .2rem 0 0; display: flex; flex-direction: column; font-variant-numeric: tabular-nums; }
  dd strong { font-size: 1.3rem; font-weight: 800; }
  dd span { color: var(--mut); font-size: .85rem; }
  .links { list-style: none; margin: 0 0 .8rem; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
  .links li { display: flex; align-items: center; gap: .6rem; min-height: 36px; }
  .dot { width: 10px; height: 10px; flex: none; border-radius: 50%; background: var(--mut); }
  .dot.ok { background: var(--ok); } .dot.err { background: var(--err); }
  .nm { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: .1rem .6rem; font-weight: 600; overflow-wrap: anywhere; }
  .sub { color: var(--mut); font-weight: 400; }
  .st { font-size: .9rem; font-weight: 600; color: var(--mut); }
  .st.ok { color: var(--ok); } .st.err { color: var(--err); }
</style>
