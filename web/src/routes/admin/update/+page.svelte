<script lang="ts">
  import { t, tr, fmtDateTime, hasKey, trDynamic } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  /** hint for a network error code / name of the failed Portainer step (undefined when unknown) */
  const hint = (code: string) => (hasKey(`admin.update.hint.${code}`) ? trDynamic(`admin.update.hint.${code}`) : undefined);
  const step = (s: string) => (hasKey(`admin.update.step.${s}`) ? trDynamic(`admin.update.step.${s}`) : s);
  /** error text for a failed update request */
  function updateError(e: any): string {
    if (e.status === 429) return tr('admin.update.tooSoon');
    if (e.status === 409) return tr('admin.update.notConfigured');
    if (e.body?.error === 'portainer_unreachable') {
      const code = e.body?.code, h = code ? hint(code) : undefined;
      return tr('admin.update.unreachable', { detail: code ? ` (${code}${h ? `: ${h}` : ''})` : '' });
    }
    return tr('admin.update.portainerError', { detail: (e.body?.status ? tr('admin.update.httpDetail', { status: String(e.body.status) }) : '') + (e.body?.step ? tr('admin.update.atStep', { step: step(e.body.step) }) : '') });
  }
  let u: any = null;
  let busy = false;
  let force = false;
  let err = '';
  let phase: '' | 'started' | 'restarting' | 'done' | 'timeout' = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  const sha7 = (s: string) => s.slice(0, 7);
  const dt = (d?: string | null) => (d ? fmtDateTime(d) : tr('admin.update.unknown'));
  async function load(refresh = false) {
    busy = true;
    try { u = await api('/api/admin/update' + (refresh ? '?refresh=1' : '')); } finally { busy = false; }
  }
  $: upToDate = u?.behind === 0;
  async function start() {
    if (!confirm(tr('admin.update.confirm'))) return;
    err = '';
    try { await api('/api/admin/update', { method: 'POST' }); } catch (e: any) {
      err = updateError(e);
      return;
    }
    phase = 'started';
    const t0 = Date.now();
    const target = u.latest?.sha ?? u.current.sha;
    let down = false; // forced reload of the same version is only detectable by the restart gap
    timer = setInterval(async () => {
      if (Date.now() - t0 > 5 * 60_000) { stop(); phase = 'timeout'; return; }
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        if (!r.ok) throw new Error();
        const { sha } = await r.json();
        if (sha === target && (sha !== u.current.sha || down)) { stop(); phase = 'done'; setTimeout(() => location.reload(), 1500); }
      } catch { down = true; phase = 'restarting'; }
    }, 3000);
  }
  function stop() { clearInterval(timer); timer = undefined; }
  onMount(() => load());
  onDestroy(stop);
</script>
<p class="muted">{$t('admin.update.intro')}</p>
{#if u}
  <div class="panel">
    <div class="flex">
      <span>{$t('admin.update.installed')} <b>{sha7(u.current.sha)}</b> {$t('admin.update.builtAt', { date: dt(u.current.builtAt) })}</span>
      {#if u.latest}
        <span class={upToDate ? 'ok' : 'warn'}>{upToDate ? $t('admin.update.upToDate') : u.behind ? $t('admin.update.behind', { n: u.behind }) : $t('admin.update.unknownState')}</span>
      {/if}
      <button class="sec" style="margin-left:auto" disabled={busy || !!phase} on:click={() => load(true)}>{$t('admin.update.check')}</button>
    </div>
    {#if u.latest}
      <div>{$t('admin.update.latest')} <b>{sha7(u.latest.sha)}</b> {$t('admin.update.builtAt', { date: dt(u.latest.date) })} · <a href={u.latest.runUrl} target="_blank" rel="noopener">{$t('admin.update.ciRun')}</a></div>
    {:else}
      <div class="err">{$t('admin.update.latestFailed', { error: u.error ?? $t('admin.update.unknown') })}</div>
    {/if}
    {#if u.current.sha === 'dev'}<div class="muted">{$t('admin.update.devBuild')}</div>{/if}
  </div>
  <div class="panel">
    <div class="flex">
      <button disabled={!u.portainer.configured || !!phase || busy || (upToDate && !force)} on:click={start}>{$t('admin.update.updateNow')}</button>
      {#if upToDate}<label class="flex"><input type="checkbox" bind:checked={force} /> {$t('admin.update.force')}</label>{/if}
    </div>
    {#if !u.portainer.configured}
      <p class="muted"><Rich text={$t('admin.update.setup')} /></p>
    {/if}
    {#if err}<p class="err">{err}</p>{/if}
    {#if phase === 'started'}<p class="warn">{$t('admin.update.started')}</p>{/if}
    {#if phase === 'restarting'}<p class="warn">{$t('admin.update.restarting')}</p>{/if}
    {#if phase === 'done'}<p class="ok">{$t('admin.update.done')}</p>{/if}
    {#if phase === 'timeout'}<p class="err">{$t('admin.update.timeout')}</p>{/if}
  </div>
  {#if u.commits.length}
    <h2>{$t('admin.update.changes')}</h2>
    {#each u.commits as c (c.sha)}
      <div class="panel flex">
        <a href={c.url} target="_blank" rel="noopener">{c.message}</a>
        <span class="muted" style="margin-left:auto">{c.author} · {dt(c.date)}</span>
      </div>
    {/each}
  {/if}
{/if}
