<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Top errors of the last 24 h (aggregated: source, code, count, last seen, release) plus the recent counts behind the level. */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { cleanCode, levelIcon, levelTone, type ErrorHealth, type ErrorList, type ErrorSource } from './health';

  export let list: ErrorList | null;
  export let recent: ErrorHealth | null = null;
  export let error: string | null = null;
  const TOP = 20;
  const dispatch = createEventDispatcher<{ retry: void }>();
  const TONE: Record<ErrorSource, Tone> = { server: 'err', client: 'warn', playback: 'warn', job: 'info' };
  const ICON: Record<ErrorSource, string> = { server: 'hard-drive', client: 'monitor', playback: 'play', job: 'clock' };
  $: top = list ? [...list.entries].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, TOP) : null;
</script>

<AdminCard title={$t('adminContent.health.errors.title')}>
  <svelte:fragment slot="actions">
    {#if recent}<StatusPill tone={levelTone(recent.level)} icon={levelIcon(recent.level)} label={$t('adminContent.health.errors.recent', { server: recent.server15, client: recent.client15, playback: recent.playback60 })} />{/if}
  </svelte:fragment>
  {#if error && !list}
    <div class="state" role="alert"><Icon name="alert" size={20} /><p>{error}</p><Button variant="secondary" icon="refresh" on:click={() => dispatch('retry')}>{$t('ui.retry')}</Button></div>
  {:else if !top}<Skeleton lines={3} h="1.1rem" />
  {:else if !top.length}<p class="muted">{$t('adminContent.health.errors.none')}</p>
  {:else}
    <ul class="rows">
      {#each top as e, i (e.source + e.code + (e.itemId ?? '') + i)}
        <li>
          <span class="top"><StatusPill tone={TONE[e.source]} icon={ICON[e.source]} label={$t(`adminContent.health.errors.source.${e.source}`)} /><code>{cleanCode(e.code)}</code></span>
          <span class="muted small">
            {$t('adminContent.health.streams.times', { n: e.count })} · <time datetime={e.lastAt} title={fmtDateTime(e.lastAt)}>{$t('adminContent.health.streams.last', { time: fmtRelative(e.lastAt) })}</time>
            {#if e.release}{' · '}{$t('adminContent.health.errors.release', { release: e.release })}{/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if list?.overflow}<p class="muted small">{$t('adminContent.health.errors.overflow', { n: list.overflow })}</p>{/if}
  {/if}
</AdminCard>

<style>
  p { margin: 0; }
  .small { font-size: .85rem; }
  .rows { list-style: none; margin: 0 0 .4rem; padding: 0; }
  .rows li { display: flex; flex-direction: column; gap: .3rem; padding: .55rem 0; min-width: 0; }
  .rows li + li { border-top: 1px solid rgba(255,255,255,.05); }
  .top { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; min-width: 0; }
  code { font-size: .85rem; overflow-wrap: anywhere; min-width: 0; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.2rem; }
  .state :global(svg) { color: var(--err); }
</style>
