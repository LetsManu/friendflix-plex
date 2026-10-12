<script lang="ts">
  /** Admin → Status: health of the connected services and the numbers behind the portal; every tile links to where it is handled. */
  import { onDestroy, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtNumber, t } from '#lib/i18n';
  import { poll } from '#lib/adminContent/poll';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { refreshSummary, summary, summaryFailed } from '#lib/admin/summary';
  import Button from '#lib/ui/Button.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { fmtBytes } from '#lib/ui/format';

  $: s = $summary;
  let stop = () => {};
  let refreshing = false;
  const reload = async () => { refreshing = true; await refreshSummary(); refreshing = false; };
  onMount(() => { void reload(); stop = poll(refreshSummary, 20_000); });
  onDestroy(() => stop());

  type Svc = { id: string; icon: string; href: string; tone: Tone; text: string };
  $: svcs = (s ? [
    { id: 'jellyfin', icon: 'film', href: '/admin/playback', tone: s.services.jellyfin ? 'ok' : 'err', text: s.services.jellyfin ? $t('admin.dash.state.ok') : $t('admin.dash.state.down') },
    { id: 'seerr', icon: 'inbox', href: '/admin/requests', tone: s.services.seerr ? 'ok' : 'err', text: s.services.seerr ? $t('admin.dash.state.ok') : $t('admin.dash.state.down') },
    { id: 'previews', icon: 'image', href: '/admin/previews', tone: s.pending.previewsFailed ? 'err' : 'ok', text: s.pending.previewsFailed ? $t('admin.dash.state.failed', { n: s.pending.previewsFailed }) : $t('admin.dash.state.allOk') },
    s.playbackCheck
      ? { id: 'playback', icon: 'play', href: '/admin/playback', tone: s.playbackCheck.failed ? 'err' : 'ok', text: s.playbackCheck.failed ? $t('admin.dash.state.failed', { n: s.playbackCheck.failed }) : $t('admin.dash.state.allOk') }
      : { id: 'playback', icon: 'play', href: '/admin/playback', tone: 'muted', text: $t('admin.dash.state.never') },
  ] : null) as Svc[] | null;
</script>

{#if $summaryFailed && !s}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.status.loadFailed')}</p><Button variant="secondary" icon="refresh" pending={refreshing} on:click={reload}>{$t('ui.retry')}</Button></div>
{:else}
  <section class="health" aria-labelledby="st-health">
    <h2 id="st-health">{$t('admin.dash.health')}</h2>
    <ul>
      {#each svcs ?? [null, null, null, null] as v, i (v?.id ?? i)}
        <li>
          {#if v}
            <a href={v.href}><span class="hi" aria-hidden="true"><Icon name={v.icon} size={18} /></span><span class="hl">{$t(`admin.dash.svc.${v.id}` as 'admin.dash.svc.jellyfin')}</span><StatusPill tone={v.tone} label={v.text} /></a>
          {:else}<span class="hsk" aria-hidden="true"><Skeleton w="60%" h=".9rem" /><Skeleton w="5rem" h="1.3rem" radius="99px" /></span>{/if}
        </li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="st-num">
    <h2 id="st-num">{$t('adminContent.status.numbers')}</h2>
    <div class="stats">
      <StatTile icon="users" label={$t('admin.status.users')} value={s ? fmtNumber(s.users.active) : null} href="/admin/users" hint={s ? `${$t('admin.dash.locked')}: ${fmtNumber(s.users.locked)}` : ''} />
      <StatTile icon="play" label={$t('admin.status.activeStreams')} value={s ? fmtNumber(s.live.streams) : null} href="/admin/playback" />
      <StatTile icon="tv" label={$t('admin.status.partyRooms')} value={s ? fmtNumber(s.live.partyRooms) : null} />
      <StatTile icon="mail" label={$t('admin.status.openInvites')} value={s ? fmtNumber(s.pending.invites) : null} href="/admin/invites" />
      <StatTile icon="monitor" label={$t('admin.status.pendingDevices')} value={s ? fmtNumber(s.pending.devices) : null} href="/admin/devices" tone={s?.pending.devices ? 'warn' : 'default'} />
      <StatTile icon="vote" label={$t('admin.status.pendingPolls')} value={s ? fmtNumber(s.pending.polls) : null} href="/admin/polls" tone={s?.pending.polls ? 'warn' : 'default'} />
      <StatTile icon="inbox" label={$t('adminContent.status.pendingRequests')} value={!s ? null : s.pending.requests === null ? '–' : fmtNumber(s.pending.requests)} href="/admin/requests" tone={s?.pending.requests ? 'warn' : 'default'} />
    </div>
  </section>

  <AdminCard title={$t('admin.dash.storage')}>
    {#if !s}<Skeleton lines={3} h="1.1rem" />
    {:else}
      <div class="sto">
        {#if s.storage.downloadsEnabled}
          <Progress label={$t('admin.dash.downloads')} value={s.storage.downloadsBytes} max={s.storage.downloadsMaxBytes || 1} tone={s.storage.downloadsBytes > s.storage.downloadsMaxBytes * 0.9 ? 'warn' : 'acc'} />
          <p class="muted small">{$t('admin.dash.usedOf', { used: fmtBytes(s.storage.downloadsBytes), max: fmtBytes(s.storage.downloadsMaxBytes) })}</p>
        {:else}
          <p class="kv"><span>{$t('admin.dash.downloads')}</span><StatusPill tone="muted" label={$t('admin.dash.downloadsOff')} /></p>
        {/if}
        <p class="kv"><span>{$t('admin.dash.previews')}</span><span>{fmtBytes(s.storage.previewBytes)} <span class="muted">· {$t('admin.dash.clips', { n: s.storage.previewClips })}</span></span></p>
        {#if s.playbackCheck}<p class="kv"><span>{$t('admin.dash.svc.playback')}</span><span class="muted">{fmtDateTime(s.playbackCheck.finishedAt)}</span></p>{/if}
      </div>
    {/if}
  </AdminCard>

  <p class="foot"><Button variant="ghost" size="sm" icon="refresh" pending={refreshing} on:click={reload}>{$t('admin.playback.refresh')}</Button></p>
{/if}

<style>
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0 0 .6rem; }
  section { margin-bottom: 1.4rem; }
  .health ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: .6rem; }
  .health a, .hsk { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; min-height: 64px; padding: .7rem .9rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; transition: background var(--t-fast); }
  .hsk { flex-direction: column; align-items: flex-start; justify-content: center; }
  .health a:hover { background: #1b2127; }
  .hi { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.08); flex: none; }
  .hl { flex: 1; min-width: 6rem; font-weight: 600; font-size: .92rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: .8rem; }
  .sto { display: grid; gap: .7rem; max-width: 36rem; }
  .sto p { margin: 0; } .small { font-size: .85rem; }
  .kv { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .foot { margin: 0; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .7rem; text-align: center; padding: 3rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
