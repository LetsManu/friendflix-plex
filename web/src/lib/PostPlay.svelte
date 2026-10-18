<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * 1.1 "caught-up" post-play screen (spec §3.2): headline top left, the next step (play the next part, jump back, remind me,
   * wish), one hero pick and the rows. Nothing ever starts by itself; Esc / Back closes the overlay and the viewer stays on the
   * title (variant 'overlay'); on /postplay/:id the normal page back applies. Feedback is inline with Undo, never a dialog.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { api, ApiError, backdrop, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import RatingButton from '#lib/RatingButton.svelte';
  import { fmtDate, t, tr } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import { motionAllowed } from '#lib/preview';
  import { episodeKey, loadReminders, remindKeys, toggleReminder } from '#lib/reminders';
  import { focusFirst, isBackKey } from '#lib/spatial';
  import { isSpoiler } from '#lib/spoiler';
  import { listIds, prefs, toggleList } from '#lib/stores';
  import { headline, loadPostplay, recoCount, rowOf, rowTitle, rowWhy, track, type Postplay, type RowKind } from '#lib/postplay';
  import ReasonCaption from '#lib/ReasonCaption.svelte';

  export let itemId: string;
  /** overlay: over the finished title in the player (Esc / Back closes it); page: the /postplay/:id route */
  export let variant: 'overlay' | 'page' = 'page';
  /** answer prefetched by the watch page while the credits run */
  export let data: Postplay | null = null;

  const dispatch = createEventDispatcher<{ close: void; play: string }>();
  let p: Postplay | null = data, failed = false, root: HTMLElement | undefined;
  /** titles hidden after "Not interested" (until Undo) */
  let hidden = new Set<string>();
  /** the title just marked "Not interested" and the thumb it had before (Undo restores it; 0 = none) */
  let feedback: { id: string; title: string; previous: number } | null = null, note = '';
  let remindMsg = '', wishState: '' | 'busy' | 'done' = '', wishMsg = '', listMsg = '';
  /** calm mode (per profile) or reduced motion: no fade, no transitions (the screen never plays a trailer or sound anyway) */
  $: still = $prefs.calm === true || !motionAllowed();
  const tvMode = () => typeof document !== 'undefined' && document.documentElement.classList.contains('tv');

  onMount(() => {
    void (async () => {
      if (!p) {
        try { p = await loadPostplay(itemId); } catch { failed = true; return; }
      }
      track({ type: 'shown', state: p.state });
      for (const r of p.rows) if (r.items.length) recoCount(p, r.kind, 'impressions');
      if (p.remind && !$kidsMode) void loadReminders();
      await tick();
      // overlay: the first sensible control ([data-autofocus]) gets the focus, arrow keys move on from there; on the page the
      // layout's TV focus (settleFocus) picks the same [data-autofocus] control
      if (variant === 'overlay') focusFirst(root ?? null, false);
    })();
  });

  /** Esc / Back on the overlay: close it, stay on the title (capture phase, before the page's own "leave the player") */
  function onBack(e: KeyboardEvent) {
    if (variant !== 'overlay' || !(e.key === 'Escape' || (tvMode() && isBackKey(e)))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    close();
  }
  function close() { track({ type: 'dismiss' }); dispatch('close'); }
  onMount(() => { window.addEventListener('keydown', onBack, true); });
  onDestroy(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onBack, true); });

  $: current = p?.current ?? null;
  $: subject = current ? (current.type === 'Episode' && current.seriesId ? current.seriesId : current.id) : '';
  $: title = current ? (current.type === 'Episode' && current.seriesName ? current.seriesName : current.name) : '';
  $: continuation = p?.rows.find((r) => r.kind === 'continuation') ?? null;
  $: wish = continuation?.wish ?? null;
  $: hero = p?.hero && !hidden.has(p.hero.id) ? p.hero : null;
  $: heroRow = (p && hero ? rowOf(p, hero.id) : 'because') as RowKind;
  $: rows = (p?.rows ?? []).map((r) => ({ ...r, items: r.items.filter((i) => !hidden.has(i.id) && i.id !== hero?.id) })).filter((r) => r.items.length);
  $: reminded = p?.remind ? $remindKeys[episodeKey(p.remind.episodeId)] !== undefined : false;
  $: next = p && (p.state === 'next' || p.state === 'gap') ? p.next : null;

  /** one click or play on a title of a row: the anonymous post-play counter plus the recommendation counters (row kind + engine) */
  function hit(type: 'click' | 'play', row: RowKind, itemId: string) {
    track({ type, row });
    if (p) recoCount(p, row, type === 'play' ? 'plays' : 'clicks', itemId);
  }
  const epLabel = (i: Item) => tr('postplay.episode', { s: i.parentIndexNumber ?? '', e: i.indexNumber ?? '', name: i.name });
  const playHref = (i: Item) => `/watch/${i.id}`;
  /**
   * overlay: a title played from here replaces the finished one in the history, so one Back leaves the player. The watch page
   * pops the overlay's own entry first (`play`); the links' tracking handlers still run (they sit below this one).
   */
  function onNav(e: MouseEvent) {
    if (variant !== 'overlay' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href^="/watch/"]');
    if (!a) return;
    e.preventDefault();
    dispatch('play', a.getAttribute('href')!);
  }

  async function notInterested(i: Item) {
    if (p) recoCount(p, rowOf(p, i.id), 'dismisses');
    hidden = new Set(hidden).add(i.id); feedback = { id: i.id, title: i.name, previous: 0 }; note = '';
    try {
      const r = await api(`/api/items/${i.id}/thumb`, { method: 'PUT', body: { value: -1 } }) as { previous?: number };
      const previous = typeof r?.previous === 'number' && [-1, 1, 2].includes(r.previous) ? r.previous : 0;
      if (feedback?.id === i.id) feedback = { ...feedback, previous };
    }
    catch { hidden.delete(i.id); hidden = new Set(hidden); feedback = null; note = tr('common.saveFailed'); }
  }
  async function undo() {
    if (!feedback) return;
    const { id, previous } = feedback;
    feedback = null;
    try { await api(`/api/items/${id}/thumb`, { method: 'PUT', body: { value: previous } }); hidden.delete(id); hidden = new Set(hidden); note = tr('postplay.action.undone'); }
    catch { note = tr('common.saveFailed'); }
  }
  async function list(i: Item) {
    listMsg = '';
    if (!(await toggleList(i.id, $listIds.has(i.id)))) listMsg = tr('postplay.action.listFailed');
  }
  async function remind() {
    if (!p?.remind) return;
    const r = await toggleReminder(episodeKey(p.remind.episodeId), { episodeId: p.remind.episodeId });
    remindMsg = r === 'error' ? tr('postplay.action.remindFailed') : '';
  }
  async function wishSeason() {
    if (!wish || wishState) return;
    wishState = 'busy'; wishMsg = '';
    try { await api('/api/requests', { method: 'POST', body: { mediaType: wish.mediaType, tmdbId: wish.tmdbId } }); wishState = 'done'; }
    catch (e) {
      wishState = '';
      if (e instanceof ApiError && e.status === 429) wishMsg = tr('postplay.action.wishLimit');
      else if (e instanceof ApiError && e.status === 409) wishState = 'done';
      else wishMsg = tr('postplay.action.wishFailed');
    }
  }
