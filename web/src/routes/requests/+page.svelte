<script lang="ts">
  import { t, tr, fmtDate, hasKey, trDynamic } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, ApiError } from '#lib/api';
  import TrailerButton from '#lib/TrailerButton.svelte';
  import { episodeKey, loadReminders, movieKey, removeReminder } from '#lib/reminders';

  let q = $page.url.searchParams.get('q') ?? '', results: any[] = [], mine: any[] = [], msg = '', busy = false, mineErr = '', requesting = new Set<string>();
  let quota: { limit: number | null; used: number; remaining: number | null; resetsAt: string } | null = null;
  $: full = quota !== null && quota.limit !== null && (quota.remaining ?? 0) <= 0;
  const day = (iso: string) => fmtDate(iso, { dateStyle: 'medium' });
  const limitMsg = (resetsAt: string) => tr('social.requests.limit', { date: day(resetsAt) });
  /** true while `msg` is the request-limit message (it is already shown by the quota line) */
  let msgIsLimit = false;
  const loadQuota = async () => { try { quota = await api('/api/requests/quota'); } catch { /* optional */ } };
  /** request status label in the UI language ('' for not requested, unknown states as they are) */
  const label = (s: string): string => (s === 'nicht_angefragt' ? '' : hasKey(`social.requests.status.${s}`) ? trDynamic(`social.requests.status.${s}`) : s);
  const kindLabel = (mediaType: string) => (mediaType === 'tv' ? $t('social.kind.series') : $t('social.kind.movie'));
  const cls: Record<string, string> = { verfuegbar: 'ok', in_arbeit: 'warn', angefragt: 'warn', abgelehnt: 'err' };

  let reminders: any[] = [];
  const loadRem = async () => { try { reminders = (await api('/api/reminders')).reminders; } catch { reminders = []; } };
  async function unremind(r: any) {
    try { await removeReminder(r.kind === 'tmdb' ? movieKey(r.mediaType, r.tmdbId) : episodeKey(r.itemId), r.id); reminders = reminders.filter((x) => x.id !== r.id); } catch { msg = tr('social.requests.reminderRemoveFailed'); msgIsLimit = false; }
  }
  async function loadMine() {
    try { mine = (await api('/api/requests/mine')).requests; mineErr = ''; } catch { mineErr = tr('social.requests.mineFailed'); }
  }
  async function search() {
    if (q.trim().length < 2) return;
    busy = true; msg = ''; msgIsLimit = false;
    try { results = (await api(`/api/seerr/search?q=${encodeURIComponent(q.trim())}`)).results; } catch { msg = tr('social.searchUnavailable'); }
    busy = false;
  }
  async function request(r: any) {
    const k = `${r.mediaType}:${r.tmdbId}`;
    if (requesting.has(k)) return;
    requesting.add(k); requesting = requesting; msg = ''; msgIsLimit = false;
    try {
      await api('/api/requests', { method: 'POST', body: { mediaType: r.mediaType, tmdbId: r.tmdbId } });
      r.status = 'angefragt'; results = results; msg = tr('social.requests.requested', { title: r.title }); loadMine(); loadQuota();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && e.body?.error === 'request_limit') { msg = limitMsg(e.body.resetsAt); msgIsLimit = true; loadQuota(); }
      else msg = e instanceof ApiError && e.status === 409 ? tr('social.requests.duplicate') : tr('social.requests.failed');
    }
    requesting.delete(k); requesting = requesting;
  }
  onMount(() => { void loadReminders(); loadRem(); loadMine(); loadQuota(); if (q) search(); });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('social.requests.title') })}</title></svelte:head>
<h1>{$t('social.requests.title')}</h1>
<form class="flex" on:submit|preventDefault={search}>
  <input placeholder={$t('social.requests.searchPlaceholder')} bind:value={q} style="width:100%;max-width:480px" />
  <button disabled={busy}>{$t('social.search')}</button>
</form>
{#if quota && quota.limit !== null}<p class:warn={full} class:muted={!full}>{#if full}{limitMsg(quota.resetsAt)}{:else}{$t('social.requests.quota', { remaining: quota.remaining, limit: quota.limit })}{/if}</p>{/if}
<div role="status">{#if msg && !(full && msgIsLimit)}<p class="warn">{msg}</p>{/if}</div>
<div class="grid" style="margin-top:1rem">
  {#each results as r}
    <div class="card">
      {#if r.poster}<img loading="lazy" src={r.poster} alt={r.title} />{:else}<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />{/if}
      <div class="t">{r.title}<small>{r.year ?? ''} · {kindLabel(r.mediaType)}</small>
        {#if r.status === 'nicht_angefragt' || r.status === 'abgelehnt'}<button style="margin-top:.4rem;width:100%" disabled={full || requesting.has(`${r.mediaType}:${r.tmdbId}`)} on:click={() => request(r)}>{$t('social.requests.request')}</button>
        {:else}<span class={cls[r.status]}>{label(r.status)}</span>{/if}
        {#if r.status !== 'verfuegbar'}<div style="margin-top:.4rem"><TrailerButton mediaType={r.mediaType} tmdbId={r.tmdbId} title={r.title} /></div>{/if}
      </div>
    </div>
  {/each}
</div>
<h2 style="margin-top:2rem">{$t('social.requests.mine')}</h2>
{#if mineErr}<p class="err" role="alert">{mineErr} <button type="button" class="sec" on:click={loadMine}>{$t('social.tryAgain')}</button></p>{:else if !mine.length}<p class="muted">{$t('social.requests.nothingYet')}</p>{/if}
<table><tbody>{#each mine as m}<tr><td>{m.title}</td><td>{kindLabel(m.mediaType)}</td><td class={cls[m.status]}>{label(m.status)}</td><td class="muted">{day(m.createdAt)}</td></tr>{/each}</tbody></table>
<h2 style="margin-top:2rem">{$t('social.requests.reminders')}</h2>
{#if !reminders.length}<p class="muted">{$t('social.requests.noReminders')}</p>{/if}
<table><tbody>{#each reminders as r (r.id)}<tr><td>{r.title}</td><td>{r.kind === 'episode' ? $t('social.kind.episode') : kindLabel(r.mediaType)}</td><td class="muted">{r.releaseDate ? day(r.releaseDate) : $t('social.requests.dateOpen')}</td><td><button class="sec" aria-label={$t('social.requests.removeReminder', { title: r.title })} on:click={() => unremind(r)}>{$t('social.remove')}</button></td></tr>{/each}</tbody></table>
