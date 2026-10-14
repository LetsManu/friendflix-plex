<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Status (Block 22: the health page): traffic light per dependency ("Jetzt prüfen" waits for a fresh check), disks,
   * active / failed playbacks and the top errors of 24 h, then the numbers. Snapshot every 30 s, streams every 10 s while visible.
   */
  import { onDestroy, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, fmtTime, t, tr } from '#lib/i18n';
  import { poll } from '#lib/adminContent/poll';
  import { refreshSummary, summary, summaryFailed } from '#lib/admin/summary';
  import { loadErrors, loadHealth, loadStreams, type ErrorList, type HealthSnapshot, type StreamsView } from '#lib/admin/health';
  import { refreshBanner } from '#lib/admin/banner';
  import ServiceLights from '#lib/admin/ServiceLights.svelte';
  import DiskCard from '#lib/admin/DiskCard.svelte';
  import StreamsCard from '#lib/admin/StreamsCard.svelte';
  import ErrorsCard from '#lib/admin/ErrorsCard.svelte';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';
  import { toast } from '#lib/ui/toast';

  $: s = $summary;
  let snap: HealthSnapshot | null = null, snapErr: string | null = null;
  let streams: StreamsView | null = null, streamsErr: string | null = null;
  let errors: ErrorList | null = null, errorsErr: string | null = null;
  let checking = false, refreshing = false;

  async function loadSnap() {
    try { snap = await loadHealth(); snapErr = null; } catch (e) { snapErr = errorText(e); }
  }
  async function loadStr() {
    try { streams = await loadStreams(); streamsErr = null; } catch (e) { streamsErr = errorText(e); }
  }
  async function loadErr() {
    try { errors = await loadErrors(24); errorsErr = null; } catch (e) { errorsErr = errorText(e); }
  }
  /** "Jetzt prüfen": the only call that waits for fresh probes (rate limited on the server) */
  async function checkNow() {
    if (checking) return;
    checking = true;
    try {
      snap = await loadHealth(true); snapErr = null; toast.success(tr('adminContent.health.checked'));
      void refreshBanner(); // the banner shows the new state now, not after its next 60 s poll
    } catch (e) { toast.error(errorText(e)); }
    checking = false;
  }
  const reloadSummary = async () => { refreshing = true; await refreshSummary(); refreshing = false; };
  const slow = () => { void loadSnap(); void loadErr(); void refreshSummary(); };

  let stops: Array<() => void> = [];
  onMount(() => {
    void loadSnap(); void loadStr(); void loadErr(); void reloadSummary();
    stops = [poll(slow, 30_000), poll(loadStr, 10_000)];
  });
  onDestroy(() => stops.forEach((f) => f()));
</script>

<p class="intro muted">{$t('adminContent.health.intro')}</p>

<section class="health" aria-labelledby="st-health">
  <div class="sh">
    <h2 id="st-health">{$t('admin.dash.health')}</h2>
    {#if snap}<span class="muted small">{$t('adminContent.health.checkedAt', { time: fmtTime(snap.at) })}</span>{/if}
    <span class="sp"></span>
    <Button variant="secondary" icon="refresh" pending={checking} on:click={checkNow}>{$t('adminContent.health.checkNow')}</Button>
  </div>
  {#if snapErr && !snap}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.health.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={loadSnap}>{$t('ui.retry')}</Button></div>
  {:else}
    <ServiceLights services={snap?.services ?? null} />
  {/if}
</section>

<DiskCard disks={snapErr && !snap ? [] : snap?.disks ?? null} />

<div class="cols">
  <StreamsCard view={streams} error={streamsErr} on:retry={loadStr} />
  <ErrorsCard list={errors} recent={snap?.errors ?? null} error={errorsErr} on:retry={loadErr} />
</div>

<section aria-labelledby="st-num">
  <h2 id="st-num">{$t('adminContent.status.numbers')}</h2>
  {#if $summaryFailed && !s}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.status.loadFailed')}</p><Button variant="secondary" icon="refresh" pending={refreshing} on:click={reloadSummary}>{$t('ui.retry')}</Button></div>
  {:else}
    <div class="stats">
      <StatTile icon="users" label={$t('admin.status.users')} value={s ? fmtNumber(s.users.active) : null} href="/admin/users" hint={s ? `${$t('admin.dash.locked')}: ${fmtNumber(s.users.locked)}` : ''} />
      <StatTile icon="play" label={$t('admin.status.activeStreams')} value={s ? fmtNumber(s.live.streams) : null} href="/admin/playback" />
      <StatTile icon="tv" label={$t('admin.status.partyRooms')} value={s ? fmtNumber(s.live.partyRooms) : null} />
      <StatTile icon="mail" label={$t('admin.status.openInvites')} value={s ? fmtNumber(s.pending.invites) : null} href="/admin/invites" />
      <StatTile icon="monitor" label={$t('admin.status.pendingDevices')} value={s ? fmtNumber(s.pending.devices) : null} href="/admin/devices" tone={s?.pending.devices ? 'warn' : 'default'} />
      <StatTile icon="vote" label={$t('admin.status.pendingPolls')} value={s ? fmtNumber(s.pending.polls) : null} href="/admin/polls" tone={s?.pending.polls ? 'warn' : 'default'} />
      <StatTile icon="inbox" label={$t('adminContent.status.pendingRequests')} value={!s ? null : s.pending.requests === null ? '–' : fmtNumber(s.pending.requests)} href="/admin/requests" tone={s?.pending.requests ? 'warn' : 'default'} />
      <StatTile icon="image" label={$t('admin.dash.svc.previews')} value={s ? fmtNumber(s.pending.previewsFailed) : null} href="/admin/previews" hint={s ? $t('admin.dash.state.failed', { n: s.pending.previewsFailed }) : ''} tone={s?.pending.previewsFailed ? 'err' : 'default'} />
    </div>
  {/if}
</section>

<p class="foot"><Button variant="ghost" icon="refresh" pending={refreshing} on:click={() => { void reloadSummary(); slow(); void loadStr(); }}>{$t('admin.playback.refresh')}</Button></p>

<style>
  .intro { margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  section { margin-bottom: 1.4rem; }
  section > h2 { margin-bottom: .6rem; }
  .sh { display: flex; align-items: center; gap: .5rem 1rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .sp { flex: 1; }
  .small { font-size: .85rem; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 1rem; }
  @media (min-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: .8rem; }
  .foot { margin: 0; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .7rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
