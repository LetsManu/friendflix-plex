<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr, fmtList } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';

  let friends: Array<{ id: string; name: string; sharesHistory: boolean }> = [], picked = new Set<string>();
  let type = 'Movie', maxMinutes = 0, genre = '', genres: string[] = [];
  let result: { participants: string[]; total: number; items: Array<Item & { planned?: number }> } | null = null, busy = false, polling = false, error = '', chosen = new Set<string>();
  onMount(async () => {
    friends = (await api('/api/friends').catch(() => ({ friends: [] }))).friends;
    genres = (await api('/api/library/genres').catch(() => ({ genres: [] }))).genres;
  });
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); picked = n; };
  async function run() {
    busy = true; error = ''; result = null; chosen = new Set();
    try { result = await api('/api/match', { method: 'POST', body: { userIds: [...picked], type, maxMinutes: maxMinutes || undefined, genre: genre || undefined } }); }
    catch (e: any) { error = e?.body?.error === 'history_not_shared' ? tr('social.match.notShared', { names: fmtList(e.body.names), n: e.body.names.length }) : tr('social.match.failed'); }
    busy = false;
  }
  const pick = (id: string) => { const n = new Set(chosen); if (n.has(id)) n.delete(id); else if (n.size < 10) n.add(id); chosen = n; };
  async function poll() {
    if (polling) return;
    polling = true; error = '';
    const r = await api('/api/polls', { method: 'POST', body: { title: tr('social.match.pollTitle'), options: [...chosen].map((jfItemId) => ({ jfItemId })), closesInMinutes: 60, startsAfterMinutes: 10 } }).catch((e: any) => { error = e?.body?.error === 'poll_already_open' ? tr('social.vote.alreadyOpen') : tr('social.vote.createFailed'); return null; });
    if (r) await goto('/vote');
    polling = false;
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('social.match.title') })}</title></svelte:head>
<h1>{$t('social.match.title')}</h1>
<p class="muted"><Rich text={$t('social.match.intro')} /></p>
<div class="panel">
  <h3>{$t('social.match.who')}</h3>
  <div class="flex">
    {#each friends as f (f.id)}
      <label class="pill" class:off={!f.sharesHistory}><input type="checkbox" disabled={!f.sharesHistory} checked={picked.has(f.id)} on:change={() => toggle(f.id)} />{f.name}{#if !f.sharesHistory}<small class="muted"> {$t('social.match.notSharedTag')}</small>{/if}</label>
    {:else}<span class="muted">{$t('social.noOtherUsers')}</span>{/each}
  </div>
  <div class="flex" style="margin-top:1rem">
    <select bind:value={type} aria-label={$t('social.match.kind')}><option value="Movie">{$t('common.movies')}</option><option value="Series">{$t('common.series')}</option><option value="Both">{$t('social.match.both')}</option></select>
    <select bind:value={maxMinutes} aria-label={$t('social.match.maxLength')}><option value={0}>{$t('social.match.anyLength')}</option><option value={100}>{$t('social.match.max100')}</option><option value={120}>{$t('social.match.max120')}</option><option value={150}>{$t('social.match.max150')}</option></select>
    <select bind:value={genre} aria-label={$t('social.match.genre')}><option value="">{$t('social.match.allGenres')}</option>{#each genres as g}<option>{g}</option>{/each}</select>
    <button disabled={!picked.size || busy} on:click={run}>{$t('social.match.run')}</button>
  </div>
  {#if error && !result}<p class="err" role="alert">{error}</p>{/if}
</div>
{#if result}
  <h2>{$t('social.match.hits', { n: result.items.length })} <small class="muted">{$t('social.match.totalUnseen', { total: result.total, names: fmtList(result.participants) })}</small></h2>
  {#if result.items.some((i) => (i.planned ?? 0) > 0)}<p class="muted">{$t('social.match.plannedFirst')}</p>{/if}
  {#if !result.items.length}<p class="muted">{$t('social.match.noHits')}</p>{/if}
  <div class="tiles">
    {#each result.items as i (i.id)}
      <div class="slot sel" class:on={chosen.has(i.id)}>
        <Card item={i} />
        {#if (i.planned ?? 0) > 0}<span class="badge planned">{$t('social.match.planned', { n: i.planned })}</span>{/if}
        <button class="pickbtn" aria-pressed={chosen.has(i.id)} aria-label={$t('social.match.markForPoll')} on:click={() => pick(i.id)}><Icon name={chosen.has(i.id) ? 'check' : 'vote'} size={18} /></button>
      </div>
    {/each}
  </div>
  {#if error && result}<p class="err" role="alert">{error}</p>{/if}
  {#if chosen.size >= 2}<div class="bar2"><span>{$t('social.match.chosen', { n: chosen.size })}</span><button disabled={polling} on:click={poll}><Icon name="vote" size={18} />{$t('social.vote.start')}</button></div>{/if}
{/if}
<style>
  .pill { display: inline-flex; align-items: center; gap: .5rem; background: var(--surface-2); padding: .4rem .9rem; border-radius: 99px; color: var(--fg); min-height: 44px; } .pill.off { opacity: .55; }
  .sel { position: relative; } .pickbtn { position: absolute; top: .4rem; right: .4rem; z-index: 3; width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,.7); border: 2px solid #fff; }
  .planned { position: absolute; top: .4rem; left: .4rem; z-index: 3; background: rgba(0,0,0,.75); border: 1px solid #fff; }
  .sel.on .pickbtn { background: var(--acc); border-color: var(--acc); }
  .bar2 { position: fixed; left: 50%; bottom: 1.2rem; transform: translateX(-50%); background: rgba(16,20,24,.97); border: 1px solid #3b444e; border-radius: 99px; padding: .5rem .8rem .5rem 1.4rem; display: flex; gap: 1rem; align-items: center; z-index: 30; }
  /* phones: sit above the fixed tab bar (56px + safe area) */
  @media (max-width: 720px) { .bar2 { bottom: calc(56px + env(safe-area-inset-bottom) + .6rem); z-index: 61; max-width: calc(100vw - 1.5rem); gap: .6rem; padding-left: 1rem; } .bar2 span, .bar2 button { white-space: nowrap; } }
</style>
