<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { backdrop, HERO_WIDTHS, img, primeItem, srcset, logoUrl, type Item } from '#lib/api';
  import { playPrefetch } from '#lib/player/prefetch';
  import { prefetchModal } from '#lib/lazy';
  import Icon from '#lib/Icon.svelte';
  import { openModal } from '#lib/modal';
  import { listIds, prefs, toggleList } from '#lib/stores';
  import { autoplayAllowed, billboardHeld, playPreview, previewOwner, stopPreview, toggleSound } from '#lib/preview';
  import { mobile } from '#lib/viewport';
  import { openPreview, previewSheet } from '#lib/previewSheet';
  import { genreLine } from '#lib/mobile';
  import { pageStore } from '#lib/page';
  import { t } from '#lib/i18n';

  /** Billboard at the top of the home page. */
  export let item: Item | null;
  export let playHref = '';
  /** '' = "Abspielen" in the UI language */
  export let playLabel = '';
  export let more = true;
  /** position in a ranking (1-10); shows the "#n" pill with the ranking label. 0 = none */
  export let rank = 0;
  /** '' = "in den Top 10 nach Bewertung" in the UI language */
  export let rankLabel = '';
  /** phone layout: centered poster card instead of the wide backdrop (home page only) */
  export let portrait = false;
  const page = pageStore();
  let loaded = false, logoFailed = false, section: HTMLElement | undefined;

  // ---- billboard preview: after a short pause the still image fades into the (muted) trailer ----
  const DELAY = 2500, QUIET_AFTER = 4000;
  let hv: HTMLVideoElement, playing = false, vmuted = true, ended = false, quiet = false, inView = true, paused = false;
  let timer: ReturnType<typeof setTimeout>, quietT: ReturnType<typeof setTimeout>, scheduledFor = '';
  $: heroOwner = item ? 'hero:' + item.id : '';
  /** something covers the billboard: quick-view modal (shallow route), phone preview sheet, any overlay holding it */
  $: covered = Boolean(($page.state as { modalId?: string } | undefined)?.modalId) || $previewSheet !== null || $billboardHeld;
  $: hold = covered || !inView;
  $: if (item && loaded && item.id !== scheduledFor) schedule(item.id);
  let interrupted = false;
  $: if (playing && $previewOwner !== heroOwner) { playing = false; quiet = false; interrupted = $previewOwner !== ''; } // a hover card took over (or the preview failed)
  // the hover preview is over: the billboard trailer comes back (from the start)
  $: if (interrupted && $previewOwner === '' && item) { interrupted = false; clearTimeout(timer); const id = item.id; timer = setTimeout(() => void startHero(id), 1500); }
  $: syncHold(hold);
  function eligible() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    return $prefs.hoverTrailers && autoplayAllowed() && !document.hidden && !document.documentElement.classList.contains('tv') && !nav.connection?.saveData;
  }
  function schedule(id: string) {
    scheduledFor = id;
    clearTimeout(timer);
    stopHero();
    ended = false;
    timer = setTimeout(() => void startHero(id), DELAY);
  }
  async function startHero(id: string) {
    if (!item || item.id !== id || !eligible() || $previewOwner) return; // not while something else previews
    if (hold) { paused = true; return; } // starts when the overlay closes / the billboard is back in view
    playing = true; ended = false; // the <video> always exists, this only fades it in once frames arrive
    const ok = await playPreview(id, () => hv, 'hero:' + id);
    if (!ok) { playing = false; return; }
    if (hold && hv && !hv.paused) { hv.pause(); paused = true; }
    clearTimeout(quietT);
    quietT = setTimeout(() => { if (playing) quiet = true; }, QUIET_AFTER);
  }
  function syncHold(h: boolean) {
    if (typeof window === 'undefined') return;
    if (h) {
      if (playing && hv && !hv.paused) { hv.pause(); paused = true; }
    } else if (paused) {
      paused = false;
      if (playing && hv) void hv.play().catch(() => undefined);
      else if (item && !ended && !playing) { clearTimeout(timer); timer = setTimeout(() => void startHero(item!.id), 600); }
    }
  }
  function stopHero() { clearTimeout(timer); clearTimeout(quietT); if (heroOwner) stopPreview(heroOwner); playing = false; quiet = false; paused = false; }
  function onEnded() { stopHero(); ended = true; } // trailer finished: back to the still image, replay button
  function replay() { if (!item) return; ended = false; scheduledFor = item.id; void startHero(item.id); }
  function onVisibility() { if (document.hidden) { if (playing && hv && !hv.paused) { hv.pause(); paused = true; } } else syncHold(hold); }
  let io: IntersectionObserver | undefined;
  // in-view via IntersectionObserver instead of reading scrollY in a scroll handler (no forced layout while scrolling)
  $: if (section && typeof IntersectionObserver !== 'undefined' && !io) {
    io = new IntersectionObserver((es) => { const e = es[es.length - 1]; if (e) inView = e.intersectionRatio > 0.45; }, { threshold: [0, 0.45, 0.6] });
    io.observe(section);
  }
  onMount(() => { document.addEventListener('visibilitychange', onVisibility); });
  onDestroy(() => { if (typeof window === 'undefined') return; io?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); stopHero(); });
  $: item, (logoFailed = false);
  $: listId = item ? (item.seriesId ?? item.id) : '';
  $: inList = listId ? $listIds.has(listId) : false;
  $: kind = $t(item?.type === 'Series' ? 'home.meta.series' : item?.type === 'Episode' ? 'home.meta.episode' : 'home.meta.movie');
  $: playText = playLabel || $t('home.card.play');
  $: tagline = item ? item.genres.slice(0, 3).join(' · ') : '';