</script>

<section class="pp {variant}" class:still data-nav data-scope bind:this={root} aria-labelledby="pp-h" data-testid="postplay" on:click={onNav}>
  {#if p && current}
    {#if variant === 'overlay' && current.backdrop}<div class="bg" style:background-image={`url(${backdrop(subject, 1280)})`} aria-hidden="true"></div>{/if}
    <header class="top">
      <div class="head">
        <span class="kicker">{$t('postplay.justWatched')} · {title}</span>
        <h1 id="pp-h" aria-live="polite">{headline(p, $t)}</h1>
        {#if p.state === 'caught_up'}
          <p class="sub">{$t('postplay.sub.caughtUp', { title })}
            {#if p.nextAirDate}<b class="air">{$t('postplay.sub.nextAir', { date: fmtDate(p.nextAirDate, { dateStyle: 'medium' }) })}</b>{:else}{' '}{$t('postplay.sub.noDate')}{/if}</p>
        {:else if p.state === 'gap'}
          <p class="sub">{$t('postplay.sub.gap', { title })}</p>
        {/if}
      </div>
      <div class="tools">
        <RatingButton itemId={subject} size={42} />
        {#if variant === 'overlay'}
          <button type="button" class="sec back" on:click={close}><Icon name="arrow-left" size={20} />{$t('postplay.action.back')}</button>
        {/if}
      </div>
    </header>

    <!-- the next step: never started by itself -->
    <div class="primary">
      {#if next}
        <a class="btn light go" data-autofocus href={playHref(next)} on:click={() => track({ type: 'play', row: 'continuation' })}>
          <Icon name="play" size={22} />{p.state === 'gap' ? $t('postplay.action.jumpBack', { n: next.indexNumber ?? '' }) : $t('postplay.action.playTitle', { title: next.name })}</a>
      {:else if p.state === 'series_finished' && p.sequel}
        <a class="btn light go" data-autofocus href={playHref(p.sequel)} on:click={() => track({ type: 'play', row: 'continuation' })}><Icon name="play" size={22} />{$t('postplay.action.playTitle', { title: p.sequel.name })}</a>
      {/if}
      {#if p.remind && !$kidsMode}
        <button type="button" class="btn sec" data-autofocus={!next ? '' : undefined} aria-pressed={reminded} on:click={remind}><Icon name={reminded ? 'check' : 'bell'} size={20} />{reminded ? $t('postplay.action.reminded') : $t('postplay.action.remind')}</button>
      {/if}
      {#if wish && !$kidsMode}
        <button type="button" class="btn sec" aria-disabled={wishState !== '' ? 'true' : undefined} on:click={wishSeason}>{wishState === 'done' ? $t('postplay.action.wished') : $t('postplay.action.wish')}</button>
        {#if wish.quota.remaining !== null && wishState !== 'done'}<span class="muted small">{$t('postplay.action.wishLeft', { n: wish.quota.remaining })}</span>{/if}
      {/if}
      <span role="status" class="small">{remindMsg}{wishMsg}</span>
    </div>

    {#if hero}
      <article class="hero" aria-labelledby="pp-hero">
        <div class="art">{#if hero.backdrop}<img src={backdrop(hero.id, 960)} alt="" loading="lazy" decoding="async" />{:else if hero.image}<img src={img(hero.id, 480)} alt="" loading="lazy" decoding="async" />{/if}</div>
        <div class="hbody">
          <span class="kicker">{$t('postplay.hero')}</span>
          <h2 id="pp-hero">{hero.name}{#if hero.year}<span class="yr">{hero.year}</span>{/if}</h2>
          {#if hero.overview}<p class="ov">{hero.overview}</p>{/if}
          <div class="flex acts">
            <a class="btn light" href={playHref(hero)} data-autofocus={!next && !p.remind && !(p.state === 'series_finished' && p.sequel) ? '' : undefined} on:click={() => hit('play', heroRow, hero.id)}><Icon name="play" size={20} />{$t('postplay.action.play')}</a>
            <button type="button" class="sec" aria-pressed={$listIds.has(hero.id)} on:click={() => list(hero)}><Icon name={$listIds.has(hero.id) ? 'check' : 'plus'} size={20} />{$listIds.has(hero.id) ? $t('postplay.action.onList') : $t('postplay.action.addList')}</button>
            <button type="button" class="sec" on:click={() => notInterested(hero)}><Icon name="thumb-down" size={20} />{$t('postplay.action.notInterested')}</button>
            <a class="sec more" href="/item/{hero.id}" on:click={() => hit('click', heroRow, hero.id)}>{$t('postplay.action.details')}</a>
          </div>
        </div>
      </article>
    {/if}
    <div class="fb" role="status">
      {#if feedback}<span>{$t('postplay.action.notInterestedDone', { title: feedback.title })}</span> <button type="button" class="link" on:click={undo}>{$t('postplay.action.undo')}</button>
      {:else if note}<span>{note}</span>{/if}
      {#if listMsg}<span>{listMsg}</span>{/if}
    </div>

    {#each rows as r (r.kind)}
      <section class="prow" aria-labelledby="pp-r-{r.kind}" data-kind={r.kind}>
        <h2 id="pp-r-{r.kind}">{rowTitle(r, $t)}</h2>
        {#if r.items.some((x) => x.reason)}<div class="rc"><ReasonCaption items={r.items} /></div>{:else if rowWhy(r, $t)}<p class="why muted small">{rowWhy(r, $t)}</p>{/if}
        <ul class="tiles">
          {#each r.items as i (i.id)}
            {@const spoil = isSpoiler(i, $prefs)}
            <li class:ep={i.type === 'Episode'}>
              <a href={i.type === 'Episode' ? playHref(i) : `/item/${i.id}`} on:click={() => hit(i.type === 'Episode' ? 'play' : 'click', r.kind, i.id)}>
                <span class="poster">
                  {#if spoil}<span class="spoil"><Icon name="eye-off" size={22} /><span class="sr">{$t('postplay.spoiler')}</span></span>
                  {:else if i.image}<img src={img(i.id, i.type === 'Episode' ? 360 : 240)} alt="" loading="lazy" decoding="async" />
                  {:else}<span class="ph"><Icon name="film" size={24} /></span>{/if}
                </span>
                <span class="nm">{i.type === 'Episode' ? epLabel(i) : i.name}</span>
              </a>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    {#if p.suggestions && !hero && !rows.length && !next}<p class="muted">{$t('postplay.empty')}</p>{/if}
  {:else if failed}
    <p class="muted" role="status">{$t('postplay.error')}</p>
    {#if variant === 'overlay'}<button type="button" class="sec" on:click={close}>{$t('postplay.action.back')}</button>{/if}
  {:else}
    <p class="muted" role="status">{$t('postplay.loading')}</p>
  {/if}
</section>

<style>
  .pp { position: relative; color: #fff; padding: 1.5rem var(--pad-x, 1rem) 3rem; display: flex; flex-direction: column; gap: 1.2rem; min-width: 0; }
  .pp.overlay { position: fixed; inset: 0; z-index: 60; overflow-y: auto; overflow-x: hidden; background: #0b0e11; padding-top: calc(1.5rem + var(--safe-top, 0px)); padding-bottom: calc(2rem + var(--safe-bottom, 0px)); animation: pp-in .25s ease both; }
  .pp.still, .pp.still :global(*) { animation: none !important; transition: none !important; }
  @media (prefers-reduced-motion: reduce) { .pp, .pp :global(*) { animation: none !important; transition: none !important; } }
  @keyframes pp-in { from { opacity: 0; } to { opacity: 1; } }
  .bg { position: fixed; inset: 0; background-size: cover; background-position: center top; opacity: .18; pointer-events: none; z-index: -1; }
  .pp.overlay > :not(.bg) { position: relative; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
  .head { display: flex; flex-direction: column; gap: .35rem; min-width: 0; max-width: 46rem; }
  .kicker { color: var(--mut, #9aa4ae); font-size: .9rem; text-transform: uppercase; letter-spacing: .04em; overflow-wrap: anywhere; }
  h1 { margin: 0; font-size: clamp(1.5rem, 3.2vw, 2.4rem); line-height: 1.15; overflow-wrap: anywhere; }
  .sub { margin: 0; color: #d6dce2; } .air { display: block; margin-top: .2rem; color: #fff; }
  .tools { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .back { display: inline-flex; align-items: center; gap: .4rem; }
  .primary { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1rem; }
  .primary .btn, .acts a, .acts button { display: inline-flex; align-items: center; gap: .45rem; }
  .hero { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 1.2rem; background: rgba(22,27,33,.85); border: 1px solid #2c343d; border-radius: 10px; overflow: hidden; }
  .art { aspect-ratio: 16 / 9; background: #1c2228; } .art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .hbody { padding: 1rem 1.2rem 1.2rem 0; display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
  .hbody h2 { margin: 0; font-size: 1.5rem; overflow-wrap: anywhere; } .yr { color: var(--mut, #9aa4ae); font-weight: 400; font-size: 1rem; margin-left: .5rem; }
  .ov { margin: 0; color: #d6dce2; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .acts { flex-wrap: wrap; gap: .5rem; margin-top: .3rem; }
  .more { color: #fff; text-decoration: none; padding: .5rem .8rem; }
  .fb { min-height: 1.4rem; display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
  .link { background: none; border: 0; color: #fff; text-decoration: underline; padding: .2rem .3rem; cursor: pointer; font: inherit; font-weight: 600; }
  .prow h2 { font-size: 1.2rem; margin: 0 0 .2rem; } .why { margin: 0 0 .5rem; }
  .rc { margin: 0 0 .4rem; } .rc :global(.why) { margin: 0; }
  .tiles { list-style: none; margin: 0; padding: 0 0 .4rem; display: flex; gap: .7rem; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; }
  .tiles li { flex: none; width: 128px; } .tiles li.ep { width: 220px; }
  .tiles a { display: grid; gap: .35rem; color: #fff; text-decoration: none; border-radius: 6px; }
  .tiles a:hover .nm, .tiles a:focus-visible .nm { text-decoration: underline; }
  .poster { display: block; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: #1c2228; }
  .ep .poster { aspect-ratio: 16 / 9; }
  .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph, .spoil { display: grid; place-items: center; width: 100%; height: 100%; color: var(--mut, #9aa4ae); }
  .nm { font-size: .88rem; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); }
  @media (max-width: 720px) {
    .pp { padding-left: 16px; padding-right: 16px; }
    .hero { grid-template-columns: minmax(0, 1fr); } .hbody { padding: 0 1rem 1rem; }
    .tiles li { width: 112px; } .tiles li.ep { width: 180px; }
  }
  /* TV: large type, roomy focus targets (arrow keys move between them) */
  :global(html.tv) .pp h1 { font-size: 3rem; } :global(html.tv) .pp .kicker, :global(html.tv) .pp .sub { font-size: 1.3rem; }
  :global(html.tv) .pp .prow h2, :global(html.tv) .pp .hbody h2 { font-size: 1.7rem; }
  :global(html.tv) .pp .tiles li { width: 180px; } :global(html.tv) .pp .tiles li.ep { width: 300px; } :global(html.tv) .pp .nm { font-size: 1.1rem; }
  :global(html.tv) .pp a:focus-visible, :global(html.tv) .pp button:focus-visible { outline: 4px solid #fff; outline-offset: 3px; }
</style>
