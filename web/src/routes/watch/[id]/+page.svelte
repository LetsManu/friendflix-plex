<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { goto } from '$app/navigation';
  import { api, cachedItem, img, primeItem, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Player from '#lib/Player.svelte';
  import { t } from '#lib/i18n';
  import { prefs } from '#lib/stores';
  import { isBackKey } from '#lib/spatial';
  import { consumeAutoplay, noteAutoplay, noteInteraction, shouldAsk } from '#lib/stillwatching';
  import { barTitles } from '#lib/player/bar';
  import { advanceCountdown, cardVisible, COUNTDOWN_SECONDS, mayAutoplay, nextKind, ringOffset, secondsLeft } from '#lib/player/nextup';

  let video: HTMLVideoElement | null = null;
  let item: Item | null = null, nextEp: Item | null = null, similar: Item[] = [];
  let sleepAfterEpisode = false, creditsAt = Infinity;
  // "next up" card: shown from the start of the credits (Outro segment, else the last 25 s)
  let curTime = 0, dismissed = false, entered = false, askStill = false, elapsed = 0, counting = false, cd: ReturnType<typeof setInterval>;
  $: id = $page.params.id!;
  $: wantAudio = $page.url.searchParams.get('audio') ?? '';
  $: wantSub = $page.url.searchParams.get('sub') ?? '';
  $: langQ = [wantAudio && `audio=${encodeURIComponent(wantAudio)}`, wantSub && `sub=${encodeURIComponent(wantSub)}`].filter(Boolean).join('&');
  $: startAt = (() => { const t = Number($page.url.searchParams.get('t')); return Number.isFinite(t) && t > 0 && t < 86_400 ? Math.floor(t) : undefined; })();
  $: kind = nextKind(item?.type, Boolean(nextEp));
  $: visible = cardVisible({ kind, current: curTime, start: creditsAt, dismissed });
  $: if (visible && !entered) enterCard(); else if (!visible && entered) leaveCard();
  const RING = 2 * Math.PI * 20;

  // A function call keeps `id` the only dependency. (An inline async block that also reads `item` made Svelte re-run it
  // whenever `item` changed, i.e. an endless request loop and a title that never showed.)
  async function loadItem(wanted: string) {
    item = cachedItem(wanted) ?? null; // title right away when a card/detail view had it
    nextEp = null; similar = []; stopCountdown(); dismissed = false; entered = false; askStill = false; curTime = 0; creditsAt = Infinity;
    // item and "next episode" in parallel (/next answers null for films)
    const nx = api(`/api/items/${wanted}/next`).then((r) => r.item as Item | null).catch(() => null);
    try {
      const it = (await api(`/api/items/${wanted}`)).item as Item;
      if (wanted !== id) return; // navigated on in the meantime
      item = it; primeItem(it);
      if (it.type === 'Episode' && it.seriesId) {
        const n = await nx; // the episode AFTER this one, also across seasons
        if (wanted === id) nextEp = n;
      }
    } catch { /* player shows its own error */ }
  }
  $: loadItem(id);

  const back = () => (history.length > 1 ? history.back() : goto('/'));
  const nextHref = () => `/watch/${nextEp!.id}${langQ ? '?' + langQ : ''}`;
  function stopCountdown() { clearInterval(cd); counting = false; elapsed = 0; }
  function enterCard() {
    entered = true;
    if (kind === 'movie') { void loadSimilar(id); return; }
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
      if (r.done) { stopCountdown(); if (nextEp) { noteAutoplay(); goto(nextHref()); } }
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
  $: if (id) { if (!consumeAutoplay()) noteInteraction(); }
  function stillGo() { noteInteraction(); askStill = false; goto(nextHref()); }
  function go() { stopCountdown(); goto(nextHref()); }
  function onTime() { if (video) curTime = video.currentTime; }
  /** the film is over: a dismissed card comes back (with the countdown) so the viewer is not left at a black screen */
  function onEnded() {
    if (kind !== 'episode') return;
    if (dismissed) { dismissed = false; entered = false; }
    if (tvMode()) tick().then(() => document.querySelector<HTMLElement>('.next .go')?.focus()); // TV: after the end OK starts the next episode
  }
  const tvMode = () => document.documentElement.classList.contains('tv');
  function onKey(e: KeyboardEvent) { if ((e.key === 'Escape' || (tvMode() && isBackKey(e))) && !document.fullscreenElement) { e.preventDefault(); back(); } }
  $: bt = barTitles(item, $t);
  const playEpisode = (e: CustomEvent<{ id: string }>) => goto(`/watch/${e.detail.id}${langQ ? '?' + langQ : ''}`);
  const label = (i: Item | null) => (i ? (i.seriesName ? `${i.seriesName} · S${i.parentIndexNumber}:E${i.indexNumber} ${i.name}` : i.name) : '');
  onDestroy(stopCountdown);
</script>

<svelte:window on:keydown={onKey} />
<svelte:head><title>{$t('common.pageTitle', { page: item?.name ?? $t('player.pageTitle') })}</title></svelte:head>
<div class="wrap">
  {#key id}
    <Player itemId={id} title={label(item)} barTitle={bt.title} barSub={bt.sub} seriesId={item?.seriesId ?? ''} seasonId={item?.seasonId ?? ''} on:episode={playEpisode} {startAt} {wantAudio} {wantSub} bind:video bind:sleepAfterEpisode bind:creditsAt hasNext={Boolean(nextEp)} on:next={() => nextEp && goto(nextHref())} on:timeupdate={onTime} on:ended={onEnded}>
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
      {:else if visible && kind === 'movie' && similar.length}
        <div class="next more ui" data-nav role="dialog" aria-label={$t('player.watch.more')}>
          <div class="mhead"><b>{$t('player.watch.more')}</b><button class="icon-btn" aria-label={$t('common.close')} on:click={watchCredits}><Icon name="x" size={20} /></button></div>
          <ul>{#each similar as m (m.id)}
            <li><a href="/item/{m.id}">{#if m.image}<img src={img(m.id, 240)} alt="" loading="lazy" />{:else}<span class="nph"><Icon name="film" size={26} /></span>{/if}<span class="mt">{m.name}</span></a></li>{/each}</ul>
        </div>
      {/if}
    </Player>
  {/key}
</div>

<style>
  .wrap { position: fixed; inset: 0; background: #000; z-index: 40; }
  .wrap :global(.stage) { height: 100%; }
  .top { padding: .8rem 1rem; display: flex; align-items: center; gap: .6rem; background: linear-gradient(rgba(0,0,0,.8), transparent); }
  .ttl { display: flex; flex-direction: column; line-height: 1.2; } .ttl span { color: var(--mut); font-size: .9rem; }
  /* desktop: the title sits centred in the control bar (Netflix); phones keep it at the top */
  @media (min-width: 721px) { .ttl.phone { display: none; } }
  .next { position: absolute; right: var(--pad-x); bottom: 8.5rem; z-index: 9; background: rgba(20,20,20,.94); border: 1px solid #444; border-radius: 8px; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: .8rem; max-width: min(380px, 92vw); }
  .nt { display: flex; flex-direction: column; gap: .15rem; }
  .next { width: min(400px, calc(100vw - 2rem)); } .next.more { width: min(440px, calc(100vw - 2rem)); }
  .nrow { display: flex; gap: .9rem; align-items: center; }
  .nthumb { position: relative; flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #222; display: grid; place-items: center; }
  .nthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .nph { display: grid; place-items: center; width: 100%; height: 100%; color: var(--mut); background: #222; }
  .ring { position: absolute; inset: 50% auto auto 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; background: rgba(0,0,0,.55); border-radius: 50%; }
  .ring circle { fill: none; stroke-width: 4; } .ring .bg { stroke: rgba(255,255,255,.3); } .ring .fg { stroke: #fff; stroke-linecap: round; transition: stroke-dashoffset .1s linear; }
  .rn { position: absolute; inset: 50% auto auto 50%; transform: translate(-50%, -50%); font-size: 1rem; font-variant-numeric: tabular-nums; }
  .mhead { display: flex; justify-content: space-between; align-items: center; }
  .more ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem; }
  .more a { display: grid; gap: .3rem; color: #fff; text-decoration: none; border-radius: 6px; } .more a:hover .mt, .more a:focus-visible .mt { text-decoration: underline; }
  .more img, .more .nph { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 6px; display: block; }
  .mt { font-size: .85rem; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); }
  /* above the skip button (7.5rem) and, on phones in portrait, above the two-row control bar */
  .next { bottom: 12.5rem; }
  @media (max-width: 720px) { .next { bottom: 14rem; right: 1rem; } .nthumb { width: 104px; } }
  @media (max-height: 520px) { .next { bottom: 6rem; } .nthumb { display: none; } }
</style>
