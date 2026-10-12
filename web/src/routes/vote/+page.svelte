<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import { pollDelay, voteError } from '#lib/polls';
  import { t, tr, type TKey } from '#lib/i18n';

  let polls: any[] = [], loaded = false, now = Date.now(), timer: ReturnType<typeof setInterval>, pollT: ReturnType<typeof setTimeout>, msg = '', loadErr = '', failures = 0, gone = false;
  let creating = false, creatingBusy = false, searching = false, searchMsg = '', title = tr('social.vote.defaultTitle'), closes = 60, after = 10, options: Array<{ key: string; label: string; body: object }> = [];
  let q = '', libResults: Item[] = [], wishResults: any[] = [], voting = new Set<string>();
  const STATUS = ['open', 'scheduled', 'needs_approval', 'requested', 'started', 'cancelled'];
  const statusLabel = (s: string) => (STATUS.includes(s) ? $t(`social.vote.status.${s}` as TKey) : s);

  /** never throws: a failed refresh is shown as a message and counted for the poll back-off */
  async function load() {
    try { polls = (await api('/api/polls')).polls; failures = 0; loadErr = ''; }
    catch { failures++; loadErr = tr('social.vote.loadFailed'); }
    loaded = true;
  }
  /** background refresh every 15 s; backs off after errors and stops after a few */
  function schedule() {
    clearTimeout(pollT);
    const d = pollDelay(failures);
    if (gone || d === null) return;
    pollT = setTimeout(async () => { await load(); schedule(); }, d);
  }
  async function reload() { failures = 0; await load(); schedule(); }
  const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), p = { h, m: Math.floor((s % 3600) / 60), s: s % 60 }; return h ? tr('social.vote.countdownH', p) : tr('social.vote.countdownM', p); };
  async function vote(p: any, optionId: number) {
    if (voting.has(p.id)) return;
    msg = ''; voting.add(p.id); voting = voting;
    try { await api(`/api/polls/${p.id}/vote`, { method: 'POST', body: { optionId } }); }
    catch (e) { msg = voteError(e); }
    await load();
    voting.delete(p.id); voting = voting;
  }
  async function search() {
    if (q.trim().length < 2 || searching) return;
    searching = true; searchMsg = '';
    try {
      libResults = (await api(`/api/library/items?q=${encodeURIComponent(q.trim())}&types=Movie&limit=12`)).items;
      wishResults = (await api(`/api/seerr/search?q=${encodeURIComponent(q.trim())}`).catch(() => ({ results: [] }))).results.filter((r: any) => r.status === 'nicht_angefragt');
      if (!libResults.length && !wishResults.length) searchMsg = tr('social.vote.nothingFound');
    } catch { searchMsg = tr('social.searchUnavailable'); }
    searching = false;
  }
  const add = (key: string, label: string, body: object) => { if (!options.some((o) => o.key === key)) options = [...options, { key, label, body }]; };
  async function create() {
    if (creatingBusy) return;
    creatingBusy = true; msg = '';
    try {
      await api('/api/polls', { method: 'POST', body: { title, options: options.map((o) => o.body), closesInMinutes: closes, startsAfterMinutes: after } });
      creating = false; options = []; await load();
    } catch (e: any) { msg = e?.body?.error === 'poll_already_open' ? tr('social.vote.alreadyOpen') : tr('social.vote.createFailed'); }
    creatingBusy = false;
  }
  onMount(() => { void reload(); timer = setInterval(() => { now = Date.now(); }, 1000); });
  onDestroy(() => { gone = true; clearInterval(timer); clearTimeout(pollT); });
</script>

