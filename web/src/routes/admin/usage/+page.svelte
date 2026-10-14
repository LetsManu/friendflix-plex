<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Nutzung (Block 22): how much each account uses the instance, aggregated (profiles summed, never titles).
   * One row per account (client-side sort), period 7 / 30 / 90 days; "Details" opens watch time per day, devices and
   * transcode reasons below the table (loaded once per account and period).
   */
  import { onMount, tick } from 'svelte';
  import { api } from '#lib/api';
  import { fmtDate, fmtNumber, fmtRelative, t, tr, type TKey } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { tcKey, type TranscodeReason } from '#lib/admin/health';
  import { PERIODS, dayBars, fmtHours, showSince, transcodePct, type Period, type UsageDetail, type UsageRow } from '#lib/admin/usage';
  import { roleName, type RoleInfo } from '#lib/roles';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';

  let days: Period = 30;
  let rows: UsageRow[] | null = null, since: string | null = null, error: string | null = null;
  let roles: Record<string, RoleInfo> = {};
  let open: UsageRow | null = null;
  /** details per "userId:days"; 'err' = failed (retry possible) */
  let details = new Map<string, UsageDetail | 'err'>();
  let panel: HTMLElement | undefined;
  let seq = 0;

  async function load() {
    const my = ++seq;
    error = null;
    try {
      const r = await api<{ users: UsageRow[]; since: string | null }>(`/api/admin/usage?days=${days}`);
      if (my !== seq) return;
      rows = r.users; since = r.since;
      if (open) open = rows.find((x) => x.userId === open!.userId) ?? null;
    } catch (e) { if (my !== seq) return; rows = []; error = errorText(e); }
  }
  onMount(() => {
    void load();
    api<{ roles: Record<string, RoleInfo> }>('/api/admin/roles').then((r) => (roles = r.roles), () => undefined);
  });
  function setDays(v: string) {
    days = Number(v) as Period;
    rows = null;
    void load();
    if (open) void loadDetail(open);
  }

  const dkey = (u: UsageRow) => `${u.userId}:${days}`;
  async function loadDetail(u: UsageRow) {
    const k = dkey(u);
    const hit = details.get(k);
    if (hit && hit !== 'err') return;
    if (hit === 'err') { details.delete(k); details = details; }
    try { details.set(k, await api<UsageDetail>(`/api/admin/usage/${encodeURIComponent(u.userId)}?days=${days}`)); }
    catch { details.set(k, 'err'); }
    details = details;
  }
  async function toggle(u: UsageRow) {
    if (open?.userId === u.userId) { open = null; return; }
    open = u;
    void loadDetail(u);
    await tick();
    panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  const rname = (k: string, _r: unknown): string => roleName(k, roles[k]);
  const reasonText = (r: TranscodeReason | null, _l: unknown) => (r ? tr(tcKey(r)) : '');
  const tcText = (u: UsageRow, _l: unknown): string => {
    const pct = transcodePct(u);
    if (pct === null) return '–';
    return u.topReason && u.transcodes ? tr('adminPeople.usage.tcShare', { pct, reason: reasonText(u.topReason, null) }) : tr('adminPeople.usage.tcPct', { pct });
  };

  $: columns = [
    { key: 'name', label: $t('adminPeople.usage.col.name'), value: (u) => u.name, primary: true },
    { key: 'lastSeen', label: $t('adminPeople.usage.col.lastSeen'), value: (u) => u.lastSeen ?? '', filter: false },
    { key: 'time', label: $t('adminPeople.usage.col.time'), value: (u) => u.seconds, filter: false, align: 'end' },
    { key: 'titles', label: $t('adminPeople.usage.col.titles'), value: (u) => u.titles, filter: false, align: 'end' },
    { key: 'streams', label: $t('adminPeople.usage.col.streams'), value: (u) => u.streams, filter: false, align: 'end' },
    { key: 'transcodes', label: $t('adminPeople.usage.col.transcodes'), value: (u) => transcodePct(u) ?? -1, filter: false },
    { key: 'devices', label: $t('adminPeople.usage.col.devices'), value: (u) => u.devicesUsed, filter: false, align: 'end' },
    { key: 'now', label: $t('adminPeople.usage.col.now'), value: (u) => u.liveNow, filter: false },
  ] as Column<UsageRow>[];
  $: periodOptions = PERIODS.map((d) => ({ value: String(d), label: $t(`adminPeople.usage.periods.d${d}` as TKey) }));
  $: detail = open ? details.get(`${open.userId}:${days}`) ?? null : null;
  $: bars = detail && detail !== 'err' ? dayBars(detail.days) : [];
  $: barsLabel = (d: UsageDetail, _l: unknown): string => {
    const total = d.days.reduce((a, x) => a + x.seconds, 0);
    if (!total) return tr('adminPeople.usage.barsEmpty');
    const max = d.days.reduce((m, x) => (x.seconds > m.seconds ? x : m), d.days[0]!);
    return tr('adminPeople.usage.bars', { total: fmtHours(total), max: fmtHours(max.seconds), date: fmtDate(max.day + 'T12:00:00') });
  };
  const reasonList = (d: UsageDetail) => (Object.entries(d.reasons) as Array<[TranscodeReason, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
</script>

<div class="top">
  <div class="per"><Select label={$t('adminPeople.usage.period')} value={String(days)} options={periodOptions} on:change={(e) => setDays((e.currentTarget as HTMLSelectElement).value)} /></div>
  <p class="muted small privacy">{$t('adminPeople.usage.privacy')}</p>
  {#if showSince(since, days)}<p class="muted small" role="note">{$t('adminPeople.usage.since', { date: fmtDate(since + 'T12:00:00') })}</p>{/if}
</div>

<DataTable caption={$t('admin.tabs.usage')} {rows} {columns} key={(u) => u.userId} {error} pageSize={50} filterable
  emptyText={$t('adminPeople.usage.empty')} on:retry={load}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      <span class="nm">
        <span class="who"><b>{row.name}</b><span class="muted small">{rname(row.role, roles)}</span>{#if row.disabled}<StatusPill tone="muted" icon="lock" label={$t('adminPeople.usage.locked')} />{/if}</span>
        <button type="button" class="exp" aria-expanded={open?.userId === row.userId} aria-controls="usage-detail" aria-label={$t('adminPeople.usage.detailsFor', { name: row.name })} on:click={() => toggle(row)}>
          {$t('adminPeople.usage.details')}<span class="chev" class:up={open?.userId === row.userId} aria-hidden="true">▾</span>
        </button>
      </span>
    {:else if col.key === 'lastSeen'}{row.lastSeen ? fmtRelative(row.lastSeen) : $t('adminPeople.usage.never')}
    {:else if col.key === 'time'}
      <span class="tm"><span>{fmtHours(row.seconds)}</span>{#if row.seconds}<span class="muted small">{$t('adminPeople.usage.split', { movies: fmtHours(row.movieSeconds), series: fmtHours(row.seriesSeconds) })}</span>{/if}</span>
    {:else if col.key === 'titles'}{fmtNumber(row.titles)}
    {:else if col.key === 'streams'}{fmtNumber(row.streams)}
    {:else if col.key === 'transcodes'}{tcText(row, $t)}
    {:else if col.key === 'devices'}{$t('adminPeople.usage.devicesUsed', { used: row.devicesUsed, total: row.devices })}
    {:else if col.key === 'now'}
      {#if row.liveNow}<a class="live" href="/admin/playback"><StatusPill tone="ok" icon="play" label={$t('adminPeople.usage.live', { n: row.liveNow })} /></a>{/if}
    {:else}{col.value?.(row) ?? ''}{/if}
  </svelte:fragment>
</DataTable>

<div id="usage-detail" bind:this={panel} class="detail">
  {#if open}
    <AdminCard title={$t('adminPeople.usage.detailTitle', { name: open.name, period: $t(`adminPeople.usage.periods.d${days}` as TKey) })}>
      <svelte:fragment slot="actions"><Button variant="ghost" icon="x" on:click={() => (open = null)}>{$t('adminPeople.usage.close')}</Button></svelte:fragment>
      {#if detail === null}<Skeleton lines={4} h="1.1rem" />
      {:else if detail === 'err'}
        <div class="state" role="alert"><p>{$t('adminPeople.usage.detailFailed')}</p><Button variant="secondary" icon="refresh" on:click={() => open && loadDetail(open)}>{$t('ui.retry')}</Button></div>
      {:else}
        <h3>{$t('adminPeople.usage.perDay')}</h3>
        <div class="bars" role="img" aria-label={barsLabel(detail, $t)} style="--n:{bars.length}">
          {#each bars as b (b.day)}<span class="bar" title="{fmtDate(b.day + 'T12:00:00')}"><i style="height:{Math.max(b.pct, b.pct ? 4 : 0)}%"></i></span>{/each}
        </div>
        <div class="cols">
          <section aria-labelledby="ud-dev">
            <h3 id="ud-dev">{$t('adminPeople.usage.devicesTitle')}</h3>
            {#if detail.devices.length}
              <ul class="list">
                {#each detail.devices as d, i (i)}
                  <li>
                    <span class="dl"><b>{d.label || $t('adminPeople.usage.deviceUnknown')}</b>{#if d.app}<StatusPill tone="info" icon="monitor" label={$t('adminPeople.usage.app')} />{/if}</span>
                    <span class="muted small">{[d.lastSeen ? fmtRelative(d.lastSeen) : '', $t('adminPeople.usage.deviceStreams', { n: d.streams }), $t('adminPeople.usage.deviceTc', { n: d.transcodes })].filter(Boolean).join(' · ')}</span>
                  </li>
                {/each}
              </ul>
            {:else}<p class="muted">{$t('adminPeople.usage.noDevices')}</p>{/if}
          </section>
          <section aria-labelledby="ud-rs">
            <h3 id="ud-rs">{$t('adminPeople.usage.reasonsTitle')}</h3>
            {#if reasonList(detail).length}
              <ul class="list">{#each reasonList(detail) as [r, n] (r)}<li class="rs"><span>{reasonText(r, $t)}</span><b>{fmtNumber(n)}</b></li>{/each}</ul>
            {:else}<p class="muted">{$t('adminPeople.usage.reasonsNone')}</p>{/if}
          </section>
        </div>
      {/if}
    </AdminCard>
  {/if}
</div>

<style>
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .4rem 1.2rem; margin-bottom: 1rem; }
  .top p { margin: 0; }
  .per { min-width: 12rem; }
  .privacy { flex: 1 1 16rem; }
  .small { font-size: .85rem; }
  .nm { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .8rem; justify-content: space-between; }
  .who { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .5rem; min-width: 0; }
  .who b { overflow-wrap: anywhere; }
  .exp { background: transparent; color: var(--info); font-size: .88rem; padding: 0 .5rem; min-height: 44px; gap: .3rem; border-radius: 6px; }
  .exp:hover:not(:disabled) { background: rgba(255,255,255,.06); }
  .chev { display: inline-block; transition: transform var(--t-fast); }
  .chev.up { transform: rotate(180deg); }
  .tm { display: inline-flex; flex-direction: column; align-items: flex-end; }
  .live { display: inline-flex; align-items: center; min-height: 44px; }
  .detail { margin-top: 1rem; scroll-margin-top: calc(var(--nav-total) + 1rem); }
  h3 { font-size: .95rem; margin: 0 0 .5rem; }
  .bars { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 2px; align-items: end; height: 96px; padding: .3rem; background: rgba(255,255,255,.03); border: 1px solid var(--line); border-radius: 6px; margin-bottom: 1.1rem; }
  .bar { height: 100%; display: flex; align-items: flex-end; min-width: 0; }
  .bar i { display: block; width: 100%; background: var(--acc); border-radius: 2px 2px 0 0; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
  @media (min-width: 900px) { .cols { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { display: flex; flex-direction: column; gap: .15rem; padding: .45rem 0; }
  .list li + li { border-top: 1px solid rgba(255,255,255,.05); }
  .list li.rs { flex-direction: row; justify-content: space-between; gap: 1rem; }
  .dl { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .dl b { overflow-wrap: anywhere; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; padding: 1rem; text-align: center; }
  .state p { margin: 0; }
</style>
