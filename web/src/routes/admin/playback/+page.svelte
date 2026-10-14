<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Wiedergabe-Check: (1) playback health check, (2) streams running right now (stop with confirm),
   * (3) offline downloads: prepared files and active licenses. Everything is titled by name, never by id.
   */
  import { onDestroy, onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDate, fmtDateTime, fmtNumber, hasKey, t, tr, trDynamic } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import { poll } from '#lib/adminContent/poll';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { emptyHintOnTop, isEmptyMediaError } from '#lib/admin/health';
  import { refreshSummary } from '#lib/admin/summary';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { confirm } from '#lib/ui/confirm';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { fmtBytes } from '#lib/ui/format';
  import type { Column } from '#lib/ui/table';

  // ---------------------------------------------------------------- health check
  type Res = { itemId: string; name: string; type: string; ok: boolean; status: number | null; ms: number; bytes: number; error: string | null };
  type Check = { running: boolean; done: number; total: number; startedAt: string | null; finishedAt: string | null; results: Res[] };
  let check: Check | null = null, checkErr = false;
  $: failed = check?.results.filter((r) => !r.ok) ?? [];
  $: good = check?.results.filter((r) => r.ok) ?? [];
  $: hintOnTop = emptyHintOnTop(check?.results ?? []);
  async function loadCheck() {
    try { check = await api<Check>('/api/admin/playback-check'); checkErr = false; } catch { checkErr = true; if (!check) check = null; }
  }
  async function startCheck() {
    const res = await runAction({
      key: 'pb:check', run: () => api('/api/admin/playback-check', { method: 'POST' }),
      error: (e) => (e instanceof ApiError && e.status === 409 ? tr('admin.playback.running') : tr('admin.playback.startFailed')),
      success: tr('adminContent.playback.started'),
    });
    if (res.ok || (res.error instanceof ApiError && res.error.status === 409)) await loadCheck();
  }

  // ---------------------------------------------------------------- live streams
  type Live = { userId: string; userName: string; profileName: string | null; playSessionId: string; itemId: string; title: string; seriesName: string | null; type: string | null; positionTicks: number; runtimeTicks: number | null; isPaused: boolean; updatedAt: string; source: string };
  let live: Live[] | null = null, liveErr: string | null = null;
  async function loadLive() {
    try { live = (await api<{ sessions: Live[] }>('/api/admin/live')).sessions; liveErr = null; } catch (e) { if (!live) live = []; liveErr = live.length ? null : errorText(e); }
  }
  const liveKey = (l: Live) => `${l.userId}:${l.playSessionId}`;
  const liveTitle = (l: Live) => (l.seriesName ? `${l.seriesName} · ${l.title}` : l.title);
  async function stopLive(l: Live) {
    if (!(await confirm({ title: tr('adminContent.playback.stopConfirm', { title: liveTitle(l), name: l.userName }), body: tr('adminContent.playback.stopBody'), danger: true, confirmLabel: tr('adminContent.playback.stop') }))) return;
    const res = await runAction({
      key: `live:${liveKey(l)}`,
      apply: () => { const prev = live; live = (live ?? []).filter((x) => x !== l); return () => { live = prev; }; },
      run: () => api('/api/admin/live/stop', { method: 'POST', body: { userId: l.userId, playSessionId: l.playSessionId } }),
      success: tr('adminContent.playback.stopped', { name: l.userName }),
      error: (e) => (e instanceof ApiError && e.status === 404 ? tr('adminContent.playback.alreadyOver') : errorText(e)),
    });
    if (!res.ok) void loadLive();
    else void refreshSummary();
  }

  // ---------------------------------------------------------------- offline downloads
  type DlJob = { id: string; item_id: string; title: string | null; series_name: string | null; quality: string; audio_lang: string; status: string; seg_done: number; seg_total: number | null; bytes: string | number | null; error: string | null; updated_at: string; licenses: number };
  type DlLic = { id: string; item_id: string; title: string | null; series_name: string | null; user_name: string; device_label: string | null; quality: string; status: string; expires_at: string };
  let dl: { enabled: boolean; maxBytes: number; diskBytes: number; jobs: DlJob[]; licenses: DlLic[] } | null = null, dlErr: string | null = null;
  async function loadDl() {
    try {
      const r = await api('/api/admin/downloads');
      dl = { enabled: Boolean(r.enabled), maxBytes: r.maxBytes ?? 0, diskBytes: r.diskBytes ?? 0, jobs: r.jobs ?? [], licenses: r.licenses ?? [] }; dlErr = null;
    } catch { dlErr = tr('admin.playback.dlLoadFailed'); if (!dl) dl = { enabled: true, maxBytes: 0, diskBytes: 0, jobs: [], licenses: [] }; }
  }
  const named = (title: string | null, series: string | null) => (title ? (series ? `${series} · ${title}` : title) : tr('adminContent.playback.unknownTitle'));
  const statusTone = (s: string): Tone => (s === 'ready' || s === 'fetched' ? 'ok' : s === 'failed' ? 'err' : s === 'preparing' ? 'warn' : s === 'pending' || s === 'queued' ? 'info' : 'muted');
  const statusText = (s: string) => (hasKey(`admin.playback.dlStatus.${s}`) ? trDynamic(`admin.playback.dlStatus.${s}`) : s);
  const quality = (q: string) => (hasKey(`adminContent.playback.quality.${q}`) ? trDynamic(`adminContent.playback.quality.${q}`) : q);
  async function revoke(l: DlLic) {
    if (!(await confirm({ title: tr('adminContent.playback.revokeConfirm', { title: named(l.title, l.series_name), name: l.user_name }), body: tr('admin.playback.dlConfirmRevoke'), danger: true, confirmLabel: tr('admin.revoke') }))) return;
    await runAction({
      key: `lic:${l.id}`,
      apply: () => { const prev = dl; if (dl) dl = { ...dl, licenses: dl.licenses.filter((x) => x !== l) }; return () => { dl = prev; }; },
      run: () => api(`/api/admin/downloads/${encodeURIComponent(l.id)}`, { method: 'DELETE' }),
      success: tr('adminContent.playback.revoked', { name: l.user_name }),
      error: tr('admin.playback.dlRevokeFailed'),
    });
    void loadDl();
  }

  let stops: Array<() => void> = [];
  onMount(() => {
    void loadCheck(); void loadLive(); void loadDl();
    stops = [
      poll(() => { if (check?.running) void loadCheck(); }, 3000),
      poll(loadLive, 10_000),
      poll(() => { if (dl?.jobs.some((j) => j.status === 'preparing' || j.status === 'queued')) void loadDl(); }, 5000),
    ];
  });
  onDestroy(() => stops.forEach((s) => s()));

  const pctOf = (done: number, total: number | null) => (total ? Math.round((done / total) * 100) : null);
  $: liveCols = [
    { key: 'title', label: $t('adminContent.playback.liveTitle'), value: (l) => liveTitle(l), primary: true, sortable: false },
    { key: 'user', label: $t('adminContent.playback.liveUser'), value: (l) => (l.profileName && l.profileName !== l.userName ? `${l.userName} (${l.profileName})` : l.userName), sortable: false },
    { key: 'pos', label: $t('adminContent.playback.livePosition'), sortable: false, filter: false },
    { key: 'state', label: $t('admin.requests.status'), sortable: false, filter: false },
  ] as Column<Live>[];
  $: jobCols = [
    { key: 'title', label: $t('adminContent.playback.liveTitle'), value: (j) => named(j.title, j.series_name), primary: true, sortable: false },
    { key: 'quality', label: $t('adminContent.playback.qualityLabel'), value: (j) => quality(j.quality), sortable: false },
    { key: 'status', label: $t('admin.requests.status'), sortable: false, filter: false },
    { key: 'size', label: $t('admin.previews.size'), value: (j) => (j.bytes ? fmtBytes(Number(j.bytes)) : ''), sortable: false, align: 'end' },
    { key: 'lic', label: $t('adminContent.playback.licensesLabel'), value: (j) => j.licenses, sortable: false, align: 'end' },
  ] as Column<DlJob>[];
  $: licCols = [
    { key: 'title', label: $t('adminContent.playback.liveTitle'), value: (l) => named(l.title, l.series_name), primary: true, sortable: false },
    { key: 'user', label: $t('adminContent.playback.liveUser'), value: (l) => l.user_name, sortable: false },
    { key: 'device', label: $t('adminContent.playback.device'), value: (l) => l.device_label ?? '', sortable: false, hideOnCard: false },
    { key: 'quality', label: $t('adminContent.playback.qualityLabel'), value: (l) => quality(l.quality), sortable: false },
    { key: 'until', label: $t('adminContent.playback.untilLabel'), value: (l) => l.expires_at, sortable: false },
  ] as Column<DlLic>[];
