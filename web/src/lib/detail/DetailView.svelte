<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, backdrop, cachedDetail, cachedItem, primeDetail, primeItem, srcset, HERO_WIDTHS, MODAL_WIDTHS, logoUrl, type Item, type ItemDetail } from '#lib/api';
  import { castToTv, refreshTvOnline, tvOnline } from '#lib/remote';
  import { listIds, toggleList, prefs } from '#lib/stores';
  import { kidsMode } from '#lib/kids';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import { playPreview, previewFailed, previewOwner, stopPreview, toggleSound } from '#lib/preview';
  import { isSpoiler } from '#lib/spoiler';
  import { langLine } from '#lib/langs';
  import { lengthLabel, ratingBadge } from '#lib/hover';
  import { toThumb, type Thumb } from '#lib/rating';
  import { byType, moodTags, remainingLabel, type Person } from '#lib/detail/format';
  import { autoStartAllowed, AUTOSTART_COUNTDOWN_S, countdownLabel, interactionCancels, isTextEntry, previewDone } from '#lib/detail/autostart';
  import { playPrefetch } from '#lib/player/prefetch';
  import Icon from '#lib/Icon.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import StatusPicker from '#lib/StatusPicker.svelte';
  import FriendsStrip from '#lib/FriendsStrip.svelte';
  import CastRow from '#lib/CastRow.svelte';
  import Reactions from '#lib/Reactions.svelte';
  import LangPick from '#lib/LangPick.svelte';
  import RatingButton from '#lib/RatingButton.svelte';
  import MoreActions, { type MoreAction } from '#lib/MoreActions.svelte';
  import EpisodeList from '#lib/detail/EpisodeList.svelte';
  import MoreLikeThis from '#lib/detail/MoreLikeThis.svelte';
  import InfoBlock from '#lib/detail/InfoBlock.svelte';
  import Extras from '#lib/detail/Extras.svelte';
  import TitleFacts from '#lib/detail/TitleFacts.svelte';
  import StoryCard from '#lib/detail/StoryCard.svelte';
  import LeavingDialog from '#lib/detail/LeavingDialog.svelte';
  import { forgetFacts, loadFacts, type Facts } from '#lib/fresh';

  /** Unified detail view: used inside the popup (ItemModal) and as the full page (/item/[id]). */
  export let id: string;
  export let variant: 'modal' | 'page' = 'page';
  /** loaded title (read-only for the parent: bind:item) */
  export let item: Item | null = null;
  /** id of the heading (the dialog is labelled by it) */
  export let titleId = 'detail-title';
  export let failed = false;
  const dispatch = createEventDispatcher<{ loaded: Item }>();

  let thumb: Thumb = 0, extras: Array<Item & { kind?: 'trailer' | 'extra' }> = [], more: Item[] | null = null, people: Person[] = [];
  let friends: Array<{ id: string; name: string }> = [], recOpen = false, recTo = new Set<string>(), recNote = '', recMsg = '', recEl: HTMLDivElement;
  let seasons: Item[] = [], episodes: Item[] | null = null, season = '', next: Item | null = null;
  let ratings: any[] = [], avg: number | null = null, stars = 0, review = '', followed = false;
  let logoFailed = false, saveMsg = '', saveT: ReturnType<typeof setTimeout>, castMsg = '', castT: ReturnType<typeof setTimeout>;
  let lgA = '', lgS = '';
  let dl: DownloadButton | undefined, dlAvail = false, dlState = '';
  // fresh label, removal date and quality chips (Block 17); admins get "Entfernungsdatum" in the ⋯ menu
  let facts: Facts | null = null, leavingDlg = false;

  // ---- loading: render from the card's data at once, every request in parallel (only the episode list waits for seasons + next-up) ----
  let loadSeq = 0, epSeq = 0, epKey = '';
  const opt = <T,>(p: Promise<T>, fn: (v: T) => void, my: number) => p.then((v) => { if (my === loadSeq) fn(v); }).catch(() => undefined);
  function savedLang(key: string) {
    try { const s = JSON.parse(localStorage.getItem(`ff_lang:${key}`) ?? '{}'); lgA = typeof s.audio === 'string' ? s.audio : ''; lgS = typeof s.sub === 'string' ? s.sub : ''; } catch { lgA = ''; lgS = ''; }
  }
  async function load(want: string) {
    const my = ++loadSeq;
    stopHero(); cancelAuto(); autoCancelled = false; heroByUser = false;
    failed = false; episodes = null; next = null; seasons = []; ratings = []; avg = null; stars = 0; review = ''; followed = false; season = ''; epKey = '';
    facts = null; leavingDlg = false;
    extras = []; more = null; people = []; logoFailed = false; heroLoaded = false; heroTried = ''; recOpen = false; castMsg = ''; saveMsg = ''; tab = '';
    savedLang(want);
    const cd: ItemDetail | undefined = cachedDetail(want);
    const early = cd?.item ?? cachedItem(want) ?? null;
    item = early; thumb = cd ? toThumb(cd.thumb) : 0;
    let announced = false;
    const announce = (it: Item) => { if (!announced) { announced = true; dispatch('loaded', it); } };
    if (early) announce(early);

    const pItem = api<ItemDetail>(`/api/items/${want}`);
    // secondary requests start now; each one is optional (the view works without it)
    opt(loadFacts(want), (f) => (facts = f), my);
    opt(api(`/api/items/${want}/people`), (r) => (people = (r.people as Person[]) ?? []), my);
    opt(api(`/api/items/${want}/extras/all`), (r) => (extras = (r.items as typeof extras) ?? []), my);
    if (!$kidsMode) opt(api(`/api/items/${want}/ratings`), (rr) => { ratings = rr.ratings; avg = rr.average; const mine = ratings.find((x) => x.mine); stars = mine?.stars ?? 0; review = mine?.review ?? ''; }, my);
    let seriesFired = false;
    const fireSeries = () => {
      if (seriesFired) return;
      seriesFired = true;
      if (!$kidsMode) opt(api(`/api/series/${want}/follow`), (r) => (followed = Boolean(r.followed)), my);
      const pSeasons = api(`/api/items/${want}/seasons`).then((r) => (r.items as Item[]) ?? []).catch(() => [] as Item[]);
      const pNext = api(`/api/library/nextup?seriesId=${want}`).then((r) => ((r.items as Item[]) ?? []).find((e) => e.seriesId === want) ?? null).catch(() => null);
      void Promise.all([pSeasons, pNext]).then(([list, n]) => {
        if (my !== loadSeq) return;
        seasons = list; next = n;
        season = n?.seasonId && list.some((x) => x.id === n.seasonId) ? n.seasonId : list[0]?.id ?? '';
      });
    };
    // type known from the card: only what it needs; unknown (deep link): series requests go out speculatively
    if (!early || early.type === 'Series') fireSeries();
    let similarFired = false;
    const fireSimilar = (it: Item) => { if (similarFired) return; similarFired = true; void loadSimilar(it).then((l) => { if (my === loadSeq) more = l.slice(0, 12); }); };
    if (early) fireSimilar(early);

    let r: ItemDetail;
    try { r = await pItem; } catch { if (my === loadSeq && !item) failed = true; return; }
    if (my !== loadSeq) return;
    primeDetail(r);
    item = r.item; thumb = toThumb(r.thumb);
    announce(r.item);
    if (r.item.type === 'Series') fireSeries();
    fireSimilar(r.item);
  }
  $: if (id) void load(id);
  $: if (item?.type === 'Series' && season) loadEpisodes(item.id, season);
  function loadEpisodes(seriesId: string, seasonId: string) {
    const key = seriesId + ':' + seasonId;
    if (key === epKey) return; // same list (the item object was only refreshed)
    epKey = key;
    const my = ++epSeq;
    episodes = null;
    api(`/api/items/${seriesId}/episodes?seasonId=${seasonId}`).then((r) => { if (my === epSeq) episodes = r.items; }).catch(() => { if (my === epSeq) episodes = []; });
  }
  async function loadSimilar(it: Item): Promise<Item[]> {
    const genre = async () => it.genres?.length
      ? (await api(`/api/library/items?types=${it.type}&genre=${encodeURIComponent(it.genres[0]!)}&sort=Random&limit=24`)).items.filter((i: Item) => i.id !== it.id) as Item[]
      : [];
    try { const l = (await api(`/api/items/${it.id}/similar`)).items as Item[]; return l.length ? l : await genre(); } catch { try { return await genre(); } catch { return []; } }
  }

  // ---- tabs: Episodes / Extras / More like this (only when there are extras; otherwise the sections simply follow each other) ----
  type Tab = 'episodes' | 'extras' | 'more';
  let tab: Tab | '' = '';
  $: tabs = (item && extras.length ? [...(item.type === 'Series' ? ['episodes' as Tab] : []), ...(more === null || more.length ? ['more' as Tab] : []), 'extras' as Tab] : []) as Tab[];
  $: tabbed = tabs.length > 1;
  $: curTab = (tab && tabs.includes(tab) ? tab : tabs[0] ?? '') as Tab | '';
  const showTab = (name: Tab, cur: Tab | '', on: boolean) => !on || cur === name;
  const tabLabel = (n: Tab): string => n === 'episodes' ? $t('detail.episodes.title') : n === 'extras' ? $t('hubs.extras.tab') : $t('detail.more.title');
  function tabKeys(e: KeyboardEvent) {
    const i = tabs.indexOf(curTab as Tab);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : d ? (i + d + tabs.length) % tabs.length : -1;
    if (j < 0) return;
    e.preventDefault();
    tab = tabs[j]!;
    void tick().then(() => document.getElementById('dv-tab-' + tab)?.focus());
  }

  // ---- derived ----
  $: inList = item ? $listIds.has(item.id) : false;
  $: qs = [lgA && `audio=${encodeURIComponent(lgA)}`, lgS && `sub=${encodeURIComponent(lgS)}`].filter(Boolean).join('&');
  $: playBase = item ? (item.type === 'Series' ? (next ? `/watch/${next.id}` : episodes?.[0] ? `/watch/${episodes[0].id}` : '') : `/watch/${item.id}`) : '';
  $: playHref = playBase ? (qs ? `${playBase}?${qs}` : playBase) : item ? `/item/${item.id}` : '';
  $: playTarget = playBase.split('/').pop() ?? '';
  $: resumeFrom = item ? (item.type === 'Series' ? next : item) : null;
  $: remaining = resumeFrom ? remainingLabel(resumeFrom.positionTicks, resumeFrom.runtimeTicks) : '';
  $: playLabel = $t(item ? (item.type === 'Series' ? (next ? (next.positionTicks ? 'detail.view.resume' : 'detail.view.continue') : 'detail.view.play') : item.positionTicks ? 'detail.view.resume' : 'detail.view.play') : 'detail.view.play');
  $: resumeLine = item?.type === 'Series' && next ? [$t('detail.view.episodeCode', { s: String(next.parentIndexNumber ?? '?'), e: String(next.indexNumber ?? '?') }), remaining].filter(Boolean).join(' · ') : remaining;
  $: actors = byType(people, 'Actor', 'GuestStar');
  $: castList = actors.length ? actors : people.filter((p) => p.type !== 'Director' && p.type !== 'Writer');
  $: moods = item ? moodTags(item.genres) : [];
  $: len = item ? lengthLabel(item) : '';
  $: badge = item ? ratingBadge(item, Date.now()) : '';
  $: overview = item ? (isSpoiler(item, $prefs) ? $t('detail.view.spoiler') : (item.overview ?? '')) : '';
  $: langs = item ? langLine(item.langs) : '';
  $: heroOwner = item ? 'detail:' + item.id : '';

  function failSave() { saveMsg = tr('detail.view.saveFailed'); clearTimeout(saveT); saveT = setTimeout(() => (saveMsg = ''), 5000); }
  async function toggleMine() { if (item && !(await toggleList(item.id, inList))) failSave(); }
  async function toggleFav() { if (!item) return; const on = item.favorite; try { await api(`/api/items/${item.id}/favorite`, { method: on ? 'DELETE' : 'POST' }); item.favorite = !on; primeItem(item); } catch { failSave(); } }
  async function togglePlayed() { if (!item) return; const on = item.played; try { await api(`/api/items/${item.id}/played`, { method: on ? 'DELETE' : 'POST' }); item.played = !on; primeItem(item); } catch { failSave(); } }
  function onThumb(e: CustomEvent<{ value: Thumb }>) { if (item) primeDetail({ item, thumb: e.detail.value }); }
  async function toggleFollow() { try { await api(`/api/series/${item!.id}/follow`, { method: followed ? 'DELETE' : 'POST' }); followed = !followed; } catch { failSave(); } }
  async function startParty() { try { void goto(`/party/${(await api('/api/party', { method: 'POST', body: { itemId: item!.id } })).id}`); } catch { castMsg = tr('detail.view.partyFailed'); } }
  async function castHere() {
    const target = playTarget;
    if (!target) return;
    castMsg = (await castToTv(target)) ? tr('detail.view.tvStarting') : tr('detail.view.tvOffline');
    clearTimeout(castT); castT = setTimeout(() => (castMsg = ''), 3500);
  }
  async function share() {
    if (!item) return;
    const url = `${location.origin}/item/${item.id}`;
    try {
      if (navigator.share) { await navigator.share({ title: item.name, url }); return; }
      await navigator.clipboard.writeText(url); castMsg = tr('detail.view.linkCopied');
    } catch (e) { if ((e as DOMException)?.name === 'AbortError') return; castMsg = url; }
    clearTimeout(castT); castT = setTimeout(() => (castMsg = ''), 3500);
  }
  async function openRec() {
    recOpen = true; recMsg = '';
    if (!friends.length) friends = (await api('/api/friends').catch(() => ({ friends: [] }))).friends;
    await tick();
    recEl?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    recEl?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
  }
  async function sendRec() {
    try { const r = await api('/api/recommend', { method: 'POST', body: { itemId: item!.id, toUserIds: [...recTo], note: recNote || undefined } }); recMsg = tr('detail.recommend.sent', { n: r.sent }); recTo = new Set(); recNote = ''; setTimeout(() => (recOpen = false), 1200); }
    catch (e: any) { recMsg = e?.body?.error === 'already_recommended' ? tr('detail.recommend.already') : tr('detail.recommend.failed'); }
  }
  function toggleTo(uid: string) { const n = new Set(recTo); if (n.has(uid)) n.delete(uid); else n.add(uid); recTo = n; }
  async function rate() {
    if (!item || !stars) return;
    try {
      await api(`/api/items/${item.id}/rating`, { method: 'PUT', body: { stars, review: review || undefined } });
      const rr = await api(`/api/items/${item.id}/ratings`); ratings = rr.ratings; avg = rr.average;
    } catch { failSave(); }
  }
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function toInfo() {
    const t = document.getElementById('dv-info');
    t?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    t?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
  }

  // ---- "⋯ Mehr": every secondary action in one menu (desktop popover / touch sheet) ----
  // kids profiles: no social or account actions (recommend, share, party, follow); the server answers 403 kids_profile anyway
  $: social = !$kidsMode;
  $: moreActions = item ? ([
    { id: 'fav', label: $t('detail.actions.fav'), icon: 'heart', pressed: item.favorite, run: toggleFav },
    { id: 'played', label: $t('detail.actions.played'), icon: 'check', pressed: item.played, run: togglePlayed },
    ...(item.type === 'Series' && social ? [{ id: 'follow', label: followed ? $t('detail.actions.following') : $t('detail.actions.follow'), icon: 'bell', pressed: followed, run: toggleFollow }] : []),
    ...(social ? [{ id: 'rec', label: $t('detail.actions.recommend'), icon: 'send', run: openRec }, { id: 'share', label: $t('detail.actions.share'), icon: 'share', run: share }] : []),
    ...(item.type !== 'Series' && social ? [{ id: 'party', label: $t('detail.actions.party'), icon: 'users', run: startParty }] : []),
    ...($tvOnline && playTarget ? [{ id: 'tv', label: $t('detail.actions.tv'), icon: 'tv', run: castHere }] : []),
    ...(facts?.admin && (item.type === 'Movie' || item.type === 'Series' || item.type === 'BoxSet') ? [{ id: 'leaving', label: $t('fresh.admin.menu'), icon: 'calendar', run: () => { leavingDlg = true; } }] : []),
    ...(canPreview && !heroPlaying ? [{ id: 'trailer', label: $t('detail.actions.trailer'), icon: 'film', run: () => startHero(true) }] : []),
    ...(item.type !== 'Series' && dlAvail && !phone ? [{ id: 'dl', label: dlState ? $t('detail.actions.downloadState', { state: dlState }) : $t('detail.actions.download'), icon: 'download', run: () => dl?.activate() }] : []),
  ] as MoreAction[]) : [];

  // ---- hero trailer: the still image fades into a muted preview clip (like the billboard) ----
  let hv: HTMLVideoElement, heroEl: HTMLDivElement, heroPlaying = false, hmuted = true, heroT: ReturnType<typeof setTimeout>, heroLoaded = false, heroTried = '';
  $: if (item && (heroLoaded || !item.backdrop) && item.id !== heroTried) scheduleHero(item.id);
  $: if (heroPlaying && $previewOwner !== heroOwner) { heroPlaying = false; cancelAuto(); }
  $: canPreview = Boolean(item && !previewFailed(item.id) && (item.trailers || (item.type === 'Movie' || item.type === 'Series')));
  function eligible() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    return $prefs.hoverTrailers && !document.hidden && !reduced() && !tvMode() && !nav.connection?.saveData && !(item?.trailers === 0 && !$prefs.hoverClip);
  }
  function scheduleHero(itemId: string) {
    heroTried = itemId;
    clearTimeout(heroT);
    heroT = setTimeout(() => { if (item?.id === itemId && eligible() && !$previewOwner && heroVisible) void startHero(); }, 1500);
  }
  async function startHero(forced = false) {
    if (!item || (!forced && !eligible())) return;
    heroPlaying = true; previewEnded = false;
    if (forced) { heroByUser = true; cancelAuto(); } // "Trailer abspielen": the viewer watches the trailer, no autostart afterwards
    if (!(await playPreview(item.id, () => hv, heroOwner, forced))) heroPlaying = false; // explicit "Trailer abspielen" still works in calm mode
  }
  function stopHero() { clearTimeout(heroT); if (heroOwner && $previewOwner === heroOwner) stopPreview(heroOwner); heroPlaying = false; }
  const tvMode = () => document.documentElement.classList.contains('tv');

  // ---- auto start: the preview ran long enough -> "Film/Folge startet in 5 …" -> /watch (desktop only, pref "Vorschau startet Titel automatisch") ----
  let touch = false, previewEnded = false, autoLeft = 0, autoT: ReturnType<typeof setInterval> | undefined, autoCancelled = false, heroByUser = false;
  let dvEl: HTMLDivElement | undefined, autoEl: HTMLDivElement | undefined;
  $: autoOn = autoStartAllowed({
    pref: ($prefs as { autoStartPreview?: boolean }).autoStartPreview, touch, tv: typeof document !== 'undefined' && tvMode(), hidden: false, reducedMotion: false,
    previewing: heroPlaying, hasTarget: Boolean(playBase), cancelled: autoCancelled, userStartedPreview: heroByUser, calm: $prefs.calm,
  });
  $: counting = autoT !== undefined;
  /** the viewer is busy right now: a popover (MoreActions / RatingButton / ListMenu) is open or a text field has focus */
  const busy = () => Boolean(dvEl?.querySelector('[aria-haspopup][aria-expanded="true"]')) || isTextEntry(document.activeElement as HTMLElement | null);
  function maybeAuto() {
    if (!autoOn || counting || document.hidden || busy() || !previewDone(previewEnded, hv?.currentTime ?? 0)) return;
    autoLeft = AUTOSTART_COUNTDOWN_S;
    autoT = setInterval(() => {
      if (document.hidden || (!heroPlaying && !previewEnded)) { cancelAuto(); return; }
      if (busy()) { cancelAuto(true); return; } // e.g. the rating pill opened on hover during the countdown
      autoLeft -= 1;
      if (autoLeft <= 0) { const to = playHref; cancelAuto(); stopHero(); if (to) void goto(to); }
    }, 1000);
  }
  function cancelAuto(byUser = false) {
    if (autoT !== undefined) clearInterval(autoT);
    autoT = undefined; autoLeft = 0;
    if (byUser) autoCancelled = true;
  }
  /** any pointer/key/wheel use of the view (focus moves only during the countdown) cancels autostart for this view instance */
  function onUse(e: Event) {
    if (autoCancelled) return;
    if (interactionCancels(e.type, Boolean(autoEl && e.target instanceof Node && autoEl.contains(e.target)), counting)) cancelAuto(true);
  }
  function onHeroEnded() { previewEnded = true; if (autoOn && !busy()) maybeAuto(); else void hv?.play().catch(() => undefined); }
  $: if (!autoOn && counting) cancelAuto();

  // ---- the hero only plays while it is (mostly) on screen: IntersectionObserver instead of a scroll listener (no forced layout) ----
  let heroVisible = true, io: IntersectionObserver | undefined;
  $: if (heroEl && typeof IntersectionObserver !== 'undefined' && !io) {
    io = new IntersectionObserver(([en]) => {
      heroVisible = Boolean(en?.isIntersecting && en.intersectionRatio >= 0.4);
      if (!heroVisible && heroPlaying) { stopHero(); cancelAuto(); }
    }, { threshold: [0, 0.4] });
    io.observe(heroEl);
  }
  const onVisibility = () => { if (document.hidden) { stopHero(); cancelAuto(); } };

  // ---- phone layout (phone app layout): video on top, title + full-width buttons + labelled icon row below ----
  let phone = false;
  onMount(() => {
    void refreshTvOnline();
    document.addEventListener('visibilitychange', onVisibility);
    const mqPhone = matchMedia('(max-width: 640px)'), mqTouch = matchMedia('(hover: none), (pointer: coarse)');
    const sync = () => { phone = mqPhone.matches; touch = mqTouch.matches || mqPhone.matches; };
    sync();
    mqPhone.addEventListener?.('change', sync); mqTouch.addEventListener?.('change', sync);
    return () => { mqPhone.removeEventListener?.('change', sync); mqTouch.removeEventListener?.('change', sync); };
  });
  onDestroy(() => {
    if (typeof window === 'undefined') return;
    document.removeEventListener('visibilitychange', onVisibility);
    io?.disconnect();
    clearTimeout(saveT); clearTimeout(castT); stopHero(); cancelAuto();
  });
  const heroTitleTag = () => (variant === 'modal' ? 'h2' : 'h1');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dv" data-play-scope class:vm={variant === 'modal'} class:vp={variant === 'page'} class:phone bind:this={dvEl}
  on:pointerdown|capture={onUse} on:keydown|capture={onUse} on:focusin={onUse} on:wheel|capture|passive={onUse}>
  <!-- ================= hero ================= -->
  <div class="hero" bind:this={heroEl}>
    {#if item}
      {#if item.backdrop}<img class="bg" data-play-art class:loaded={heroLoaded} src={backdrop(item.id, variant === 'modal' ? 960 : 1280)} srcset={srcset('Backdrop', item.id, variant === 'modal' ? MODAL_WIDTHS : HERO_WIDTHS)} sizes={variant === 'modal' ? '(min-width: 890px) 850px, 100vw' : '100vw'} alt="" fetchpriority="high" on:load={() => (heroLoaded = true)} />{/if}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={hv} class="hv" class:on={heroPlaying} loop={!autoOn} playsinline aria-hidden="true" tabindex="-1" on:volumechange={() => (hmuted = hv.muted)} on:playing={() => (hmuted = hv.muted)}
        on:timeupdate={maybeAuto} on:ended={onHeroEnded}></video>
      <div class="fade"></div>
      {#if !phone}
        <div class="cap">
          <svelte:element this={heroTitleTag()} id={titleId} class:sr-only={item.logo && !logoFailed} class="ttl">{item.name}</svelte:element>
          {#if item.logo && !logoFailed}<img class="tlogo" src={logoUrl(item.id)} alt="" on:error={() => (logoFailed = true)} />{/if}
          <div class="btns">
            <a class="btn pill play" data-autofocus href={playHref} use:playPrefetch><Icon name="play" size={24} />{playLabel}</a>
            <button type="button" class="rb" class:on={inList} aria-pressed={inList} aria-label={inList ? $t('detail.view.removeFromList') : $t('detail.view.addToList')} title={$t('detail.view.myList')} on:click={toggleMine}><Icon name={inList ? 'check' : 'plus'} size={22} /></button>
            <RatingButton itemId={item.id} bind:value={thumb} size={44} on:change={onThumb} />
            <MoreActions actions={moreActions} variant="ring" title={item.name} up={variant === 'modal'}>
              <div class="mslot">
                {#if social}<ListMenu itemId={item.id} variant="row" />{/if}
                <StatusPicker id={item.id} />
                {#if playTarget}<LangPick targetId={playTarget} storeKey={item.id} bind:audio={lgA} bind:sub={lgS} />{/if}
              </div>
            </MoreActions>
          </div>
          {#if resumeLine}<p class="resume">{resumeLine}</p>{/if}
        </div>
      {/if}
      {#if heroPlaying}<button type="button" class="snd" aria-label={hmuted ? $t('detail.view.soundOn') : $t('detail.view.soundOff')} aria-pressed={!hmuted} on:click={() => toggleSound(hv)}><Icon name={hmuted ? 'volume-off' : 'volume'} size={20} /></button>{/if}
      {#if counting}
        <div class="auto" role="status" bind:this={autoEl}>
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" class="tr" /><circle cx="18" cy="18" r="15" class="pr" style="stroke-dashoffset:{(autoLeft / AUTOSTART_COUNTDOWN_S) * 94.25}" /></svg>
          <span>{countdownLabel(item.type === 'Series' ? 'episode' : 'movie', autoLeft)}</span>
          <button type="button" class="sec" on:click={() => cancelAuto(true)}>{$t('detail.view.cancel')}</button>
        </div>
      {/if}
    {:else if failed}
      <p class="err pad" role="alert">{variant === 'modal' ? $t('detail.view.loadFailed') : $t('detail.view.notFound')}</p>
      {#if variant === 'page'}<p class="pad"><a class="btn" href="/">{$t('detail.view.toHome')}</a></p>{/if}
    {:else}
      <div class="skeleton fillsk" aria-hidden="true"></div>
    {/if}
  </div>

  {#if item && phone}
    <!-- ================= phone: title, meta, full-width buttons, synopsis, icon row ================= -->
    <div class="pcap">
      <svelte:element this={heroTitleTag()} id={titleId} class:sr-only={item.logo && !logoFailed} class="ttl">{item.name}</svelte:element>
      {#if item.logo && !logoFailed}<img class="tlogo" src={logoUrl(item.id)} alt="" on:error={() => (logoFailed = true)} />{/if}
      <p class="meta">
        {#if badge}<span class:match={badge.startsWith('★')} class:fresh={badge === $t('home.card.new')}>{badge}</span>{/if}
        {#if item.year}<span>{item.year}</span>{/if}
        {#if item.rating}<span class="age" title={$t('detail.view.ageRating')}>{item.rating}</span>{/if}
        {#if len}<span>{len}</span>{/if}
      </p>
      <TitleFacts {facts} episode={item.type === 'Episode'} />
      <a class="btn pill play wide" data-autofocus href={playHref} use:playPrefetch><Icon name="play" size={24} />{playLabel}</a>
      {#if item.type !== 'Series'}<DownloadButton itemId={item.id} block />{:else if playTarget}<DownloadButton itemId={playTarget} seriesId={item.id} block />{/if}
      {#if resumeLine}<p class="resume">{resumeLine}</p>{/if}
      <p class="ov">{overview || $t('detail.view.noOverview')}</p>
      {#if langs}<p class="muted small">{langs}</p>{/if}
      <div class="icons">
        <button type="button" class="lab" class:on={inList} aria-pressed={inList} on:click={toggleMine}><Icon name={inList ? 'check' : 'plus'} size={24} /><span>{$t('detail.view.myList')}</span></button>
        <RatingButton itemId={item.id} bind:value={thumb} size={48} showLabel up on:change={onThumb} />
        {#if social}<button type="button" class="lab" on:click={share}><Icon name="share" size={24} /><span>{$t('detail.view.share')}</span></button>{/if}
        <MoreActions actions={moreActions} variant="labelled" title={item.name}>
          <div class="mslot">
            {#if social}<ListMenu itemId={item.id} variant="row" />{/if}
            <StatusPicker id={item.id} />
            {#if playTarget}<LangPick targetId={playTarget} storeKey={item.id} bind:audio={lgA} bind:sub={lgS} />{/if}
          </div>
        </MoreActions>
      </div>
    </div>
  {/if}

  {#if item}
    <div class="body">
      <!-- ================= info columns ================= -->
      <div class="cols">
        <div class="left">
          {#if !phone}
            <p class="meta">
              {#if badge}<span class:match={badge.startsWith('★')} class:fresh={badge === $t('home.card.new')}>{badge}</span>{/if}
              {#if item.year}<span>{item.year}</span>{/if}
              {#if item.rating}<span class="age" title={$t('detail.view.ageRating')}>{item.rating}</span>{/if}
              {#if len}<span>{len}</span>{/if}
            </p>
            <TitleFacts {facts} episode={item.type === 'Episode'} />
            {#if langs}<p class="muted small">{langs}</p>{/if}
            <p class="ov">{overview || $t('detail.view.noOverview')}</p>
          {/if}
          {#if social}<FriendsStrip id={item.id} />{/if}
          {#if castMsg}<p class="muted" role="status">{castMsg}</p>{/if}
          <div role="status">{#if saveMsg}<p class="err">{saveMsg}</p>{/if}</div>
          {#if recOpen && social}
            <div class="panel rec" role="group" aria-label={$t('detail.recommend.label')} bind:this={recEl}>
              <b>{$t('detail.recommend.to', { name: item.name })}</b>
              <div class="flex">{#each friends as f (f.id)}<label class="chk"><input type="checkbox" checked={recTo.has(f.id)} on:change={() => toggleTo(f.id)} />{f.name}</label>{:else}<span class="muted">{$t('detail.recommend.noUsers')}</span>{/each}</div>
              <div class="flex"><input bind:value={recNote} maxlength="140" placeholder={$t('detail.recommend.note')} aria-label={$t('detail.recommend.noteLabel')} style="flex:1;min-width:200px" /><button type="button" disabled={!recTo.size} on:click={sendRec}>{$t('detail.recommend.send')}</button><button type="button" class="sec" on:click={() => (recOpen = false)}>{$t('detail.view.cancel')}</button></div>
              {#if recMsg}<span class="muted" role="status">{recMsg}</span>{/if}
            </div>
          {/if}
        </div>
        <dl class="right">
          {#if castList.length}
            <div><dt>{$t('detail.view.cast')}</dt><dd>{#each castList.slice(0, 3) as p, n (p.id + n)}{#if n}{', '}{/if}<a href="/person/{p.id}">{p.name}</a>{/each}{#if castList.length > 3}{', '}<button type="button" class="lnk" on:click={toInfo}>{$t('detail.view.more')}</button>{/if}</dd></div>
          {/if}
          {#if item.genres?.length}<div><dt>{$t('detail.view.genres')}</dt><dd>{item.genres.join(', ')}</dd></div>{/if}
          {#if moods.length}<div><dt>{$t('detail.view.moods')}</dt><dd>{moods.join(', ')}</dd></div>{/if}
        </dl>
      </div>

      {#if item.type === 'Series'}<StoryCard seriesId={item.id} />{/if}

      {#if tabbed}
        <div class="tabs" role="tablist" aria-label={$t('hubs.extras.tabs')} tabindex="-1" on:keydown={tabKeys}>
          {#each tabs as n (n)}
            <button type="button" role="tab" id="dv-tab-{n}" class="tab" class:on={curTab === n} aria-selected={curTab === n} aria-controls="dv-panel-{n}" tabindex={curTab === n ? 0 : -1} on:click={() => (tab = n)}>{tabLabel(n)}</button>
          {/each}
        </div>
      {/if}

      {#if item.type === 'Series'}
        <div id="dv-panel-episodes" role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'dv-tab-episodes' : undefined} hidden={!showTab('episodes', curTab, tabbed)}>
          <EpisodeList seriesId={item.id} {seasons} bind:season {episodes} {next} {qs} />
        </div>
      {/if}

      {#if extras.length && showTab('extras', curTab, tabbed)}
        <section class="extras" id="dv-panel-extras" role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'dv-tab-extras' : 'ex-h'}>
          <h2 id="ex-h" class:sr-only={tabbed}>{$t('detail.view.extras')}</h2>
          <Extras items={extras} {qs} />
        </section>
      {/if}

      <div id="dv-panel-more" role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'dv-tab-more' : undefined} hidden={!showTab('more', curTab, tabbed)}>
        <MoreLikeThis items={more} {variant} />
      </div>

      {#if social}
      {#if item.type === 'Movie' || item.type === 'Episode'}<Reactions id={item.id} />{/if}

      <section class="rate panel" aria-labelledby="rt-h">
        <h2 id="rt-h">{$t('detail.ratings.title')} {#if avg}<span class="badge">{$t('detail.ratings.average', { avg: fmtNumber(avg, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>{/if}</h2>
        <div class="flex" role="group" aria-label={$t('detail.ratings.stars')}>
          {#each [1, 2, 3, 4, 5] as n}<button type="button" class="icon-btn star" class:on={stars >= n} aria-pressed={stars >= n} aria-label={$t('detail.ratings.star', { n })} on:click={() => (stars = n)}><Icon name="star" size={24} fill={stars >= n} /></button>{/each}
          <input placeholder={$t('detail.ratings.review')} maxlength="280" bind:value={review} aria-label={$t('detail.ratings.reviewLabel')} style="flex:1;min-width:200px" />
          <button type="button" disabled={!stars} on:click={rate}>{$t('detail.ratings.save')}</button>
        </div>
        {#each ratings as r}<p><b>{r.name}</b> <span class="warn">{'★'.repeat(r.stars)}</span> <span class="muted">{r.review ?? ''}</span></p>{/each}
      </section>
      {/if}

      <CastRow id={item.id} {people} />
      <InfoBlock {item} {people} {facts} />
      {#if item.type !== 'Series'}<DownloadButton bind:this={dl} itemId={item.id} headless bind:available={dlAvail} bind:stateText={dlState} />{/if}
    </div>
  {:else if !failed}
    <div class="body" aria-hidden="true">
      <div class="cols">
        <div class="left"><div class="skeleton sl" style="width:55%"></div><div class="skeleton sl" style="width:100%;height:4.5rem"></div><div class="skeleton sl" style="width:80%"></div></div>
        <div class="right"><div class="skeleton sl" style="width:90%"></div><div class="skeleton sl" style="width:70%"></div></div>
      </div>
      <div class="skeleton sl" style="height:90px;margin-top:2rem"></div>
      <div class="skeleton sl" style="height:90px"></div>
    </div>
  {/if}
</div>

{#if leavingDlg && item}
  <LeavingDialog itemId={item.id} name={item.name} leavesAt={facts?.leaving?.leavesAt ?? ''} note={facts?.leaving?.note ?? ''}
    on:close={() => (leavingDlg = false)}
    on:saved={async () => { const id = item?.id; leavingDlg = false; if (!id) return; forgetFacts(id); facts = await loadFacts(id); }} />
{/if}

<style>
  .dv { --dv-bg: var(--bg); position: relative; color: var(--fg); }
  .dv.vm { --dv-bg: var(--surface); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }

  /* ---- hero ---- */
  .hero { position: relative; overflow: hidden; background: #0a0d10; }
  .vm .hero { aspect-ratio: 16 / 9; }
  .vp .hero { height: clamp(440px, 56.25vw, 86vh); }
  .bg, .hv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; }
  .bg { opacity: 0; transition: opacity .2s var(--ease); }
  .bg.loaded { opacity: 1; }
  .hv { opacity: 0; transition: opacity .6s var(--ease); pointer-events: none; background: transparent; }
  .hv.on { opacity: 1; }
  .fade { position: absolute; inset: 0; background: linear-gradient(to top, var(--dv-bg) 1%, rgba(0, 0, 0, .0) 55%), linear-gradient(77deg, rgba(0, 0, 0, .55), transparent 55%), linear-gradient(to bottom, rgba(0, 0, 0, .5), transparent 22%); pointer-events: none; }
  .fillsk { position: absolute; inset: 0; border-radius: 0; }
  .cap { position: absolute; left: 2.2rem; right: 2rem; bottom: 1.6rem; z-index: 2; display: flex; flex-direction: column; gap: 1rem; align-items: flex-start; }
  .vp .cap { left: var(--pad-x); right: var(--pad-x); bottom: 2.2rem; }
  .ttl { margin: 0; font-size: clamp(1.8rem, 4.4vw, 3.4rem); font-weight: 800; letter-spacing: -.02em; line-height: 1.05; text-shadow: 0 2px 14px rgba(0, 0, 0, .7); }
  .tlogo { max-width: min(70%, 24rem); max-height: 8rem; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 14px rgba(0, 0, 0, .7)); }
  .vp .tlogo { max-width: min(80%, 30rem); max-height: 10rem; }
  .btns { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .btns :global(.btn.play) { font-size: 1.15rem; padding: .5rem 1.8rem .5rem 1.4rem; min-height: 48px; }
  .rb { width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(42, 42, 42, .7); border: 2px solid rgba(255, 255, 255, .55); color: #fff; }
  .rb:hover:not(:disabled) { border-color: #fff; background: rgba(42, 42, 42, .95); }
  .rb.on { color: #fff; border-color: #fff; }
  .resume { margin: -.3rem 0 0; font-size: .95rem; font-weight: 600; color: #e8e8e8; text-shadow: 0 1px 8px #000; }
  .snd { position: absolute; right: 2rem; bottom: 1.6rem; z-index: 3; width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(42, 42, 42, .7); border: 2px solid rgba(255, 255, 255, .55); color: #fff; }
  .vp .snd { right: var(--pad-x); bottom: 2.2rem; }
  .snd:hover:not(:disabled) { border-color: #fff; background: rgba(42, 42, 42, .95); }
  .pad { padding: 5rem 2rem 1rem; margin: 0; }
  .mslot { display: grid; gap: .6rem; padding: .3rem .4rem .4rem; }
  .mslot :global(.status) { margin: 0; }
  .mslot :global(.lang) { margin: 0; }

  /* auto start countdown (top right of the hero, the "next" hint) */
  .auto { position: absolute; z-index: 4; right: 2rem; bottom: 5.4rem; display: flex; align-items: center; gap: .7rem; padding: .45rem .5rem .45rem .7rem; border-radius: 6px; background: rgba(16,20,24, .88); box-shadow: 0 6px 22px rgba(0, 0, 0, .6); font-weight: 600; }
  .vp .auto { right: var(--pad-x); bottom: 6rem; }
  .auto svg { width: 30px; height: 30px; transform: rotate(-90deg); }
  .auto circle { fill: none; stroke-width: 3.5; }
  .auto .tr { stroke: rgba(255, 255, 255, .25); }
  .auto .pr { stroke: #fff; stroke-dasharray: 94.25; transition: stroke-dashoffset 1s linear; }
  .auto .sec { min-height: 40px; padding: .3rem .9rem; font-size: .9rem; }

  /* ---- body ---- */
  .body { position: relative; z-index: 3; padding: 0 2.2rem 2.4rem; background: var(--dv-bg); }
  .vp .body { padding: 0 var(--pad-x) 5rem; max-width: 1400px; }
  .cols { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 2rem; padding-top: .6rem; }
  .left { min-width: 0; }
  .meta { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; color: #d2d2d2; margin: .4rem 0 .6rem; font-size: 1.05rem; }
  .match { color: var(--ok); font-weight: 700; }
  .fresh { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255, 255, 255, .45); border-radius: 6px; padding: 0 .45rem; font-size: .85rem; line-height: 1.5; }
  .small { font-size: .85rem; margin: -.2rem 0 .6rem; }
  .ov { margin: .8rem 0; line-height: 1.55; overflow-wrap: anywhere; }
  .rec { display: grid; gap: .8rem; margin-top: .8rem; }
  .chk { display: inline-flex; gap: .45rem; align-items: center; color: var(--fg); min-height: 44px; }
  .right { margin: 0; display: grid; gap: .7rem; align-content: start; font-size: .9rem; padding-top: .5rem; }
  .right dt { color: var(--mut); display: inline; margin-right: .35rem; }
  .right dd { margin: 0; display: inline; }
  .right dd a:hover, .right dd a:focus-visible { text-decoration: underline; }
  .lnk { background: none; border: 0; padding: 0 .1rem; min-height: 0; color: var(--fg); font: inherit; font-weight: 400; text-decoration: underline; cursor: pointer; display: inline; }
  .lnk:hover:not(:disabled) { background: none; }
  .sl { height: 1.1rem; margin: .8rem 0; }

  .extras { margin-top: 2rem; }
  .extras h2, .rate h2 { font-size: 1.4rem; }
  .tabs { display: flex; gap: .4rem; margin-top: 2.2rem; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { background: transparent; color: var(--mut); border-radius: 0; border-bottom: 3px solid transparent; padding: .5rem 1rem; margin-bottom: -1px; white-space: nowrap; }
  .tab:hover:not(:disabled) { background: transparent; color: var(--fg); }
  .tab.on { color: var(--fg); border-bottom-color: var(--acc); }
  .rate { margin-top: 2rem; }
  .star.on { color: #f5c518; }
  .dv :global(.reactions), .dv :global(.cast) { margin-top: 2rem; }

  /* ---- phone: 16:9 media on top, everything else below it ---- */
  .phone .hero { height: auto; aspect-ratio: 16 / 9; }
  .phone.vp { padding-top: var(--nav-h); } /* the video starts below the app bar , so nothing covers it */
  .phone .fade { background: linear-gradient(to top, rgba(0, 0, 0, .35), transparent 40%); }
  .phone .snd { right: .7rem; bottom: .7rem; width: 44px; height: 44px; }
  .pcap { display: flex; flex-direction: column; gap: .6rem; padding: .8rem 1rem .2rem; background: var(--dv-bg); }
  .pcap .ttl { font-size: 1.6rem; text-shadow: none; }
  .pcap .tlogo { max-width: 70%; max-height: 5.5rem; object-position: left center; filter: none; }
  .pcap .meta { margin: 0; font-size: .95rem; }
  .pcap .play.wide { width: 100%; justify-content: center; min-height: 44px; font-size: 1.05rem; border-radius: 4px; }
  .pcap .resume { margin: 0; text-shadow: none; font-size: .9rem; color: var(--mut); }
  .pcap .ov { margin: .2rem 0 0; font-size: .95rem; line-height: 1.45; }
  .pcap .small { margin: 0; }
  .icons { display: flex; justify-content: space-around; align-items: flex-start; gap: .4rem; margin: .4rem 0 .2rem; }
  .lab { display: flex; flex-direction: column; align-items: center; gap: .3rem; min-height: 44px; min-width: 64px; padding: .2rem .4rem; background: none; border: 0; color: #fff; border-radius: 6px; font-weight: 500; }
  .lab span { font-size: .75rem; color: var(--mut); }
  .lab:hover:not(:disabled) { background: rgba(255, 255, 255, .08); }
  .phone .body { padding-top: .2rem; }
  /* same 24px icon box for every entry of the icon row (the rating button's labelled variant uses its diameter as box) */
  .icons :global(.rb.lab .trig .ic) { height: 24px; }
  .icons :global(.ma.labelled) { min-width: 64px; }

  @media (pointer: coarse) { .right dd a, .lnk { display: inline-flex; align-items: center; min-height: 44px; } }
  @media (max-width: 899px) {
    .cols { grid-template-columns: minmax(0, 1fr); gap: .6rem; }
    .right { padding-top: 0; }
  }
  @media (max-width: 640px) {
    .body { padding: 0 1rem 5rem; }
    .vp .body { padding: 0 1rem 5rem; }
  }
  @media (prefers-reduced-motion: reduce) { .bg, .hv { transition: none; } .auto .pr { transition: none; } }
</style>
