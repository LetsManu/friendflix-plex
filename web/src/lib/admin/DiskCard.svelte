<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Disk usage of the mounted volumes and the database size (Block 22). Labels only, never a path. null = skeleton. */
  import { t, type TKey } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { fmtBytes } from '#lib/ui/format';
  import { diskLabelKey, levelIcon, levelTone, reasonKey, type DiskHealth } from './health';

  export let disks: DiskHealth[] | null;
  const pillText = (d: DiskHealth, _l: unknown): string =>
    d.reason ? $t(reasonKey(`disk:${d.id}`, d.reason), { pct: d.usedPct ?? 0, n: 0 }) : d.level === 'ok' ? $t('adminContent.health.disks.ok') : $t(`adminContent.health.level.${d.level}` as TKey);
  const barTone = (d: DiskHealth): 'acc' | 'warn' | 'err' => (d.level === 'err' ? 'err' : d.level === 'warn' ? 'warn' : 'acc');
</script>

<AdminCard title={$t('adminContent.health.disks.title')}>
  {#if !disks}<Skeleton lines={3} h="1.1rem" />
  {:else}
    <ul class="disks">
      {#each disks as d (d.id)}
        <li>
          <div class="dh"><span class="dl">{$t(diskLabelKey(d))}</span><StatusPill tone={levelTone(d.level)} icon={levelIcon(d.level)} label={pillText(d, $t)} /></div>
          {#if d.id === 'database'}
            {#if d.level !== 'off'}<p class="kv">{$t('adminContent.health.disks.size', { size: fmtBytes(d.ownBytes) })}</p>{/if}
            <p class="muted small">{$t('adminContent.health.disks.dbNote')}</p>
          {:else if d.totalBytes !== undefined && d.usedPct !== undefined}
            {@const used = d.totalBytes - (d.freeBytes ?? 0)}
            <Progress value={d.usedPct} max={100} tone={barTone(d)} label={$t('adminContent.health.disks.usedOf', { used: fmtBytes(used), total: fmtBytes(d.totalBytes), pct: d.usedPct })} />
            <p class="muted small">
              {$t('adminContent.health.disks.free', { free: fmtBytes(d.freeBytes ?? 0) })} · {$t('adminContent.health.disks.own', { own: fmtBytes(d.ownBytes + (d.sharedBytes ?? 0)) })}
            </p>
            {#if d.sharedWith}<p class="muted small">{$t('adminContent.health.disks.split', { downloads: fmtBytes(d.ownBytes), previews: fmtBytes(d.sharedBytes ?? 0) })}</p>{/if}
            {#if d.capBytes}<p class="muted small">{$t('adminContent.health.disks.cap', { own: fmtBytes(d.ownBytes), cap: fmtBytes(d.capBytes) })}</p>{/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</AdminCard>

<style>
  .disks { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); }
  .disks li { display: grid; gap: .45rem; align-content: start; min-width: 0; }
  .dh { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
  .dl { font-weight: 600; }
  p { margin: 0; overflow-wrap: anywhere; }
  .small { font-size: .85rem; }
</style>
