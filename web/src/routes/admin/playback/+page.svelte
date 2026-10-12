<script lang="ts">
  import { t, tr, fmtDate, fmtDateTime, fmtNumber, hasKey, trDynamic } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  type Res = { itemId: string; name: string; type: string; ok: boolean; status: number | null; ms: number; bytes: number; error: string | null };
  let s: { running: boolean; done: number; total: number; startedAt: string | null; finishedAt: string | null; results: Res[] } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let err = '';
  $: failed = s?.results.filter((r) => !r.ok) ?? [];
  $: good = s?.results.filter((r) => r.ok) ?? [];
  const stop = () => { clearInterval(timer); timer = undefined; };
  async function load() {
    s = await api('/api/admin/playback-check');
    if (s?.running && !timer) timer = setInterval(load, 3000);
    else if (!s?.running && timer) stop();
  }
  async function start() {
    err = '';
    try { await api('/api/admin/playback-check', { method: 'POST' }); } catch (e: any) { err = e.status === 409 ? tr('admin.playback.running') : tr('admin.playback.startFailed'); }
    await load();
  }
  onMount(() => { load(); void loadDl(); });
  onDestroy(stop);

  // ---- Offline downloads: prepared files and active licenses ----
  type DlJob = { id: string; item_id: string; quality: string; audio_lang: string; status: string; seg_done: number; seg_total: number | null; bytes: string | number | null; error: string | null; updated_at: string; licenses: number };
  type DlLic = { id: string; item_id: string; title: string | null; series_name: string | null; user_name: string; device_label: string | null; quality: string; status: string; expires_at: string };
  let dl: { enabled: boolean; maxBytes: number; diskBytes: number; jobs: DlJob[]; licenses: DlLic[] } | null = null;
  let dlErr = '';
  const gb = (b: number | string | null | undefined) => tr('admin.playback.gb', { n: fmtNumber(Number(b ?? 0) / 1e9, { maximumFractionDigits: 1 }) });
  const status = (s: string) => (hasKey(`admin.playback.dlStatus.${s}`) ? trDynamic(`admin.playback.dlStatus.${s}`) : s);
  async function loadDl() {
    try { const r = await api('/api/admin/downloads'); dl = { enabled: Boolean(r.enabled), maxBytes: r.maxBytes ?? 0, diskBytes: r.diskBytes ?? 0, jobs: r.jobs ?? [], licenses: r.licenses ?? [] }; dlErr = ''; } catch { dlErr = tr('admin.playback.dlLoadFailed'); }
  }
  async function revoke(id: string) {
    if (!confirm(tr('admin.playback.dlConfirmRevoke'))) return;
    try { await api(`/api/admin/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { dlErr = tr('admin.playback.dlRevokeFailed'); }
    await loadDl();
  }
</script>
<p class="muted">{$t('admin.playback.intro')}</p>
<div class="flex" style="margin-bottom:1rem">
  <button disabled={s?.running} on:click={start}>{$t('admin.playback.start')}</button>
  {#if s?.running}<span class="muted">{s.done} / {s.total || '…'}</span>{/if}
  {#if s && !s.running && s.finishedAt}<span class="muted">{$t('admin.playback.last', { date: fmtDateTime(s.finishedAt) })}</span>{/if}
  {#if err}<span class="err">{err}</span>{/if}
</div>
{#if s?.running}<progress style="width:100%;margin-bottom:1rem" max={s.total || 1} value={s.done}></progress>{/if}
{#if s && (s.results.length || s.finishedAt)}
  <h3 class:err={failed.length} class:ok={!failed.length}>{failed.length ? $t('admin.playback.failedCount', { n: failed.length }) : $t('admin.playback.noErrors')}</h3>
  {#each failed as r}
    <div class="panel">
      <b class="err">{r.name}</b> <span class="muted">{r.type === 'Series' ? $t('admin.kind.series') : $t('admin.kind.movie')}{r.status ? ' · ' + $t('admin.playback.http', { status: String(r.status) }) : ''}</span>
      <div class="err" style="word-break:break-all">{r.error}</div>
      {#if r.error?.includes('500')}<div class="muted">{$t('admin.playback.transcodeHint')}</div>{/if}
    </div>
  {/each}
  <details class="panel">
    <summary>{$t('admin.playback.okCount', { n: good.length })}</summary>
    {#each good as r}<div class="flex"><span>{r.name}</span><span class="muted">{$t('admin.playback.seconds', { n: fmtNumber(r.ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span></div>{/each}
  </details>
{/if}

<h2>{$t('admin.playback.dlTitle')}</h2>
<p class="muted"><Rich text={$t('admin.playback.dlIntro')} /></p>
{#if dlErr}<p class="err">{dlErr}</p>{/if}
{#if dl}
  {#if !dl.enabled}<p class="muted"><Rich text={$t('admin.playback.dlDisabled')} /></p>{/if}
  <div class="flex"><span>{$t('admin.playback.dlStorage', { used: gb(dl.diskBytes), max: gb(dl.maxBytes) })}</span><button class="sec" on:click={loadDl}>{$t('admin.playback.refresh')}</button></div>
  <progress style="width:100%;margin:.5rem 0 1rem" max={dl.maxBytes || 1} value={dl.diskBytes}></progress>
  <h3>{$t('admin.playback.jobs', { n: dl.jobs.length })}</h3>
  {#each dl.jobs as j (j.id)}
    <div class="panel">
      <b>{j.item_id}</b> <span class="muted">{j.quality} · {status(j.status)}{j.status === 'preparing' && j.seg_total ? ` · ${Math.round((j.seg_done / j.seg_total) * 100)} %` : ''}{j.bytes ? ` · ${gb(j.bytes)}` : ''} · {$t('admin.playback.licenseCount', { n: j.licenses })}</span>
      {#if j.error}<div class="err" style="word-break:break-all">{j.error}</div>{/if}
    </div>
  {:else}<p class="muted">{$t('admin.playback.noJobs')}</p>{/each}
  <h3>{$t('admin.playback.licenses', { n: dl.licenses.length })}</h3>
  {#each dl.licenses as l (l.id)}
    <div class="panel flex">
      <span><b>{l.series_name ? `${l.series_name} · ` : ''}{l.title ?? l.item_id}</b> <span class="muted">{l.user_name}{l.device_label ? ` · ${l.device_label}` : ''} · {l.quality} · {status(l.status)} · {$t('admin.playback.until', { date: fmtDate(l.expires_at, { dateStyle: 'medium' }) })}</span></span>
      <button class="sec" on:click={() => revoke(l.id)}>{$t('admin.revoke')}</button>
    </div>
  {:else}<p class="muted">{$t('admin.playback.noLicenses')}</p>{/each}
{/if}
