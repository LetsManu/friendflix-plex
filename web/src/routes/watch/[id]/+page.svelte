<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { recoPlayStarted } from '#lib/reco';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { goto, pushState } from '$app/navigation';
  import { api, cachedItem, img, primeItem, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Player from '#lib/Player.svelte';
  import { t } from '#lib/i18n';
  import { prefs } from '#lib/stores';
  import { isBackKey } from '#lib/spatial';
  import { consumeAutoplay, noteAutoplay, noteInteraction, shouldAsk } from '#lib/stillwatching';
  import { barTitles } from '#lib/player/bar';
  import { advanceCountdown, cardVisible, COUNTDOWN_SECONDS, mayAutoplay, nextKind, ringOffset, secondsLeft } from '#lib/player/nextup';
  import { entryFadeMs } from '#lib/player/transition';
  import { castSession } from '#lib/cast/engine';
  import PostPlay from '#lib/PostPlay.svelte';
  import { features } from '#lib/capabilities';
  import { loadPostplay, postplayWanted, type Postplay } from '#lib/postplay';

  let video: HTMLVideoElement | null = null;
  let item: Item | null = null, nextEp: Item | null = null, similar: Item[] = [];
  let sleepAfterEpisode = false, creditsAt = Infinity;
  // 1.1 post-play: no next episode follows -> a small "Done? See what's next" card from the credits (outro segment, else the last
  // chapter, else 95 %) and the full-screen screen once the title has ended. Nothing ever starts by itself.
  let postplayAt = Infinity, ppData: Postplay | null = null, ppLoading = false, ppCardClosed = false, ppOpen = false;
  // "next up" card: shown from the start of the credits (Outro segment, else the last 25 s)
  let curTime = 0, dismissed = false, entered = false, askStill = false, elapsed = 0, counting = false, cd: ReturnType<typeof setInterval>;
  $: id = $page.params.id!;
  $: wantAudio = $page.url.searchParams.get('audio') ?? '';
  $: wantSub = $page.url.searchParams.get('sub') ?? '';
  $: langQ = [wantAudio && `audio=${encodeURIComponent(wantAudio)}`, wantSub && `sub=${encodeURIComponent(wantSub)}`].filter(Boolean).join('&');
  $: startAt = (() => { const t = Number($page.url.searchParams.get('t')); return Number.isFinite(t) && t > 0 && t < 86_400 ? Math.floor(t) : undefined; })();
  $: kind = nextKind(item?.type, Boolean(nextEp));
  /** the title plays on a TV (the cast engine owns it and shows its own "next" in the bar): no card, no countdown here */
  let remote = false;
  $: visible = !remote && cardVisible({ kind, current: curTime, start: creditsAt, dismissed });
  $: if (visible && !entered) enterCard(); else if (!visible && entered) leaveCard();
  $: ppWanted = postplayWanted({ type: item?.type, hasNextEpisode: Boolean(nextEp), feature: $features.postplay, pref: $prefs.postplay, remote });
  $: ppCard = ppWanted && !ppCardClosed && !ppOpen && Number.isFinite(postplayAt) && curTime >= postplayAt;
  $: if (ppCard && !ppData && !ppLoading) prefetchPostplay(id);

  // ---- while the TV plays (remote): the Player's cast screen shows the engine's next episode; the page follows the TV ----
  /** the TV went on to another title (next episode): the page shows that one; its Player attaches (no new token) */
  let tvItem: string | undefined, followedTv = false;
  $: onTvItem($castSession?.itemId);
  function onTvItem(itemId: string | undefined) {
    const changed = itemId !== tvItem;
    tvItem = itemId;
    // only a change on the TV counts: a title opened here is sent to the TV by its own Player (then the ids match)
    if (!changed || !itemId || !remote || itemId === id) return;
    followedTv = true;
    void goto(`/watch/${itemId}`, { replaceState: true });
  }
  const RING = 2 * Math.PI * 20;
  // no view transition running (no API, reduced motion): the page fades in instead of cutting; TV: no transition at all
  const root = document.documentElement;
  const fadeMs = entryFadeMs({ tv: root.classList.contains('tv'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, viewTransition: root.classList.contains('ff-vt-in') });
  /** loading poster: item artwork as far as known (undefined = try backdrop, then primary image) */
  $: poster = { id, backdrop: item && item.id === id ? item.backdrop : undefined, image: item && item.id === id ? item.image : undefined };

  // A function call keeps `id` the only dependency. (An inline async block that also reads `item` made Svelte re-run it
  // whenever `item` changed, i.e. an endless request loop and a title that never showed.)
  async function loadItem(wanted: string) {
    item = cachedItem(wanted) ?? null; // title right away when a card/detail view had it
    nextEp = null; similar = []; stopCountdown(); remote = false; dismissed = false; entered = false; askStill = false; curTime = 0; creditsAt = Infinity;
    postplayAt = Infinity; ppData = null; ppLoading = false; ppCardClosed = false; ppOpen = false; ppToken = ''; ppEntered = false;
    // item and "next episode" in parallel (/next answers null for films)
    const nx = api(`/api/items/${wanted}/next`).then((r) => r.item as Item | null).catch(() => null);
    try {
      const it = (await api(`/api/items/${wanted}`)).item as Item;
      if (wanted !== id) return; // navigated on in the meantime
      item = it; primeItem(it);
      recoPlayStarted([wanted, it.seriesId]); // playback of a title opened from a recommendation row counts as one play for that row
      if (it.type === 'Episode' && it.seriesId) {
        const n = await nx; // the episode AFTER this one, also across seasons
        if (wanted === id) nextEp = n;
      }
    } catch { /* player shows its own error */ }
  }
  $: loadItem(id);

  const back = () => (history.length > 1 ? history.back() : goto('/'));
  const nextHref = () => `/watch/${nextEp!.id}${langQ ? '?' + langQ : ''}`;
  /** moving on to another episode inside the player replaces the history entry: one Back leaves the player, however many episodes ran */
  const toEpisode = (href: string) => goto(href, { replaceState: true });
  function stopCountdown() { clearInterval(cd); counting = false; elapsed = 0; }
  function enterCard() {
    entered = true;
    if (kind === 'movie') { if (!ppWanted) void loadSimilar(id); return; }
    if (kind !== 'episode') return;
    if ($prefs.autoplayNext && !sleepAfterEpisode && shouldAsk(Date.now(), $prefs)) { askStill = true; return; } // nobody there for a while: do not autoplay on
    if (mayAutoplay({ kind, autoplayNext: $prefs.autoplayNext, sleepAfterEpisode, askStill })) startCountdown();
  }
  function leaveCard() { entered = false; stopCountdown(); askStill = false; }
  function startCountdown() {
    stopCountdown(); counting = true; let last = Date.now();
    cd = setInterval(() => {
      const now = Date.now(), dt = now - last; last = now;
      const r = advanceCountdown(elapsed, dt, !video || !video.paused || video.ended); // paused = the countdown waits
      elapsed = r.elapsed;
      if (r.done) { stopCountdown(); if (nextEp) { noteAutoplay(); void toEpisode(nextHref()); } }
    }, 100);
  }
  async function loadSimilar(wanted: string) {
    try {
      const r = await api(`/api/items/${wanted}/similar`);
      if (wanted === id) similar = (r.items as Item[]).filter((i) => i.id !== wanted).slice(0, 3);
    } catch { /* no suggestions */ }
  }
  /** "Abspann ansehen": hide the card, keep watching, no autoplay countdown */
  function watchCredits() { dismissed = true; stopCountdown(); askStill = false; }
  // each opened episode counts as viewer interaction, except one started by the autoplay countdown (the component is reused across episodes)
  // (following the TV is no interaction either: a tap on the card or bar already counted, an autoplay must not)
  $: if (id) opened();
  function opened() { if (followedTv) followedTv = false; else if (!consumeAutoplay()) noteInteraction(); }
  function stillGo() { noteInteraction(); askStill = false; void toEpisode(nextHref()); }
  function go() { stopCountdown(); void toEpisode(nextHref()); }
  function onTime() { if (video) curTime = video.currentTime; }
  /** the film is over: a dismissed card comes back (with the countdown) so the viewer is not left at a black screen */
  async function prefetchPostplay(wanted: string) {
    ppLoading = true;
    try { const d = await loadPostplay(wanted); if (wanted === id) ppData = d; } catch { /* the screen loads (and reports) on its own */ }
  }
  /**
   * The open overlay owns one shallow history entry (its own token in page.state), so browser and phone Back close it and keep the
   * viewer on this title instead of leaving the watch page (spec 3.2). Closing it any other way takes that entry back off.
   */
  let ppToken = '', ppSeq = 0, ppEntered = false;
  /** opens the post-play screen over the finished title (the viewer asked, or the title ended); never plays anything */
  function openPostplay() {
    ppOpen = true; stopCountdown();
    if (video && !video.paused && !video.ended) video.pause();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (!ppToken) {
      ppToken = `${id}:${++ppSeq}:${Date.now()}`;
      ppEntered = false;
      pushState('', { ...$page.state, postplay: ppToken });
    }
  }
  function hidePostplay() {
    ppOpen = false; ppCardClosed = true;
    tick().then(() => document.querySelector<HTMLElement>('.stage')?.focus?.());
  }
  /** Esc / TV Back / "Back to the title": the screen goes away and the viewer stays on this title (its history entry is popped) */
  function closePostplay() {
    const pushed = Boolean(ppToken) && $page.state.postplay === ppToken;
    ppToken = ''; ppEntered = false;
    hidePostplay();
    if (pushed) history.back();
  }
  /** a title played from the post-play screen: its entry is popped first, then the title replaces this one (one Back leaves) */
  async function playFromPostplay(e: CustomEvent<string>) {
    const pushed = Boolean(ppToken) && $page.state.postplay === ppToken;
    ppToken = ''; ppEntered = false; ppOpen = false;
    if (pushed) await new Promise<void>((r) => { addEventListener('popstate', () => r(), { once: true }); history.back(); });
    await toEpisode(e.detail);
  }
  // browser / phone Back popped the overlay's entry (the state held our token and no longer does): close it, stay here
  $: onPpState($page.state.postplay);
  function onPpState(st: string | undefined) {
    if (!ppToken) return;
    if (st === ppToken) ppEntered = true;
    else if (ppEntered) { ppToken = ''; ppEntered = false; if (ppOpen) hidePostplay(); }
  }
  function onEnded() {
    if (ppWanted) { openPostplay(); return; }
    if (kind !== 'episode') return;
    if (dismissed) { dismissed = false; entered = false; }
    if (tvMode()) tick().then(() => document.querySelector<HTMLElement>('.next .go')?.focus()); // TV: after the end OK starts the next episode
  }
  const tvMode = () => document.documentElement.classList.contains('tv');
  function onKey(e: KeyboardEvent) { if ((e.key === 'Escape' || (tvMode() && isBackKey(e))) && !document.fullscreenElement) { e.preventDefault(); back(); } }
  $: bt = barTitles(item, $t);
  const playEpisode = (e: CustomEvent<{ id: string }>) => toEpisode(`/watch/${e.detail.id}${langQ ? '?' + langQ : ''}`);
  const label = (i: Item | null) => (i ? (i.seriesName ? `${i.seriesName} · S${i.parentIndexNumber}:E${i.indexNumber} ${i.name}` : i.name) : '');
  onDestroy(() => { stopCountdown(); });
  // the player fills the whole screen: whatever the system draws over (status bar, home indicator) sits on black, not on the page colour
  onMount(() => { root.classList.add('ff-watch'); return () => root.classList.remove('ff-watch'); });
</script>

<svelte:window on:keydown={onKey} />
<svelte:head><title>{$t('common.pageTitle', { page: item?.name ?? $t('player.pageTitle') })}</title></svelte:head>
<div class="wrap" style:animation={fadeMs ? `ff-fade-in ${fadeMs}ms ease both` : null}>
  <!-- the overlay covers the player: while it is open the player's controls are out of the tab order (inert, not a focus trap) -->
  <div class="stagewrap" inert={ppOpen}>
  {#key id}
    <Player itemId={id} {poster} title={label(item)} barTitle={bt.title} barSub={bt.sub} seriesId={item?.seriesId ?? ''} isMovie={item?.type === 'Movie'} seasonId={item?.seasonId ?? ''} on:episode={playEpisode} {startAt} {wantAudio} {wantSub} bind:video bind:sleepAfterEpisode bind:creditsAt bind:postplayAt bind:remote hasNext={Boolean(nextEp)} on:next={() => nextEp && toEpisode(nextHref())} on:timeupdate={onTime} on:ended={onEnded}>
      <div slot="top" class="top">
        <button class="icon-btn" aria-label={$t('player.watch.back')} on:click={back}><Icon name="arrow-left" size={30} /></button>
        {#if item}<div class="ttl phone"><b>{item.seriesName ?? item.name}</b>{#if item.seriesName}<span>S{item.parentIndexNumber}:E{item.indexNumber} · {item.name}</span>{/if}</div>{/if}
      </div>
      {#if visible && askStill && nextEp}
        <div class="next still ui" data-nav role="dialog" aria-label={$t('player.watch.stillTitle')}>
          <div class="nt"><b>{$t('player.watch.stillTitle')}</b><span class="muted">{$t('player.watch.stillText', { ep: `S${nextEp.parentIndexNumber}:E${nextEp.indexNumber} · ${nextEp.name}` })}</span></div>
          <div class="flex"><button class="btn light go" on:click={stillGo}><Icon name="play" size={20} />{$t('player.watch.keepWatching')}</button><button class="sec" on:click={back}>{$t('player.watch.back')}</button></div>
        </div>
      {:else if visible && kind === 'episode' && nextEp}
        <div class="next ui" data-nav role="dialog" aria-label={$t('player.watch.next')}>
          <div class="nrow">
            <div class="nthumb">
              {#if nextEp.image}<img src={img(nextEp.id, 320)} alt="" loading="lazy" />{:else}<span class="nph"><Icon name="film" size={28} /></span>{/if}
              {#if counting}
                <svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" class="bg" /><circle cx="24" cy="24" r="20" class="fg" stroke-dasharray={RING} stroke-dashoffset={ringOffset(elapsed, RING)} transform="rotate(-90 24 24)" /></svg>
                <b class="rn" aria-hidden="true">{secondsLeft(elapsed)}</b>
              {/if}
            </div>
            <div class="nt"><span class="muted">{$t('player.watch.next')}{#if counting}{$t('player.watch.inSeconds', { n: secondsLeft(elapsed) })}{:else if sleepAfterEpisode}{$t('player.watch.pauseAfter')}{/if}</span><b>S{nextEp.parentIndexNumber}:E{nextEp.indexNumber} · {nextEp.name}</b></div>
          </div>
          <div class="flex"><button class="btn light go" on:click={go}><Icon name="play" size={20} />{$t('player.watch.next')}</button><button class="sec" on:click={watchCredits}>{$t('player.watch.watchCredits')}</button></div>
          <span class="sr" role="status">{counting ? $t('player.watch.startsIn', { n: secondsLeft(elapsed) }) : ''}</span>
        </div>
      {:else if ppCard}
        <div class="next pp ui" data-nav role="region" aria-label={$t('postplay.card.title')} data-testid="postplay-card">
          <div class="mhead"><b>{$t('postplay.card.title')}</b><button class="icon-btn" aria-label={$t('postplay.card.close')} on:click={() => (ppCardClosed = true)}><Icon name="x" size={20} /></button></div>
          <div class="flex"><button class="btn light go" on:click={openPostplay}>{$t('postplay.card.open')}</button></div>
        </div>
      {:else if visible && kind === 'movie' && similar.length && !ppWanted}
        <div class="next more ui" data-nav role="dialog" aria-label={$t('player.watch.more')}>
          <div class="mhead"><b>{$t('player.watch.more')}</b><button class="icon-btn" aria-label={$t('common.close')} on:click={watchCredits}><Icon name="x" size={20} /></button></div>
          <ul>{#each similar as m (m.id)}
            <li><a href="/item/{m.id}">{#if m.image}<img src={img(m.id, 240)} alt="" loading="lazy" />{:else}<span class="nph"><Icon name="film" size={26} /></span>{/if}<span class="mt">{m.name}</span></a></li>{/each}</ul>
        </div>
      {/if}
    </Player>
  {/key}
  </div>
  {#if ppOpen}<PostPlay itemId={id} variant="overlay" data={ppData} on:close={closePostplay} on:play={playFromPostplay} />{/if}
</div>

<style>
  .wrap { position: fixed; inset: 0; background: var(--bg); z-index: 40; }
  .stagewrap { display: contents; }
  :global(html.ff-watch), :global(html.ff-watch body) { background: #000; }
  .wrap :global(.stage) { height: 100%; }
  /* below the status bar / Dynamic Island (portrait) and clear of the notch (landscape); the gradient still covers the status bar */
  .top { padding: calc(.8rem + var(--safe-top)) max(1rem, var(--safe-right)) .8rem max(1rem, var(--safe-left)); display: flex; align-items: center; gap: .6rem; background: linear-gradient(rgba(0,0,0,.8), transparent); }
  .ttl { display: flex; flex-direction: column; line-height: 1.2; } .ttl span { color: var(--mut); font-size: .9rem; }
  /* desktop: the title sits centred in the control bar; phones keep it at the top */
  @media (min-width: 721px) { .ttl.phone { display: none; } }
  /* touch (phones, also in landscape): series · S1:E3 · episode on one line, ellipsis at the end, the whole top bar wide */
  @media (pointer: coarse) {
    :global(html:not(.tv)) .ttl.phone { display: block; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
    :global(html:not(.tv)) .ttl.phone span { font-size: .9rem; }
    :global(html:not(.tv)) .ttl.phone span::before { content: ' · '; }
    :global(html:not(.tv)) .next { right: max(1rem, var(--safe-right)); }
  }
  .next { position: absolute; right: var(--pad-x); z-index: 9; background: rgba(16,20,24,.94); border: 1px solid #3b444e; border-radius: 8px; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: .8rem; max-width: min(380px, 92vw); }
  .nt { display: flex; flex-direction: column; gap: .15rem; }
  .next { width: min(400px, calc(100vw - 2rem)); } .next.more { width: min(440px, calc(100vw - 2rem)); }
  .nrow { display: flex; gap: .9rem; align-items: center; }
  .nthumb { position: relative; flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #1c2228; display: grid; place-items: center; }
  .nthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .nph { display: grid; place-items: center; width: 100%; height: 100%; color: var(--mut); background: #1c2228; }
  .ring { position: absolute; inset: 50% auto auto 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; background: rgba(0,0,0,.55); border-radius: 50%; }
  .ring circle { fill: none; stroke-width: 4; } .ring .bg { stroke: rgba(255,255,255,.3); } .ring .fg { stroke: #fff; stroke-linecap: round; transition: stroke-dashoffset .1s linear; }
  .rn { position: absolute; inset: 50% auto auto 50%; transform: translate(-50%, -50%); font-size: 1rem; font-variant-numeric: tabular-nums; }
  .mhead { display: flex; justify-content: space-between; align-items: center; }
  .more ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem; }
  .more a { display: grid; gap: .3rem; color: #fff; text-decoration: none; border-radius: 6px; } .more a:hover .mt, .more a:focus-visible .mt { text-decoration: underline; }
  .more img, .more .nph { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 6px; display: block; }
  .mt { font-size: .85rem; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); }
  /* above the skip button, which sits above the control bar (--ctl-h: its measured height, set by the Player): the two never overlap */
  .next { bottom: calc(var(--ctl-h, 8rem) + 4.5rem); }
  @media (max-width: 720px) { .next { right: 1rem; } .nthumb { width: 104px; } }
  @media (max-height: 520px) { .nthumb { display: none; } }
</style>
