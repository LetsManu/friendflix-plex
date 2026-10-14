<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Admin overview: health strip, things waiting for a decision (inline approve/decline), recent activity, counts, storage. */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtNumber, fmtRelative, t, tr } from '#lib/i18n';
  import { describeActivity, type AuditEntry } from '#lib/admin/activity';
  import { levelTone, loadHealth, serviceText, type HealthSnapshot, type ServiceId } from '#lib/admin/health';
  import { bumpPending, refreshSummary, summary, summaryFailed } from '#lib/admin/summary';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { fmtBytes } from '#lib/ui/format';

  type Req = { id: number; title: string; mediaType: string; requestedBy: string; createdAt?: string };
  type Dev = { user_id: string; device_id: string; label: string | null; name: string; approved: boolean; last_seen: string | null };
  const TOP = 3;
  let reqs: Req[] | null = null, devs: Dev[] | null = null, audit: AuditEntry[] | null = null;
  let reqErr = false, devErr = false, auditErr = false;
  let update: { behind: number | null; updateAvailable?: boolean | null } | null | 'err' = null;

  const loadReqs = () => api<{ requests: Req[] }>('/api/admin/requests?filter=pending').then((r) => { reqs = r.requests; reqErr = false; }, () => { reqs = []; reqErr = true; });
  const loadDevs = () => api<{ devices: Dev[] }>('/api/admin/devices').then((r) => { devs = r.devices.filter((d) => !d.approved); devErr = false; }, () => { devs = []; devErr = true; });
  const loadAudit = () => api<{ entries: AuditEntry[] }>('/api/admin/audit?limit=8').then((r) => { audit = r.entries; auditErr = false; }, () => { audit = []; auditErr = true; });
  const loadUpdate = () => api('/api/admin/update').then((u) => (update = u), () => (update = 'err'));
  // Block 22: the strip reads the health snapshot (media server, request service, playback check); the summary is the fallback
  let snap: HealthSnapshot | null = null;
  const loadSnap = () => loadHealth().then((h) => (snap = h), () => (snap = null));
  function loadAll() { void refreshSummary(); void loadReqs(); void loadDevs(); void loadAudit(); void loadUpdate(); void loadSnap(); }
  onMount(loadAll);

  /** removes a row optimistically; the returned rollback puts the list back */
  function take<T>(list: T[] | null, row: T, set: (l: T[]) => void): () => void {
    const prev = list ?? [];
    set(prev.filter((x) => x !== row));
    return () => set(prev);
  }
  const optimistic = <T>(list: T[] | null, row: T, set: (l: T[]) => void, key: 'requests' | 'devices') => () => {
    const undo = take(list, row, set);
    bumpPending(key, -1);
    return () => { undo(); bumpPending(key, 1); };
  };
  const afterOk = (res: { ok: boolean }) => { if (res.ok) void loadAudit(); };

  function approveReq(r: Req) {
    void runAction({
      key: `req:${r.id}`, apply: optimistic(reqs, r, (l) => (reqs = l), 'requests'),
      run: () => api(`/api/admin/requests/${r.id}/approve`, { method: 'POST' }),
      success: tr('admin.dash.approved', { title: r.title }),
    }).then(afterOk);
  }
  function declineReq(r: Req) {
    // one-way in Seerr: delay-commit with Undo instead of a confirm dialog
    void runAction({
      key: `req:${r.id}`, defer: true, apply: optimistic(reqs, r, (l) => (reqs = l), 'requests'),
      run: () => api(`/api/admin/requests/${r.id}/decline`, { method: 'POST' }),
      success: tr('admin.dash.declined', { title: r.title }),
    }).then(afterOk);
  }
  function approveDev(d: Dev) {
    void runAction({
      key: `dev:${d.user_id}:${d.device_id}`, apply: optimistic(devs, d, (l) => (devs = l), 'devices'),
      run: () => api('/api/admin/devices/approve', { method: 'POST', body: { userId: d.user_id, deviceId: d.device_id } }),
      success: tr('admin.dash.deviceApproved', { name: d.name }),
    }).then(afterOk);
  }

  $: s = $summary;
  type Health = { label: string; icon: string; href: string; tone: Tone; text: string } | null;
  const svc = (label: string, icon: string, href: string, tone: Tone, text: string): Health => ({ label, icon, href, tone, text });
  /** strip entry from the snapshot (null without one) */
  const fromSnap = (sn: HealthSnapshot | null, id: ServiceId, label: string, icon: string, href: string): Health => {
    const h = sn?.services.find((x) => x.id === id);
    return h ? svc(label, icon, href, levelTone(h.level), serviceText(h)) : null;
  };
  $: health = [
    fromSnap(snap, 'media', $t('admin.dash.svc.jellyfin'), 'film', '/admin/status')
      ?? (s ? svc($t('admin.dash.svc.jellyfin'), 'film', '/admin/status', s.services.jellyfin ? 'ok' : 'err', s.services.jellyfin ? $t('admin.dash.state.ok') : $t('admin.dash.state.down')) : null),
    fromSnap(snap, 'requests', $t('admin.dash.svc.seerr'), 'inbox', '/admin/requests')
      ?? (s ? svc($t('admin.dash.svc.seerr'), 'inbox', '/admin/requests', s.services.seerr ? 'ok' : 'err', s.services.seerr ? $t('admin.dash.state.ok') : $t('admin.dash.state.down')) : null),
    update === null ? null
      : update !== 'err' && update.updateAvailable != null ? svc($t('admin.dash.svc.update'), 'refresh', '/admin/update', update.updateAvailable ? 'warn' : 'ok', update.updateAvailable ? $t('admin.dash.state.updateAvailable') : $t('admin.dash.state.upToDate'))
      : update === 'err' || update.behind === null || update.behind === undefined ? svc($t('admin.dash.svc.update'), 'refresh', '/admin/update', 'muted', $t('admin.dash.state.unknown'))
      : svc($t('admin.dash.svc.update'), 'refresh', '/admin/update', update.behind ? 'warn' : 'ok', update.behind ? $t('admin.dash.state.behind', { n: update.behind }) : $t('admin.dash.state.upToDate')),
    s ? svc($t('admin.dash.svc.previews'), 'image', '/admin/previews', s.pending.previewsFailed ? 'err' : 'ok', s.pending.previewsFailed ? $t('admin.dash.state.failed', { n: s.pending.previewsFailed }) : $t('admin.dash.state.allOk')) : null,
    !s ? null : s.playbackCheck
      ? svc($t('admin.dash.svc.playback'), 'play', '/admin/playback', s.playbackCheck.failed ? 'err' : 'ok', s.playbackCheck.failed ? $t('admin.dash.state.failed', { n: s.playbackCheck.failed }) : $t('admin.dash.state.allOk'))
      : svc($t('admin.dash.svc.playback'), 'play', '/admin/playback', 'muted', $t('admin.dash.state.never')),
  ];
  $: reqPending = s?.pending.requests ?? reqs?.length ?? 0;
  $: devPending = s?.pending.devices ?? devs?.length ?? 0;
  $: attnLoading = reqs === null || devs === null || !s;
  $: nothing = !attnLoading && !reqs?.length && !devs?.length && !s?.pending.polls && !s?.pending.previewsFailed && !reqErr && !devErr;
  const REQ_ROWS = [['pending', 'warn', 'clock'], ['approved', 'info', 'check'], ['processing', 'info', 'download'], ['available', 'ok', 'check'], ['declined', 'muted', 'x']] as const;
