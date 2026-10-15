<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { fmtDate, t, tr } from '#lib/i18n';
  import { onDestroy, onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { replaceState } from '$app/navigation';
  import { api, ApiError, backdrop, getActiveProfile, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { itemPath } from '#lib/mobile';
  import Card from '#lib/Card.svelte';
  import { kidsMode } from '#lib/kids';
  import { features } from '#lib/capabilities';
  import { mobile } from '#lib/viewport';
  import { alreadyWished, clearRecent, isYear, loadRecent, pushRecent, wishCandidates, type SeerrHit } from '#lib/discovery';

  interface Person { id: string; name: string; image: boolean }
  interface Result { q: string; titles: Item[]; episodes: Item[]; people: Person[]; genres: string[]; partial: boolean }

  let input = '', term = '', pushed: string | null = null, seenUrl: string | null = null, status: 'idle' | 'loading' | 'error' | 'done' = 'idle';
  let res: Result | null = null, recent: string[] = [], timer: ReturnType<typeof setTimeout>, seq = 0, ctl: AbortController | undefined, inputEl: HTMLInputElement;

  // "Noch nicht in der Bibliothek": Seerr hits, loaded independently so they never block the library results
  let wishes: SeerrHit[] = [], wishMsg = '', wishSeq = 0, wishCtl: AbortController | undefined, sent = new Set<string>(), sending = '';
  let quotaFull = '';
  const wkey = (w: SeerrHit) => `${w.mediaType}:${w.tmdbId}`;
  async function loadWishes(q: string) {
    wishCtl?.abort();
    const my = ++wishSeq;
    wishes = []; wishMsg = ''; sent = new Set(); quotaFull = '';
    if (q.length < 2 || isYear(q) || $kidsMode || !$features.requests) return; // kids profiles: no wishes (403 kids_profile); none without a request service
    wishCtl = new AbortController();
    try {
      const r = await api<{ results: SeerrHit[] }>(`/api/seerr/search?q=${encodeURIComponent(q)}`, { signal: wishCtl.signal });
      if (my === wishSeq) wishes = wishCandidates(r.results, 8);
    } catch { /* Seerr may be off: hide the section */ }
  }
  async function wish(w: SeerrHit) {
    if (sending) return;
    sending = wkey(w); wishMsg = '';
    try {
      await api('/api/requests', { method: 'POST', body: { mediaType: w.mediaType, tmdbId: w.tmdbId } });
      sent.add(wkey(w)); sent = sent;
      wishMsg = tr('home.search.wishSent', { title: w.title });
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && e.body?.error === 'request_limit') {
        const d = e.body.resetsAt ? fmtDate(e.body.resetsAt, { dateStyle: 'medium' }) : '';
        quotaFull = wishMsg = d ? tr('home.search.limitUntil', { date: d }) : tr('home.search.limit');
      } else if (e instanceof ApiError && e.status === 409) { sent.add(wkey(w)); sent = sent; wishMsg = tr('home.search.already'); }
      else wishMsg = tr('home.search.wishFailed');
    }
    sending = '';
  }

  $: urlQ = ($page.url.searchParams.get('q') ?? '').trim();
  // initial value, back/forward and header-search submits come in through the URL; our own replaceState calls are skipped.
  // React to URL changes only: commit() updates `pushed` before $page catches up, and comparing against it then reset the input.
  $: if (urlQ !== seenUrl) { seenUrl = urlQ; if (urlQ !== pushed) { pushed = urlQ; clearTimeout(timer); input = urlQ; term = urlQ; } }
  $: void search(term);
  $: if (status === 'done') void loadWishes(term); else if (status === 'idle') void loadWishes('');

  async function search(q: string) {
    ctl?.abort();
    const my = ++seq;
    if (q.length < 2) { status = 'idle'; res = null; return; }
    ctl = new AbortController();
    status = 'loading';
    try {
      const r: Result = await api(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
      if (my !== seq) return;
      res = r; status = 'done'; recent = pushRecent(getActiveProfile(), q);
    } catch (e: any) {
      if (my !== seq || e?.name === 'AbortError') return;
      status = 'error';
    }
  }

  function commit(v: string) {
    clearTimeout(timer);
    const q = v.trim();
    if (q !== pushed) {
      pushed = q;
      try { replaceState(q ? `/search?q=${encodeURIComponent(q)}` : '/search', {}); } catch { /* router not ready */ }
    }
    term = q;
  }
  function onInput() { clearTimeout(timer); timer = setTimeout(() => commit(input), 250); }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && input) { e.preventDefault(); e.stopPropagation(); input = ''; commit(''); }
  }
  // desktop: the search field lives in the header (#hq, same URL contract); phones keep the big field on this page
  function pick(q: string) {
    const header = inputEl ? null : document.querySelector<HTMLInputElement>('#hq');
    if (header) { header.value = q; header.dispatchEvent(new Event('input', { bubbles: true })); header.focus(); return; } // the header field drives the URL
    input = q; commit(q); inputEl?.focus();
  }
  function forget() { clearRecent(getActiveProfile()); recent = []; }
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

  // empty state: what friends watch this week ("Beliebte Suchen")
  let popular: Item[] | null = null;
  onMount(() => {
    recent = loadRecent(getActiveProfile());
    // the layout may render this page before /api/me answered: re-read the recent searches of the real profile then
    const onMe = () => { if (!term) recent = loadRecent(getActiveProfile()); };
    window.addEventListener('ff-me', onMe, { once: true });
    // kids profiles: "what friends watch" is social (403 kids_profile): the section stays out
    if ($kidsMode) popular = [];
    else api('/api/library/trending').then((r) => (popular = (r.items as Item[]).slice(0, 12))).catch(() => (popular = []));
    if ($mobile && !input) inputEl?.focus();
    return () => window.removeEventListener('ff-me', onMe);
  });
  onDestroy(() => { clearTimeout(timer); ctl?.abort(); });

  $: count = res ? res.titles.length + res.episodes.length + res.people.length + res.genres.length : 0;
  $: empty = status === 'done' && res !== null && count === 0;
  $: year = isYear(term);
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('home.search.title') })}</title></svelte:head>
<h1 class="sr-only">{$t('home.search.title')}</h1>
{#if $mobile}
  <form role="search" on:submit|preventDefault={() => commit(input)}>
    <label class="sr-only" for="q">{$t('home.search.title')}</label>
    <input id="q" class="big" type="search" autocomplete="off" enterkeyhint="search" placeholder={$t('home.search.placeholder')} bind:this={inputEl} bind:value={input} on:input={onInput} on:keydown={onKeydown} />
  </form>
{:else}<div class="gap" aria-hidden="true"></div>{/if}

<p class="sr-only" role="status" aria-live="polite">{#if status === 'done' && res}{$t('home.search.hits', { n: count })}{/if}</p>
<p class="wishmsg" role="status" aria-live="polite">{wishMsg}</p>


{#if status === 'idle'}
  {#if term.length === 1}<p class="muted">{$t('home.search.minChars')}</p>{/if}
  {#if term.length === 0 && recent.length}
    <section aria-labelledby="rc">
      <div class="flex rhead"><h2 id="rc" class="muted">{$t('home.search.recent')}</h2><button type="button" class="sec small" on:click={forget}>{$t('home.search.clearRecent')}</button></div>
      <ul class="chips">{#each recent as r (r)}<li><button type="button" class="chip" on:click={() => pick(r)}>{r}</button></li>{/each}</ul>
    </section>
  {/if}
  {#if term.length === 0}
    {#if !$mobile && !recent.length}<p class="muted hint">{$t('home.search.hint')}</p>{/if}
    {#if !$kidsMode}
    <section aria-labelledby="pop">
      <h2 id="pop" class="sh">{$t('home.search.popular')}</h2>
      {#if popular === null}<div class="tiles" aria-busy="true">{#each Array(6) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
      {:else if popular.length && $mobile}
        <ul class="top">{#each popular as i (i.id)}
          <li><a href={itemPath(i)}><img src={i.backdrop ? backdrop(i.id, 400) : img(i.id, 300)} alt="" loading="lazy" width="146" height="82" /><span class="tt">{i.name}</span><span class="pl" aria-hidden="true"><Icon name="play" size={18} /></span></a></li>
        {/each}</ul>
      {:else if popular.length}<div class="tiles">{#each popular as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
      {:else}<p class="muted">{$t('home.search.minChars')}</p>{/if}
    </section>
    {/if}
  {/if}
{:else if status === 'loading'}
  <div class="tiles" aria-busy="true"><span class="sr-only">{$t('home.search.running')}</span>{#each Array(12) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if status === 'error'}
  <div class="empty" role="alert"><h2>{$t('home.search.errorTitle')}</h2><p class="muted">{$t('home.search.errorText')}</p><button type="button" on:click={() => search(term)}>{$t('home.search.retry')}</button></div>
{:else if res}
  {#if res.partial}<p class="muted note">{$t('home.search.partial')}</p>{/if}
  {#if empty}
    <div class="empty"><h2>{$t('home.search.noHits', { term })}</h2><p class="muted">{$t('home.search.notInLibrary')}</p>{#if !wishes.length && !$kidsMode && $features.requests}<a class="btn" href="/requests?q={encodeURIComponent(term)}">{$t('home.search.addWish')}</a>{/if}</div>
  {:else}
    {#if res.people.length}
      <section aria-labelledby="sp"><h2 id="sp" class="sh">{$t('home.search.people')}</h2>
        <ul class="people">{#each res.people as p (p.id)}
          <li><a href="/person/{p.id}"><span class="av">{#if p.image}<img src={img(p.id, 160)} alt="" loading="lazy" width="80" height="80" />{:else}<span aria-hidden="true">{initials(p.name)}</span>{/if}</span><span class="nm">{p.name}</span></a></li>
        {/each}</ul>
      </section>
    {/if}
    {#if res.genres.length}
      <section aria-labelledby="sg"><h2 id="sg" class="sh">{$t('home.search.genres')}</h2>
        <ul class="chips">{#each res.genres as g (g)}<li><a class="chip" href="/browse/movies?genre={encodeURIComponent(g)}">{g}</a></li>{/each}</ul>
      </section>
    {/if}
    {#if res.titles.length}
      <section aria-labelledby="st"><h2 id="st" class="sh">{year ? $t('home.search.titlesFrom', { year: term }) : $t('home.search.titles')}</h2>
        <div class="tiles">{#each res.titles as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
      </section>
    {/if}
    {#if res.episodes.length}
      <section aria-labelledby="se"><h2 id="se" class="sh">{$t('home.search.episodes')}</h2>
        <div class="tiles">{#each res.episodes as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
      </section>
    {/if}
  {/if}
{/if}

{#if status === 'done' && wishes.length}
  <section class="wishes" aria-labelledby="sw"><h2 id="sw" class="sh">{$t('home.search.notYet')}</h2>
    <ul class="wl">{#each wishes as w (wkey(w))}
      <li>
        {#if w.poster}<img src={w.poster} alt="" loading="lazy" width="56" height="84" />{:else}<span class="ph" aria-hidden="true"></span>{/if}
        <div class="wi"><b>{w.title}</b><span class="muted">{w.year ?? ''}{w.year ? ' · ' : ''}{w.mediaType === 'tv' ? $t('home.meta.series') : $t('home.meta.movie')}</span></div>
        {#if sent.has(wkey(w))}<button type="button" disabled>{$t('home.search.wished')}</button>
        {:else if alreadyWished(w.status)}<span class="badge">{$t('home.search.alreadyWished')}</span>
        {:else}<button type="button" disabled={sending !== '' || quotaFull !== ''} aria-label={$t('home.search.wishName', { title: w.title })} on:click={() => wish(w)}>{$t('home.search.wish')}</button>{/if}
      </li>
    {/each}</ul>
    <p class="muted note"><a href="/requests?q={encodeURIComponent(term)}">{$t('home.search.moreWishes')}</a></p>
  </section>
{/if}

<style>
  .gap { height: .5rem; }
  .top { display: grid; gap: .25rem; margin: 0 calc(var(--pad-x) * -1); }
  .top a { display: flex; align-items: center; gap: .9rem; min-height: 72px; padding: 0 var(--pad-x) 0 0; background: #161b21; }
  .top a:active { background: #20262d; }
  .top img { width: 146px; height: 82px; flex: none; object-fit: cover; background: #242b33; }
  .tt { flex: 1; min-width: 0; font-weight: 600; font-size: .95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pl { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; border: 2px solid #fff; padding-left: 2px; }
  .hint { margin: 0 0 .5rem; }
  .big { width: 100%; max-width: 640px; font-size: 1.2rem; min-height: 54px; margin-bottom: 1.5rem; }
  .empty { text-align: center; padding: 4rem 0; }
  .wishmsg { min-height: 1.4em; margin: 0 0 .5rem; color: var(--mut); }
  .wl { display: grid; gap: .6rem; max-width: 640px; }
  .wl li { display: flex; align-items: center; gap: .8rem; background: var(--surface-2); border-radius: 6px; padding: .5rem; }
  .wl img, .ph { width: 56px; height: 84px; flex: none; object-fit: cover; border-radius: 4px; background: #2b333c; }
  .wi { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .wl button, .badge { min-height: 44px; min-width: 44px; flex: none; }
  .badge { display: inline-flex; align-items: center; padding: 0 .8rem; border: 1px solid rgba(255,255,255,.4); border-radius: 99px; font-size: .85rem; }
  .wishes a { display: inline-flex; align-items: center; min-height: 44px; }
  .note { font-size: .88rem; margin: 0 0 1rem; }
  .sh { font-size: 1.15rem; margin: 1.2rem 0 .8rem; }
  .rhead { justify-content: space-between; max-width: 640px; } .rhead h2 { font-size: 1rem; margin: 0; }
  .small { padding: .3rem .9rem; font-size: .85rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; }
  .chip { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem; border-radius: 99px; background: var(--surface-2); color: var(--fg); font-weight: 500; border: 0; cursor: pointer; }
  .chip:hover { background: #323a43; }
  .people { display: flex; gap: 1rem; overflow-x: auto; padding-bottom: .5rem; }
  .people a { display: flex; flex-direction: column; align-items: center; gap: .4rem; width: 96px; min-height: 44px; text-align: center; }
  .av { width: 80px; height: 80px; border-radius: 50%; overflow: hidden; background: var(--surface-2); display: grid; place-items: center; font-weight: 700; font-size: 1.4rem; color: var(--mut); }
  .av img { width: 100%; height: 100%; object-fit: cover; }
  .nm { font-size: .85rem; line-height: 1.25; overflow-wrap: anywhere; }
  .people a:hover .nm { text-decoration: underline; }
</style>