</script>

{#if portrait && $mobile}
  <section class="mh" data-play-scope aria-label={$t('home.hero.label')}>
    {#if item}
      {#if item.image || item.backdrop}<img class="blurbg" src={item.image ? img(item.id, 120) : backdrop(item.id, 320)} alt="" aria-hidden="true" />{/if}
      <div class="mshade"></div>
      <a class="pcard" href="/item/{item.id}" aria-label={$t('home.card.openPreview', { name: item.name })} aria-haspopup="dialog" on:click={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); openPreview(item, e.currentTarget); }}>
        {#if item.image || item.backdrop}<img class="pimg" data-play-art src={item.image ? img(item.id, 520) : backdrop(item.id, 520)} srcset={item.image ? srcset('Primary', item.id, [320, 520, 780]) : srcset('Backdrop', item.id, [320, 520, 780])} sizes="(max-width: 450px) 80vw, 360px" alt="" fetchpriority="high" width="360" height="540" />{/if}
        <span class="pfade"></span>
        <span class="pinfo">
          {#if item.logo && !logoFailed}<img class="plogo" src={logoUrl(item.id)} alt={item.name} on:error={() => (logoFailed = true)} />{:else}<span class="ptitle">{item.name}</span>{/if}
          {#if genreLine(item.genres)}<span class="pgenres">{genreLine(item.genres)}</span>{/if}
        </span>
      </a>
      <div class="pbtns">
        <a class="pplay" data-autofocus href={playHref || (item.type === 'Series' ? `/item/${item.id}` : `/watch/${item.id}`)} use:playPrefetch><Icon name="play" size={22} />{playText}</a>
        <button type="button" class="plist" aria-pressed={inList} on:click={() => toggleList(listId, inList)}><Icon name={inList ? 'check' : 'plus'} size={22} />{$t('home.card.myList')}</button>
      </div>
    {:else}
      <div class="skeleton pcard ph"></div>
      <div class="pbtns"><div class="skeleton pph"></div><div class="skeleton pph"></div></div>
    {/if}
  </section>
{:else}
<section class="hero" data-play-scope class:quiet bind:this={section} aria-label={$t('home.hero.label')}>
  {#if item}
    {#if item.backdrop}<img class="bg" data-play-art class:loaded src={backdrop(item.id, 1280)} srcset={srcset('Backdrop', item.id, HERO_WIDTHS)} sizes="100vw" alt="" fetchpriority="high" on:load={() => (loaded = true)} />{/if}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={hv} class="hv" class:on={playing} playsinline aria-hidden="true" tabindex="-1" on:ended={onEnded} on:volumechange={() => (vmuted = hv.muted)} on:playing={() => (vmuted = hv.muted)}></video>
    <div class="shade"></div>
    <div class="content">
      <p class="eyebrow"><span>{kind}</span></p>
      {#if item.logo && !logoFailed}
        <h1 class="logoh"><img class="tlogo" src={logoUrl(item.id)} alt={item.name} on:error={() => (logoFailed = true)} /></h1>
      {:else}<h1>{item.name}</h1>{/if}
      <div class="fadebox">
        {#if rank > 0}
          <p class="rankline"><span class="top10">#{rank}</span> {rankLabel || $t('home.hero.rankTop10')}</p>
        {:else if tagline}<p class="rankline plain">{tagline}</p>{/if}
        <p class="meta">
          {#if item.communityRating}<span class="match">{$t('home.hero.match', { pct: Math.round(item.communityRating * 10) })}</span>{/if}
          {#if item.year}<span>{item.year}</span>{/if}
          {#if item.runtimeTicks && item.type !== 'Series'}<span>{$t('common.duration.m', { m: Math.round(item.runtimeTicks / 600_000_000) })}</span>{/if}
          {#if item.rating}<span class="age" aria-label={$t('home.card.ageRating', { rating: item.rating })}>{item.rating}</span>{/if}
        </p>
        {#if item.overview}<p class="ov">{item.overview}</p>{/if}
      </div>
      <div class="btns">
        <a class="btn pill" data-autofocus href={playHref || (item.type === 'Series' ? `/item/${item.id}` : `/watch/${item.id}`)} use:playPrefetch><Icon name="play" size={26} />{playText}</a>
        {#if more}<a class="btn glass" href="/item/{item.id}" aria-haspopup="dialog" on:pointerenter={prefetchModal} on:focus={prefetchModal} on:click={(e) => { if (item) primeItem(item); openModal(e, `/item/${item!.id}`); }}><Icon name="info" size={26} />{$t('home.hero.moreInfo')}</a>{/if}
      </div>
    </div>
    <div class="side">
      {#if playing}<button class="snd" aria-label={vmuted ? $t('home.card.soundOn') : $t('home.card.soundOff')} aria-pressed={!vmuted} on:click={() => toggleSound(hv)}><Icon name={vmuted ? 'volume-off' : 'volume'} size={22} /></button>
      {:else if ended}<button class="snd" aria-label={$t('home.hero.replay')} title={$t('home.hero.replayTitle')} on:click={replay}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 12a8.5 8.5 0 102.6-6.1M3.5 4v4.5H8" /></svg></button>{/if}
    </div>
  {:else}
    <div class="skeleton fill"></div>
  {/if}
</section>
{/if}

<style>
  .hero { position: relative; height: clamp(460px, 88vh, 940px); margin-bottom: -9vw; overflow: hidden; background: var(--bg); }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; opacity: 0; transition: opacity .18s linear; }
  .bg.loaded { opacity: 1; }
  /* the billboard does not rotate, so the still gets a very slow push-in instead */
  .bg, .hv { transform-origin: 62% 30%; will-change: transform; animation: ff-kenburns 12s ease-out both; }
  @keyframes ff-kenburns { from { transform: scale(1); } to { transform: scale(1.06); } }
  @media (prefers-reduced-motion: reduce) { .bg, .hv { animation: none; will-change: auto; } .bg { transition: none; } }
  .fill { position: absolute; inset: 0; border-radius: 0; }
  .hv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; opacity: 0; transition: opacity 1s var(--ease); pointer-events: none; background: transparent; }
  .hv.on { opacity: 1; }
  /* first layer paints on top: the bottom fade must end in exactly var(--bg), otherwise the side vignette leaves a seam */
  .shade { position: absolute; inset: 0; background:
      linear-gradient(to top, var(--bg) 0%, var(--bg) 3%, rgba(16,20,24,.9) 11%, transparent 42%),
      linear-gradient(77deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.5) 30%, transparent 62%),
      linear-gradient(to bottom, rgba(0,0,0,.65), transparent 24%); }
  .content { position: absolute; left: var(--pad-x); bottom: 25%; max-width: min(42rem, 88vw); z-index: 2; }
  .eyebrow { display: inline-flex; align-items: center; margin: 0 0 .6rem; padding: .22rem .8rem; border-radius: 999px; background: var(--surface); font-size: .85rem; font-weight: 600; color: var(--fg); }
  h1 { font-size: clamp(2.2rem, 5.6vw, 4.8rem); font-weight: 800; margin: 0 0 .8rem; text-shadow: 0 2px 18px rgba(0,0,0,.6); letter-spacing: -.02em; line-height: 1.02; }
  .logoh { margin: 0 0 1rem; }
  .tlogo { display: block; max-width: min(100%, 28rem); max-height: 10rem; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 18px rgba(0,0,0,.6)); }
  .rankline { display: flex; align-items: center; gap: .6rem; margin: 0 0 .5rem; font-size: clamp(1.1rem, 1.9vw, 1.6rem); font-weight: 700; text-shadow: 0 1px 8px rgba(0,0,0,.7); }
  .rankline.plain { font-weight: 600; font-size: clamp(1rem, 1.5vw, 1.25rem); color: #e8e8e8; }
  .top10 { display: inline-flex; align-items: center; justify-content: center; min-width: 2.4rem; height: 1.8rem; padding: 0 .7rem; background: var(--acc-fill); color: #fff; border-radius: 99px; font-size: .95rem; font-weight: 800; letter-spacing: .01em; text-shadow: none; }
  .meta { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; color: #d2d2d2; margin: 0 0 .7rem; font-weight: 500; }
  .match { color: var(--ok); font-weight: 700; }
  .ov { font-size: clamp(1rem, 1.45vw, 1.28rem); line-height: 1.5; margin: 0; max-width: 38rem; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 1px 8px rgba(0,0,0,.8); }
  .btns { display: flex; gap: .8rem; flex-wrap: wrap; align-items: center; }
  .btns .btn { font-size: 1.15rem; font-weight: 600; padding: .55rem 1.9rem .55rem 1.5rem; min-height: 52px; border-radius: 999px; }
  .age { border: 1px solid rgba(255,255,255,.5); border-radius: 6px; padding: 0 .45rem; font-size: .85rem; line-height: 1.5; }
  /* trailer running: synopsis + meta fade out, the title shrinks towards the buttons */
  .fadebox { overflow: hidden; max-height: 24rem; transition: max-height .9s var(--ease), opacity .6s ease; }
  .fadebox > :last-child { margin-bottom: 1.4rem; }
  .hero.quiet .fadebox { max-height: 0; opacity: 0; }
  h1, .logoh { transform-origin: left bottom; transition: transform .9s var(--ease); }
  .hero.quiet h1, .hero.quiet .logoh { transform: scale(.72); }
  @media (prefers-reduced-motion: reduce) { .fadebox, h1, .logoh { transition: none; } }
  /* sound / replay button on the right edge */
  .side { position: absolute; right: 0; bottom: calc(25% + .35rem); z-index: 2; display: flex; align-items: center; gap: .9rem; }
  .snd { width: 46px; min-height: 46px; height: 46px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.55); color: #fff; }
  .snd:hover:not(:disabled) { background: rgba(42,42,42,.9); border-color: #fff; }
  @media (max-width: 700px) { .hero { height: 68vh; margin-bottom: -5vh; } .content { bottom: 17%; } .btns .btn { padding: .5rem 1.1rem; font-size: 1rem; min-height: 46px; } .side { right: var(--pad-x); } }

  /* ---- phone billboard: centered poster card on a blurred copy of the poster ---- */
  .mh { position: relative; overflow: hidden; padding: calc(var(--nav-total) + .6rem) 0 1.4rem; background: var(--bg); }
  .blurbg { position: absolute; left: -10%; top: -6%; width: 120%; height: 78%; object-fit: cover; filter: blur(34px) saturate(1.5); opacity: .55; transform: translateZ(0); pointer-events: none; }
  .mshade { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(16,20,24,.25), rgba(16,20,24,.55) 45%, var(--bg) 92%); pointer-events: none; }
  .pcard { position: relative; display: block; width: min(80vw, 360px); aspect-ratio: 2 / 3; margin: 0 auto; border-radius: 8px; overflow: hidden; background: #1c2228; box-shadow: 0 14px 40px rgba(0,0,0,.65); z-index: 1; }
  .pimg { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pfade { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.92) 0%, rgba(0,0,0,.55) 24%, transparent 52%); }
  .pinfo { position: absolute; left: 0; right: 0; bottom: 0; padding: 1rem .9rem .9rem; display: flex; flex-direction: column; align-items: center; gap: .45rem; text-align: center; }
  .plogo { max-width: 72%; max-height: 4.6rem; object-fit: contain; filter: drop-shadow(0 3px 10px rgba(0,0,0,.7)); }
  .ptitle { font-size: 1.6rem; font-weight: 800; line-height: 1.1; letter-spacing: -.02em; text-shadow: 0 2px 12px rgba(0,0,0,.7); }
  .pgenres { font-size: .85rem; font-weight: 600; color: #e6e6e6; text-shadow: 0 1px 6px rgba(0,0,0,.8); }
  .pbtns { position: relative; z-index: 1; display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; width: min(80vw, 360px); margin: .8rem auto 0; }
  .pbtns > * { min-height: 46px; border-radius: 999px; font-weight: 700; font-size: 1rem; display: inline-flex; align-items: center; justify-content: center; gap: .45rem; padding: 0 .6rem; white-space: nowrap; }
  .pplay { background: var(--acc-fill); color: #fff; }
  .pplay:hover { background: var(--acc-fill-hover); }
  .plist { background: rgba(255,255,255,.08); backdrop-filter: blur(8px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.4); color: #fff; }
  .plist:hover:not(:disabled) { background: rgba(255,255,255,.16); }
  .pcard.ph { background: #1b2127; }
  .pph { height: 46px; }
</style>
