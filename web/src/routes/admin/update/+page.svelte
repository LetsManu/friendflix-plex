<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Admin → Update: version card, check, update with confirm + progress steps (Portainer redeploy), changelog. */
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, hasKey, t, tr, trDynamic } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { confirm } from '#lib/ui/confirm';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { Column } from '#lib/ui/table';
  import VersionEgg from '#lib/version/VersionEgg.svelte';
  import { parseNotes } from '#lib/version/notes';

  interface Commit { sha: string; url: string; message: string; author: string; date: string }
  interface Release { version: string; codename: string | null; tag: string; name: string; url: string; publishedAt: string | null; notes: string }
  interface Info {
    current: { sha: string; builtAt?: string | null; version?: string; codename?: string };
    /** newest GitHub release (primary comparison); null before the first release */
    release?: Release | null;
    updateAvailable?: boolean | null;
    latest?: { sha: string; date?: string | null; runUrl?: string } | null;
    behind?: number | null;
    error?: string;
    portainer: { configured: boolean };
    commits: Commit[];
  }

  /** hint for a network error code / name of the failed Portainer step (undefined when unknown) */
  const hint = (code: string) => (hasKey(`admin.update.hint.${code}`) ? trDynamic(`admin.update.hint.${code}`) : undefined);
  const step = (s: string) => (hasKey(`admin.update.step.${s}`) ? trDynamic(`admin.update.step.${s}`) : s);
  /** error text for a failed update request */
  function updateError(e: any): string {
    if (e?.status === 429) return tr('admin.update.tooSoon');
    if (e?.status === 409) return tr('admin.update.notConfigured');
    if (e?.body?.error === 'portainer_unreachable') {
      const code = e.body?.code, h = code ? hint(code) : undefined;
      return tr('admin.update.unreachable', { detail: code ? ` (${code}${h ? `: ${h}` : ''})` : '' });
    }
    if (e?.status && e.status < 500 && e.status !== 502) return errorText(e);
    return tr('admin.update.portainerError', { detail: (e?.body?.status ? tr('admin.update.httpDetail', { status: String(e.body.status) }) : '') + (e?.body?.step ? tr('admin.update.atStep', { step: step(e.body.step) }) : '') });
  }

  let u: Info | null = null, loadErr = false;
  let force = false;
  let phase: '' | 'started' | 'restarting' | 'newversion' | 'done' | 'timeout' = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let t0 = 0, now = Date.now();
  const sha7 = (s: string) => s.slice(0, 7);
  const dt = (d?: string | null) => (d ? fmtDateTime(d) : tr('admin.update.unknown'));
  /** release-based when a release exists, else the commit comparison with main (older backends send no release fields) */
  $: byRelease = u?.updateAvailable === true || u?.updateAvailable === false;
  $: upToDate = byRelease ? u?.updateAvailable === false && !u?.behind : u?.behind === 0;
  $: notes = u?.release?.notes ? parseNotes(u.release.notes) : [];
  const verLabel = (v: string, c?: string | null) => (c ? `${v} · ${c}` : v);
  $: busy = $busyKeys.has('update:check') || $busyKeys.has('update:start');
  $: running = phase === 'started' || phase === 'restarting' || phase === 'newversion';

  async function load() {
    loadErr = false;
    try { u = await api<Info>('/api/admin/update'); } catch { loadErr = true; }
  }
  function check() {
    void runAction({
      key: 'update:check', run: () => api<Info>('/api/admin/update?refresh=1'),
      success: (r) => (r?.updateAvailable ? tr('admin.update.updateAvailable')
        : r?.updateAvailable === false || r?.behind === 0 ? tr('adminContent.update.checkedUpToDate')
          : r?.behind ? tr('admin.update.behind', { n: r.behind }) : tr('adminContent.update.checked')),
    }).then((res) => { if (res.ok && res.value) u = res.value; });
  }

  async function start() {
    if (!u || !(await confirm({ title: tr('admin.update.confirm'), body: tr('adminContent.update.confirmBody', { sha: u.latest ? sha7(u.latest.sha) : sha7(u.current.sha) }), danger: true, confirmLabel: tr('admin.update.updateNow') }))) return;
    const res = await runAction({
      key: 'update:start', run: () => api('/api/admin/update', { method: 'POST' }), error: updateError,
    });
    if (!res.ok || !u) return;
    phase = 'started'; t0 = Date.now(); now = t0;
    const target = u.latest?.sha ?? u.current.sha;
    const from = u.current.sha;
    let down = false; // a forced reload of the same version is only detectable by the restart gap
    timer = setInterval(async () => {
      now = Date.now();
      if (now - t0 > 5 * 60_000) { stop(); phase = 'timeout'; return; }
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        if (!r.ok) throw new Error();
        const { sha } = await r.json();
        if (sha === target && (sha !== from || down)) { stop(); phase = 'done'; setTimeout(() => location.reload(), 2500); }
        else if (down) phase = 'newversion';
      } catch { down = true; phase = 'restarting'; }
    }, 3000);
  }
  function stop() { clearInterval(timer); timer = undefined; }
  onMount(load);
  onDestroy(stop);

  const STEPS = ['started', 'restarting', 'newversion', 'done'] as const;
  $: stepIdx = phase === 'timeout' ? -1 : STEPS.indexOf(phase as (typeof STEPS)[number]);
  $: elapsed = phase && t0 ? Math.max(0, Math.round((now - t0) / 1000)) : 0;

  $: commitCols = [
    { key: 'message', label: $t('adminContent.update.commit'), value: (c) => c.message, primary: true, sortable: false },
    { key: 'author', label: $t('adminContent.update.author'), value: (c) => c.author, sortable: false },
    { key: 'date', label: $t('adminContent.update.date'), value: (c) => c.date, sortable: false },
  ] as Column<Commit>[];