</script>

{#if $summaryFailed && !s}
  <div class="panel failed" role="alert"><Icon name="alert" size={22} /><p>{$t('admin.dash.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={loadAll}>{$t('ui.retry')}</Button></div>
{/if}

<section class="health" aria-labelledby="dash-health">
  <h2 id="dash-health" class="sh">{$t('admin.dash.health')}</h2>
  <ul>
    {#each health as h, i (i)}
      <li>
        {#if h}
          <a href={h.href}><span class="hi" aria-hidden="true"><Icon name={h.icon} size={18} /></span><span class="hl">{h.label}</span><StatusPill tone={h.tone} label={h.text} /></a>
        {:else}<span class="hsk" aria-hidden="true"><Skeleton w="60%" h=".9rem" /><Skeleton w="5rem" h="1.3rem" radius="99px" /></span>{/if}
      </li>
    {/each}
  </ul>
</section>

<div class="cols">
  <section class="card" aria-labelledby="dash-attn">
    <div class="ch"><h2 id="dash-attn">{$t('admin.dash.attention')}</h2></div>
    {#if attnLoading}
      <div class="sk-list" aria-hidden="true">{#each [0, 1, 2] as i (i)}<div class="sk-row"><Skeleton w="55%" h="1rem" /><Skeleton w="7rem" h="2.2rem" /></div>{/each}</div>
      <p class="sr-only" role="status">{$t('ui.table.loading')}</p>
    {:else if nothing}
      <p class="clear"><span class="ok-ic" aria-hidden="true"><Icon name="check" size={20} /></span>{$t('admin.dash.allClear')}</p>
    {:else}
      {#if reqs?.length || reqErr}
        <div class="grp">
          <h3><Icon name="inbox" size={18} />{$t('admin.dash.pendingRequests')}{#if reqPending}<span class="n">{fmtNumber(reqPending)}</span>{/if}<a class="all" href="/admin/requests">{$t('admin.dash.showAll')}</a></h3>
          {#if reqErr}<p class="muted small">{$t('admin.dash.sectionFailed')}</p>{/if}
          <ul class="rows">
            {#each (reqs ?? []).slice(0, TOP) as r (r.id)}
              {@const busy = $busyKeys.has(`req:${r.id}`)}
              <li aria-busy={busy ? 'true' : undefined}>
                <span class="rt"><b>{r.title}</b><span class="muted small">{r.mediaType === 'tv' ? $t('admin.kind.series') : $t('admin.kind.movie')} · {$t('admin.dash.by', { name: r.requestedBy, when: fmtRelative(r.createdAt) })}</span></span>
                <span class="ra">
                  <Button size="sm" icon="check" pending={busy} aria-label={$t('admin.dash.approveAria', { title: r.title })} on:click={() => approveReq(r)}>{$t('admin.approve')}</Button>
                  <Button size="sm" variant="ghost" icon="x" disabled={busy} aria-label={$t('admin.dash.declineAria', { title: r.title })} on:click={() => declineReq(r)}>{$t('admin.decline')}</Button>
                </span>
              </li>
            {/each}
          </ul>
          {#if (reqs?.length ?? 0) > TOP}<p class="more muted small">{$t('admin.dash.more', { n: (reqs?.length ?? 0) - TOP })}</p>{/if}
        </div>
      {/if}
      {#if devs?.length || devErr}
        <div class="grp">
          <h3><Icon name="monitor" size={18} />{$t('admin.dash.pendingDevices')}{#if devPending}<span class="n">{fmtNumber(devPending)}</span>{/if}<a class="all" href="/admin/devices">{$t('admin.dash.showAll')}</a></h3>
          {#if devErr}<p class="muted small">{$t('admin.dash.sectionFailed')}</p>{/if}
          <ul class="rows">
            {#each (devs ?? []).slice(0, TOP) as d (d.user_id + d.device_id)}
              {@const busy = $busyKeys.has(`dev:${d.user_id}:${d.device_id}`)}
              <li aria-busy={busy ? 'true' : undefined}>
                <span class="rt"><b>{d.label || d.device_id}</b><span class="muted small">{$t('admin.dash.by', { name: d.name, when: fmtRelative(d.last_seen) })}</span></span>
                <span class="ra"><Button size="sm" icon="check" pending={busy} aria-label={$t('admin.dash.approveDeviceAria', { device: d.label || d.device_id, name: d.name })} on:click={() => approveDev(d)}>{$t('admin.approve')}</Button></span>
              </li>
            {/each}
          </ul>
          {#if (devs?.length ?? 0) > TOP}<p class="more muted small">{$t('admin.dash.more', { n: (devs?.length ?? 0) - TOP })}</p>{/if}
        </div>
      {/if}
      {#if s?.pending.polls || s?.pending.previewsFailed}
        <ul class="links">
          {#if s.pending.polls}<li><a href="/admin/polls"><Icon name="vote" size={18} /><span>{$t('admin.dash.pendingPolls', { n: s.pending.polls })}</span><Icon name="chevron-right" size={18} /></a></li>{/if}
          {#if s.pending.previewsFailed}<li><a href="/admin/previews"><Icon name="alert" size={18} /><span>{$t('admin.dash.failedPreviews', { n: s.pending.previewsFailed })}</span><Icon name="chevron-right" size={18} /></a></li>{/if}
        </ul>
      {/if}
    {/if}
  </section>

  <section class="card" aria-labelledby="dash-act">
    <div class="ch"><h2 id="dash-act">{$t('admin.dash.activity')}</h2><a class="all" href="/admin/audit">{$t('admin.dash.toAudit')}</a></div>
    {#if audit === null}
      <div class="sk-list" aria-hidden="true">{#each [0, 1, 2, 3, 4] as i (i)}<div class="sk-row"><Skeleton w="30px" h="30px" radius="50%" /><Skeleton w="80%" h=".95rem" /></div>{/each}</div>
    {:else if auditErr}
      <p class="muted">{$t('admin.dash.sectionFailed')}</p>
    {:else if !audit.length}
      <p class="muted">{$t('admin.dash.noActivity')}</p>
    {:else}
      <ol class="feed">
        {#each audit as e (e.id)}
          {@const d = describeActivity(e)}
          <li><span class="fi" aria-hidden="true"><Icon name={d.icon} size={16} /></span><span class="ft">{d.text}</span><time datetime={e.at} title={fmtDateTime(e.at)}>{fmtRelative(e.at)}</time></li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<div class="stats">
  <StatTile icon="users" label={$t('admin.dash.total')} value={s ? fmtNumber(s.users.total) : null} href="/admin/users"
    hint={s ? `${$t('admin.dash.active')}: ${fmtNumber(s.users.active)} · ${$t('admin.dash.locked')}: ${fmtNumber(s.users.locked)}` : ''} />
  <StatTile icon="play" label={$t('admin.dash.streams')} value={s ? fmtNumber(s.live.streams) : null} hint={s ? `${$t('admin.dash.parties')}: ${fmtNumber(s.live.partyRooms)}` : ''} />
  <StatTile icon="mail" label={$t('admin.status.openInvites')} value={s ? fmtNumber(s.pending.invites) : null} href="/admin/invites" />
  <StatTile icon="vote" label={$t('admin.status.pendingPolls')} value={s ? fmtNumber(s.pending.polls) : null} href="/admin/polls" tone={s?.pending.polls ? 'warn' : 'default'} />
</div>

<div class="cols">
  <section class="card" aria-labelledby="dash-req">
    <div class="ch"><h2 id="dash-req">{$t('admin.dash.requests')}</h2>{#if s?.requests}<span class="muted small">{$t('admin.dash.reqTotal', { n: s.requests.total })}</span>{/if}</div>
    {#if !s}<Skeleton lines={4} h="1.1rem" />
    {:else if !s.requests}<p class="muted">{$t('admin.dash.reqUnavailable')}</p>
    {:else}
      <ul class="counts">
        {#each REQ_ROWS as [k, tone, icon] (k)}<li><StatusPill {tone} {icon} label={$t(`admin.dash.reqStatus.${k}`)} /><span class="cn">{fmtNumber(s.requests[k])}</span></li>{/each}
      </ul>
    {/if}
  </section>

  <section class="card" aria-labelledby="dash-sto">
    <div class="ch"><h2 id="dash-sto">{$t('admin.dash.storage')}</h2></div>
    {#if !s}<Skeleton lines={3} h="1.1rem" />
    {:else}
      <div class="sto">
        {#if s.storage.downloadsEnabled}
          <Progress label={$t('admin.dash.downloads')} value={s.storage.downloadsBytes} max={s.storage.downloadsMaxBytes || 1} tone={s.storage.downloadsBytes > s.storage.downloadsMaxBytes * .9 ? 'warn' : 'acc'} />
          <p class="muted small">{$t('admin.dash.usedOf', { used: fmtBytes(s.storage.downloadsBytes), max: fmtBytes(s.storage.downloadsMaxBytes) })}</p>
        {:else}
          <p class="kv"><span>{$t('admin.dash.downloads')}</span><StatusPill tone="muted" label={$t('admin.dash.downloadsOff')} /></p>
        {/if}
        <p class="kv"><span>{$t('admin.dash.previews')}</span><span>{fmtBytes(s.storage.previewBytes)} <span class="muted">· {$t('admin.dash.clips', { n: s.storage.previewClips })}</span></span></p>
      </div>
    {/if}
  </section>
</div>

<style>
  .sh, .card h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  .sh { margin-bottom: .6rem; }
  .small { font-size: .85rem; }
  .failed { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; color: var(--fg); }
  .failed p { margin: 0; flex: 1; }
  .failed :global(svg) { color: var(--err); }

  .health { margin-bottom: 1.4rem; }
  .health ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: .6rem; }
  .health a, .hsk { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; min-height: 64px; padding: .7rem .9rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; transition: background var(--t-fast); }
  .hsk { flex-direction: column; align-items: flex-start; justify-content: center; }
  .health a:hover { background: #1b2127; }
  .hi { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.08); flex: none; }
  .hl { flex: 1; min-width: 6rem; font-weight: 600; font-size: .92rem; }

  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; margin-bottom: 1rem; }
  @media (min-width: 1100px) { .cols { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; min-width: 0; }
  .ch { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; margin-bottom: .8rem; flex-wrap: wrap; }
  .all { color: var(--info); font-weight: 600; font-size: .88rem; min-height: 44px; display: inline-flex; align-items: center; }
  .all:hover { text-decoration: underline; }

  .clear { display: flex; align-items: center; gap: .7rem; margin: .3rem 0; color: var(--mut); }
  .ok-ic { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 50%; background: var(--tone-ok); color: var(--ok); }
  .grp + .grp, .grp + .links { margin-top: 1rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  h3 { display: flex; align-items: center; gap: .5rem; font-size: .95rem; margin: 0 0 .3rem; }
  h3 .n { min-width: 1.5rem; height: 1.5rem; padding: 0 .4rem; border-radius: 99px; display: inline-grid; place-items: center; font-size: .75rem; font-weight: 800; background: var(--warn); color: #1a1200; }
  h3 .all { margin-left: auto; }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { display: flex; align-items: center; gap: .8rem; padding: .55rem 0; transition: opacity var(--t-fast); }
  .rows li + li { border-top: 1px solid rgba(255,255,255,.05); }
  .rows li[aria-busy='true'] { opacity: .6; }
  .rt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .rt b { overflow-wrap: anywhere; }
  .ra { display: flex; gap: .4rem; flex: none; }
  .more { margin: .3rem 0 0; }
  .links { list-style: none; margin: 0; padding: 0; }
  .links a { display: flex; align-items: center; gap: .7rem; min-height: 44px; color: var(--warn); font-weight: 600; }
  .links a span { flex: 1; }
  .links a:hover span { text-decoration: underline; }
  .links a > :global(svg:last-child) { color: var(--mut); }
  @media (max-width: 560px) {
    .rows li { flex-wrap: wrap; }
    .ra { width: 100%; }
    .ra > :global(button) { flex: 1; }
  }

  .feed { list-style: none; margin: 0; padding: 0; }
  .feed li { display: flex; align-items: flex-start; gap: .7rem; padding: .5rem 0; font-size: .92rem; }
  .feed li + li { border-top: 1px solid rgba(255,255,255,.05); }
  .fi { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%; background: rgba(255,255,255,.08); color: var(--mut); }
  .ft { flex: 1; min-width: 0; padding-top: .25rem; overflow-wrap: anywhere; }
  time { flex: none; color: var(--mut); font-size: .8rem; padding-top: .3rem; white-space: nowrap; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 1rem; margin-bottom: 1rem; }
  .sk-list { display: flex; flex-direction: column; gap: .9rem; }
  .sk-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .counts { list-style: none; margin: 0; padding: 0; display: grid; gap: .45rem; }
  .counts li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 32px; }
  .cn { font-weight: 800; font-variant-numeric: tabular-nums; font-size: 1.05rem; }
  .sto { display: grid; gap: .7rem; }
  .sto p { margin: 0; }
  .kv { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
</style>
