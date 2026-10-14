<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Active streams with play method / transcode reason, and failed playbacks of the last 24 h (Block 22). null = skeleton. */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { cleanCode, tcKey, type StreamMethod, type StreamRow, type StreamsView } from './health';

  export let view: StreamsView | null;
  export let error: string | null = null;
  const dispatch = createEventDispatcher<{ retry: void }>();
  const TONE: Record<StreamMethod, Tone> = { direct: 'ok', remux: 'info', transcode: 'warn' };
  const ICON: Record<StreamMethod, string> = { direct: 'check', remux: 'refresh', transcode: 'gauge' };
  const who = (s: StreamRow) => [s.userName ?? '', s.profileName && s.profileName !== s.userName ? `(${s.profileName})` : ''].filter(Boolean).join(' ');
  const codecs = (s: StreamRow) => [s.videoCodec, s.audioCodec].filter(Boolean).join(' · ');
</script>

<AdminCard title={$t('adminContent.health.streams.title')}>
  {#if error && !view}
    <div class="state" role="alert"><Icon name="alert" size={20} /><p>{error}</p><Button variant="secondary" icon="refresh" on:click={() => dispatch('retry')}>{$t('ui.retry')}</Button></div>
  {:else if !view}<Skeleton lines={3} h="1.1rem" />
  {:else}
    <h3>{$t('adminContent.health.streams.active')}</h3>
    {#if view.streams.length}
      <p class="muted small">{$t('adminContent.health.streams.totals', { direct: view.totals.direct, remux: view.totals.remux, transcode: view.totals.transcode })}</p>
      <ul class="rows">
        {#each view.streams as s, i (i)}
          <li>
            <span class="tt">{s.seriesName ? `${s.seriesName} · ${s.title}` : s.title}</span>
            <span class="muted small">{[who(s), s.device ?? '', s.source === 'app' ? $t('adminContent.health.streams.app') : ''].filter(Boolean).join(' · ')}</span>
            <span class="chips">
              {#if s.method}<StatusPill tone={TONE[s.method]} icon={ICON[s.method]} label={$t(`adminContent.health.streams.method.${s.method}`)} />
              {:else}<StatusPill tone="muted" icon="info" label={$t('adminContent.health.streams.unknownMethod')} />{/if}
              {#if s.reason}<StatusPill tone="info" icon="info" label={$t(tcKey(s.reason))} />{/if}
              {#if s.hardware !== null && s.method === 'transcode'}<StatusPill tone="muted" icon="gauge" label={s.hardware ? $t('adminContent.health.streams.hardware') : $t('adminContent.health.streams.software')} />{/if}
              {#if s.paused}<StatusPill tone="muted" icon="pause" label={$t('adminContent.health.streams.paused')} />{/if}
              {#if codecs(s)}<span class="codec">{codecs(s)}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">{$t('adminContent.health.streams.none')}</p>{/if}
    {#if !view.details}<p class="hint muted small"><Icon name="info" size={16} />{$t('adminContent.health.streams.noDetails')}</p>{/if}

    <h3>{$t('adminContent.health.streams.failed')}</h3>
    {#if view.failed.length}
      <ul class="rows">
        {#each view.failed as f (f.itemId)}
          <li class="fl">
            <a class="tt" href="/item/{f.itemId}">{f.title ?? $t('adminContent.health.streams.unknownTitle')}</a>
            <span class="muted small">
              {$t('adminContent.health.streams.times', { n: f.count })} · <time datetime={f.lastAt} title={fmtDateTime(f.lastAt)}>{$t('adminContent.health.streams.last', { time: fmtRelative(f.lastAt) })}</time>
              {#if f.code}{' · '}<code>{cleanCode(f.code)}</code>{/if}
            </span>
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">{$t('adminContent.health.streams.failedNone')}</p>{/if}
    {#if error}<p class="muted small" role="status">{error}</p>{/if}
  {/if}
</AdminCard>

<style>
  h3 { font-size: .95rem; margin: 0 0 .4rem; }
  h3:not(:first-child) { margin-top: 1.1rem; padding-top: .9rem; border-top: 1px solid var(--line); }
  p { margin: 0; }
  .small { font-size: .85rem; }
  .rows { list-style: none; margin: .4rem 0 0; padding: 0; }
  .rows li { display: flex; flex-direction: column; gap: .25rem; padding: .55rem 0; min-width: 0; }
  .rows li + li { border-top: 1px solid rgba(255,255,255,.05); }
  .tt { font-weight: 600; overflow-wrap: anywhere; }
  a.tt { color: var(--info); min-height: 44px; display: inline-flex; align-items: center; align-self: flex-start; }
  a.tt:hover { text-decoration: underline; }
  .chips { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
  .codec, code { font-size: .8rem; color: var(--mut); overflow-wrap: anywhere; }
  .hint { display: flex; gap: .4rem; align-items: center; margin-top: .6rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.2rem; }
  .state :global(svg) { color: var(--err); }
</style>