</script>

<p class="intro muted">{$t('admin.update.intro')}</p>

{#if loadErr}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.update.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if !u}
  <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="40%" h="1.3rem" /><Skeleton w="60%" h="1rem" /><Skeleton w="10rem" h="2.6rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
{:else}
  <AdminCard title={$t('adminContent.update.versionTitle')}>
    <svelte:fragment slot="actions">
      <Button variant="secondary" icon="refresh" pending={$busyKeys.has('update:check')} disabled={running || $busyKeys.has('update:start')} on:click={check}>{$t('admin.update.check')}</Button>
    </svelte:fragment>
    <dl class="ver">
      <div><dt>{$t('admin.update.installed')}</dt><dd>
        {#if u.current.version}<span class="v"><VersionEgg version={u.current.version} codename={u.current.codename ?? ''} label={verLabel(u.current.version, u.current.codename)} /></span>
          <span class="muted">{$t('admin.update.buildSha', { sha: sha7(u.current.sha) })}</span>
        {:else}<code>{sha7(u.current.sha)}</code>{/if}
        <span class="muted">{$t('admin.update.builtAt', { date: dt(u.current.builtAt) })}</span></dd></div>
      {#if u.release}
        <div><dt>{$t('admin.update.latestRelease')}</dt><dd><span class="v">{verLabel(u.release.version, u.release.codename)}</span>{#if u.release.publishedAt} <span class="muted">{$t('admin.update.builtAt', { date: dt(u.release.publishedAt) })}</span>{/if}{#if u.release.url}<span aria-hidden="true"> · </span><a href={u.release.url} target="_blank" rel="noopener">{$t('admin.update.releaseLink')}</a>{/if}</dd></div>
      {/if}
      {#if u.latest}
        <div><dt>{$t('admin.update.latest')}</dt><dd><code>{sha7(u.latest.sha)}</code> <span class="muted">{$t('admin.update.builtAt', { date: dt(u.latest.date) })}</span>{#if u.latest.runUrl}<span aria-hidden="true"> · </span><a href={u.latest.runUrl} target="_blank" rel="noopener">{$t('admin.update.ciRun')}</a>{/if}</dd></div>
      {/if}
      <div><dt>{$t('adminContent.update.state')}</dt><dd>
        {#if u.updateAvailable}<StatusPill tone="warn" icon="download" label={$t('admin.update.updateAvailable')} />
        {:else if u.updateAvailable === false}<StatusPill tone="ok" label={$t('admin.update.upToDate')} />
        {:else if !u.latest}<StatusPill tone="muted" label={$t('admin.update.unknownState')} />
        {:else if upToDate}<StatusPill tone="ok" label={$t('admin.update.upToDate')} />
        {:else if u.behind}<StatusPill tone="warn" icon="download" label={$t('admin.update.behind', { n: u.behind })} />
        {:else}<StatusPill tone="muted" label={$t('admin.update.unknownState')} />{/if}
      </dd></div>
    </dl>
    {#if byRelease && u.behind}<p class="muted small">{$t('admin.update.mainAhead', { n: u.behind })}</p>{/if}
    {#if !u.release && !u.error && u.latest}<p class="muted small">{$t('admin.update.noRelease')}</p>{/if}
    {#if !u.latest && !u.release}<p class="err small" role="alert">{$t('admin.update.latestFailed', { error: u.error ?? $t('admin.update.unknown') })}</p>{/if}
    {#if u.release && notes.length}
      <details class="notes">
        <summary>{$t('admin.update.whatsNew', { version: verLabel(u.release.version, u.release.codename) })}</summary>
        <div class="md">
          {#each notes as b, i (i)}
            {#if b.kind === 'h'}<h3>{b.text}</h3>
            {:else if b.kind === 'ul'}<ul>{#each b.items as it, j (j)}<li>{it}</li>{/each}</ul>
            {:else}<p>{b.text}</p>{/if}
          {/each}
        </div>
      </details>
    {/if}
    {#if u.current.sha === 'dev'}<p class="muted small">{$t('admin.update.devBuild')}</p>{/if}
  </AdminCard>

  <AdminCard title={$t('adminContent.update.applyTitle')}>
    {#if !u.portainer.configured}
      <p class="muted"><Rich text={$t('admin.update.setup')} /></p>
    {:else}
      <div class="apply">
        <Button icon="download" pending={$busyKeys.has('update:start')} disabled={running || busy || (upToDate && !force)} on:click={start}>{$t('admin.update.updateNow')}</Button>
        {#if upToDate}<Toggle label={$t('admin.update.force')} bind:checked={force} disabled={running} />{/if}
      </div>
    {/if}

    {#if phase}
      <div class="prog" aria-live="polite">
        {#if phase === 'timeout'}
          <p class="err" role="alert"><Icon name="alert" size={18} /> {$t('admin.update.timeout')}</p>
          <Button variant="secondary" icon="refresh" on:click={() => { phase = ''; void load(); }}>{$t('admin.update.check')}</Button>
        {:else}
          <Progress value={phase === 'done' ? 100 : null} label={phase === 'done' ? $t('admin.update.done') : $t('adminContent.update.working', { s: elapsed })} />
          <ol class="steps">
            {#each STEPS as s, i (s)}
              <li class:done={i < stepIdx || phase === 'done'} class:cur={i === stepIdx && phase !== 'done'} aria-current={i === stepIdx && phase !== 'done' ? 'step' : undefined}>
                <span class="dot" aria-hidden="true">{#if i < stepIdx || phase === 'done'}<Icon name="check" size={14} />{:else if i === stepIdx}<span class="spinner"></span>{/if}</span>
                <span>{$t(`adminContent.update.step.${s}` as 'adminContent.update.step.started')}</span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>
    {/if}
  </AdminCard>

  {#if u.commits.length}
    <AdminCard title={$t('admin.update.changes')}>
      <DataTable caption={$t('admin.update.changes')} rows={u.commits} columns={commitCols} key={(c) => c.sha} pageSize={10}>
        <svelte:fragment slot="cell" let:row let:col>
          {#if col.key === 'message'}<a href={row.url} target="_blank" rel="noopener">{row.message}</a>
          {:else if col.key === 'date'}<time datetime={row.date} title={fmtDateTime(row.date)}>{fmtRelative(row.date)}</time>
          {:else}{col.value?.(row) ?? ''}{/if}
        </svelte:fragment>
      </DataTable>
    </AdminCard>
  {/if}
{/if}

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .ver { margin: 0; display: grid; gap: .7rem; }
  .ver > div { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: .6rem; align-items: center; }
  dt { color: var(--mut); font-size: .9rem; } dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  dd a, :global(td) a { color: var(--info); } dd a:hover, :global(td) a:hover { text-decoration: underline; }
  .small { font-size: .88rem; margin: .8rem 0 0; }
  .apply { display: flex; align-items: center; gap: 1.2rem; flex-wrap: wrap; }
  .prog { margin-top: 1.2rem; display: grid; gap: 1rem; max-width: 36rem; }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
  .steps li { display: flex; align-items: center; gap: .7rem; color: var(--mut); }
  .steps li.cur { color: var(--fg); font-weight: 600; } .steps li.done { color: var(--fg); }
  .dot { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #46505a; flex: none; font-size: .7rem; }
  .done .dot { background: var(--ok); border-color: var(--ok); color: #06210e; } .cur .dot { border-color: var(--warn); color: var(--warn); }
  .sk { display: grid; gap: .8rem; }
  .v { font-weight: 600; }
  .notes { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .8rem; }
  .notes summary { cursor: pointer; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
  .md { max-width: 70ch; } .md h3 { font-size: 1rem; margin: 1rem 0 .3rem; } .md ul { margin: 0; padding-left: 1.2rem; } .md li { margin: .25rem 0; } .md p { margin: .4rem 0; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
  time { color: var(--mut); white-space: nowrap; font-size: .9rem; }
  @media (max-width: 560px) { .ver > div { grid-template-columns: minmax(0, 1fr); gap: .2rem; } }
</style>
