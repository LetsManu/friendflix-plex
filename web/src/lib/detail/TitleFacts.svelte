<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { FRESH_KEYS, LEAVING_BADGE_DAYS } from '#lib/badges';
  import type { Facts } from '#lib/fresh';
  import QualityChips from '#lib/QualityChips.svelte';
  import { fmtDate, t } from '#lib/i18n';

  /** Fresh label, removal date and quality chips of the title (GET /api/items/:id/facts); renders nothing while there is none of it. */
  export let facts: Facts | null = null;
  export let episode = false;
  $: leaving = facts?.leaving ?? null;
  $: soon = leaving !== null && leaving.days <= LEAVING_BADGE_DAYS;
  /** "2026-10-24" as a local calendar day (new Date('2026-10-24') would be UTC and shift by a day west of Greenwich) */
  const local = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y!, m! - 1, d); };
  $: until = leaving ? fmtDate(local(leaving.leavesAt), { day: 'numeric', month: 'long' }) : '';
</script>

{#if facts && ((facts.fresh && !episode) || leaving || facts.traits)}
  <div class="tf">
    {#if facts.fresh && !episode}<span class="pill">{$t(FRESH_KEYS[facts.fresh])}</span>{/if}
    {#if leaving}
      {#if soon}<span class="pill leave">{$t(leaving.days === 0 ? 'fresh.leaving.today' : 'fresh.leaving.days', { n: leaving.days })}</span>{/if}
      <span class="until">{$t('fresh.leaving.until', { date: until })}</span>
    {/if}
    <QualityChips traits={facts.traits} />
  </div>
{/if}

<style>
  .tf { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; margin: .1rem 0 .5rem; }
  .tf :global(.qc) { margin: 0; }
  .pill { padding: .1rem .5rem; border-radius: 3px; background: var(--acc-fill); color: #fff; font-size: .72rem; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
  .pill.leave { background: #b3261e; }
  .until { color: var(--mut); font-size: .85rem; }
</style>