<h1>{$t('social.vote.title')}</h1>
<div role="status">{#if msg}<p class="warn">{msg}</p>{/if}</div>
{#if loadErr}<p class="err" role="alert">{loadErr}{#if pollDelay(failures) === null} {$t('social.vote.paused')}{/if} <button type="button" class="sec" on:click={reload}>{$t('common.retry')}</button></p>{/if}
<button on:click={() => (creating = !creating)}>{creating ? $t('common.cancel') : $t('social.vote.newPoll')}</button>
{#if creating}
  <div class="panel" style="margin-top:1rem">
    <div class="flex"><input bind:value={title} maxlength="80" aria-label={$t('social.vote.pollTitle')} /><label>{$t('social.vote.duration')} <input type="number" min="5" bind:value={closes} style="width:5rem" /> {$t('social.vote.minutes')}</label><label>{$t('social.vote.startAfter')} <input type="number" min="0" bind:value={after} style="width:5rem" /> {$t('social.vote.minutes')}</label></div>
    <form class="flex" style="margin:.8rem 0" on:submit|preventDefault={search}><input placeholder={$t('social.vote.searchPlaceholder')} aria-label={$t('social.vote.searchAria')} bind:value={q} /><button disabled={searching}>{$t('social.search')}</button></form>
    <div role="status">{#if searchMsg}<p class="muted">{searchMsg}</p>{/if}</div>
    <div class="flex">
      {#each libResults as i}<button class="sec" on:click={() => add(i.id, i.name, { jfItemId: i.id })}>+ {i.name}</button>{/each}
      {#each wishResults as r}<button class="sec" on:click={() => add(`t${r.tmdbId}`, tr('social.vote.notThereYet', { title: r.title }), { tmdbId: r.tmdbId, mediaType: r.mediaType })}>{$t('social.vote.addWish', { title: r.title })}</button>{/each}
    </div>
    <p class="muted">{$t('social.vote.wishHint')}</p>
    <b>{$t('social.vote.selection', { n: options.length })}</b> {#each options as o}<span class="badge">{o.label} <button type="button" class="x" aria-label={$t('social.vote.removeOption', { label: o.label })} on:click={() => (options = options.filter((x) => x !== o))}>×</button></span> {/each}
    <p><button disabled={options.length < 2 || creatingBusy} on:click={create}>{$t('social.vote.start')}</button></p>
  </div>
{/if}

{#each polls as p}
  <div class="panel">
    <h3>{p.title} <span class="badge">{statusLabel(p.status)}</span></h3>
    <p class="muted">{$t('social.by', { name: p.creator })}
      {#if p.status === 'open'}· {$t('social.vote.endsIn', { time: fmt(new Date(p.closesAt).getTime() - now) })}{/if}
      {#if p.status === 'scheduled'}· {$t('social.vote.startsIn', { time: fmt(new Date(p.startsAt).getTime() - now) })}{/if}</p>
    {#each p.options as o}
      {@const total = p.options.reduce((a: number, x: any) => a + x.votes, 0) || 1}
      <div class="flex" style="margin:.3rem 0">
        <button class:sec={p.myVote !== o.id} disabled={p.status !== 'open' || o.hidden || voting.has(p.id)} aria-pressed={p.myVote === o.id} on:click={() => vote(p, o.id)} style="min-width:14rem;text-align:left">{o.hidden ? $t('social.vote.titleUnavailable') : o.title}{o.hidden || o.inLibrary ? '' : ' ' + $t('social.vote.wishTag')}{p.winnerOptionId === o.id ? ' – ' + $t('social.vote.winner') : ''}</button>
        <div class="bar" style="flex:1;min-width:80px"><i style="width:{(o.votes / total) * 100}%"></i></div><span>{o.votes}</span>
      </div>
    {/each}
    {#if p.roomId && (p.status === 'scheduled' || p.status === 'started')}<a class="btn" href="/party/{p.roomId}">{$t('social.vote.toRoom')}</a>{/if}
  </div>
{/each}
{#if loaded && !polls.length && !loadErr}<p class="muted">{$t('social.vote.none')}</p>{/if}

<style>
  .x { min-height: 44px; min-width: 44px; padding: 0 .5rem; background: none; border: 0; color: inherit; font-size: 1.2rem; line-height: 1; cursor: pointer; }
</style>