</script>

<AdminCard title={$t('adminContent.playback.checkTitle')} description={$t('admin.playback.intro')}>
  <svelte:fragment slot="actions">
    <Button icon="play" pending={$busyKeys.has('pb:check') || Boolean(check?.running)} on:click={startCheck}>{$t('admin.playback.start')}</Button>
  </svelte:fragment>
  {#if check === null && !checkErr}
    <Skeleton lines={2} h="1rem" />
  {:else if checkErr && check === null}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.playback.checkLoadFailed')}</p><Button variant="secondary" icon="refresh" on:click={loadCheck}>{$t('ui.retry')}</Button></div>
  {:else if check}
    {#if check.running}
      <Progress value={check.total ? check.done : null} max={check.total || 1} label={$t('adminContent.playback.checking', { done: check.done, total: check.total || '…' })} showValue />
    {:else if check.finishedAt}
      <p class="sumline">
        <StatusPill tone={failed.length ? 'err' : 'ok'} label={failed.length ? $t('admin.playback.failedCount', { n: failed.length }) : $t('admin.playback.noErrors')} />
        <span class="muted">{$t('admin.playback.last', { date: fmtDateTime(check.finishedAt) })}</span>
      </p>
    {:else}
      <p class="muted">{$t('adminContent.playback.neverRun')}</p>
    {/if}
    {#if hintOnTop && !check.running}
      <p class="hint" role="alert" data-testid="empty-media-hint"><Icon name="alert" size={18} /><span>{$t('adminContent.health.reason.empty_media')}</span></p>
    {/if}
    {#if failed.length}
      <ul class="fails">
        {#each failed as r (r.itemId)}
          <li>
            <div class="fh"><b>{r.name}</b><span class="muted">{r.type === 'Series' ? $t('admin.kind.series') : $t('admin.kind.movie')}{r.status ? ' · ' + $t('admin.playback.http', { status: String(r.status) }) : ''}</span></div>
            {#if r.error}<code>{r.error}</code>{/if}
            {#if r.error?.includes('500')}<p class="muted small">{$t('admin.playback.transcodeHint')}</p>
            {:else if !hintOnTop && isEmptyMediaError(r.error)}<p class="muted small" data-testid="empty-media-row-hint">{$t('adminContent.health.reason.empty_media')}</p>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if good.length}
      <details class="oks">
        <summary>{$t('admin.playback.okCount', { n: good.length })}</summary>
        <ul>{#each good as r (r.itemId)}<li><span>{r.name}</span><span class="muted">{$t('admin.playback.seconds', { n: fmtNumber(r.ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span></li>{/each}</ul>
      </details>
    {/if}
  {/if}
</AdminCard>

<AdminCard title={$t('adminContent.playback.liveCard')} description={$t('adminContent.playback.liveIntro')}>
  <DataTable
    caption={$t('adminContent.playback.liveCard')} rows={live} columns={liveCols} key={liveKey} error={liveErr} pageSize={0} skeletonRows={2}
    emptyText={$t('adminContent.playback.liveEmpty')} busyKey={(l) => `live:${liveKey(l)}`} rowLabel={liveTitle} on:retry={loadLive}
    actions={(l) => [{ id: 'stop', label: $t('adminContent.playback.stop'), icon: 'stop', danger: true, run: () => stopLive(l) }]}>
    <svelte:fragment slot="cell" let:row let:col>
      {#if col.key === 'pos'}
        {#if row.runtimeTicks}<Progress value={row.positionTicks} max={row.runtimeTicks} label={$t('adminContent.playback.position', { pos: fmtNumber(Math.round(row.positionTicks / 6e8)), total: fmtNumber(Math.round(row.runtimeTicks / 6e8)) })} />{:else}–{/if}
      {:else if col.key === 'state'}
        <StatusPill tone={row.isPaused ? 'muted' : 'ok'} icon={row.isPaused ? 'pause' : 'play'} label={row.isPaused ? $t('adminContent.playback.paused') : $t('adminContent.playback.playing')} />
      {:else}{col.value?.(row) ?? ''}{/if}
    </svelte:fragment>
  </DataTable>
</AdminCard>

<AdminCard title={$t('admin.playback.dlTitle')}>
  <p class="muted intro"><Rich text={$t('admin.playback.dlIntro')} /></p>
  {#if dlErr}<div class="state" role="alert"><Icon name="alert" size={22} /><p>{dlErr}</p><Button variant="secondary" icon="refresh" on:click={loadDl}>{$t('ui.retry')}</Button></div>{/if}
  {#if dl && !dlErr}
    {#if !dl.enabled}<p class="muted"><Rich text={$t('admin.playback.dlDisabled')} /></p>{/if}
    <div class="stor">
      <Progress value={dl.diskBytes} max={dl.maxBytes || 1} tone={dl.maxBytes && dl.diskBytes > dl.maxBytes * 0.9 ? 'warn' : 'acc'} label={$t('admin.playback.dlStorage', { used: fmtBytes(dl.diskBytes), max: fmtBytes(dl.maxBytes) })} />
    </div>
  {/if}
  <h3>{$t('admin.playback.jobs', { n: dl?.jobs.length ?? 0 })}</h3>
  <DataTable
    caption={$t('admin.playback.jobs', { n: dl?.jobs.length ?? 0 })} rows={dl && !dlErr ? dl.jobs : dlErr ? [] : null} columns={jobCols} key={(j) => j.id} pageSize={10} skeletonRows={3} emptyText={$t('admin.playback.noJobs')}>
    <svelte:fragment slot="cell" let:row let:col>
      {#if col.key === 'status'}
        <span class="st">
          <StatusPill tone={statusTone(row.status)} label={statusText(row.status)} />
          {#if row.status === 'preparing' && row.seg_total}<Progress value={row.seg_done} max={row.seg_total} showValue label={$t('adminContent.playback.preparing')} />{/if}
          {#if row.error}<code>{row.error}</code>{/if}
          {#if isEmptyMediaError(row.error)}<span class="muted small">{$t('adminContent.health.reason.empty_media')}</span>{/if}
        </span>
      {:else}{col.value?.(row) ?? ''}{/if}
    </svelte:fragment>
  </DataTable>

  <h3>{$t('admin.playback.licenses', { n: dl?.licenses.length ?? 0 })}</h3>
  <DataTable
    caption={$t('admin.playback.licenses', { n: dl?.licenses.length ?? 0 })} rows={dl && !dlErr ? dl.licenses : dlErr ? [] : null} columns={licCols} key={(l) => l.id} pageSize={10} skeletonRows={3} emptyText={$t('admin.playback.noLicenses')}
    busyKey={(l) => `lic:${l.id}`} rowLabel={(l) => named(l.title, l.series_name)}
    actions={(l) => [{ id: 'revoke', label: $t('admin.revoke'), icon: 'x', danger: true, run: () => revoke(l) }]}>
    <svelte:fragment slot="cell" let:row let:col>
      {#if col.key === 'until'}
        <time datetime={row.expires_at} title={fmtDateTime(row.expires_at)}>{$t('admin.playback.until', { date: fmtDate(row.expires_at, { dateStyle: 'medium' }) })}</time>
      {:else if col.key === 'device'}{row.device_label ?? '–'}
      {:else}{col.value?.(row) ?? ''}{/if}
    </svelte:fragment>
  </DataTable>
</AdminCard>

<style>
  .intro { margin: 0 0 .9rem; }
  h3 { font-size: .95rem; margin: 1.2rem 0 .6rem; }
  .sumline { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; margin: 0; }
  .fails { list-style: none; margin: 1rem 0 0; padding: 0; display: grid; gap: .6rem; }
  .fails li { padding: .7rem .9rem; border: 1px solid rgba(255,107,107,.35); background: var(--tone-err); border-radius: 6px; display: grid; gap: .35rem; }
  .fh { display: flex; gap: .6rem; flex-wrap: wrap; align-items: baseline; }
  .fh b { overflow-wrap: anywhere; }
  code { display: block; font-size: .82rem; color: var(--err); word-break: break-all; white-space: pre-wrap; }
  .small { font-size: .85rem; margin: 0; }
  .hint { display: flex; gap: .5rem; align-items: flex-start; margin: .8rem 0 0; padding: .7rem .9rem; border-radius: 6px; background: var(--tone-err); color: var(--fg); }
  .hint :global(svg) { color: var(--err); flex: none; margin-top: .1rem; }
  .oks { margin-top: 1rem; }
  .oks summary { cursor: pointer; min-height: 36px; display: flex; align-items: center; color: var(--mut); }
  .oks ul { list-style: none; margin: .4rem 0 0; padding: 0; max-height: 18rem; overflow: auto; }
  .oks li { display: flex; justify-content: space-between; gap: 1rem; padding: .25rem 0; border-bottom: 1px solid rgba(255,255,255,.05); }
  .stor { max-width: 36rem; margin-bottom: .6rem; }
  .st { display: inline-flex; flex-direction: column; gap: .4rem; align-items: flex-start; min-width: 8rem; }
  .st :global(.prog) { width: 100%; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.4rem 1rem; color: var(--fg); }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
  time { white-space: nowrap; color: var(--mut); font-size: .9rem; }
</style>
