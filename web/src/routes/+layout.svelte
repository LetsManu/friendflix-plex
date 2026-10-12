<script lang="ts">
  import '../app.css';
  import { onMount, tick } from 'svelte';
  import { afterNavigate, beforeNavigate, goto, onNavigate } from '$app/navigation';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, setActiveProfile, setCsrf, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import Footer from '#lib/Footer.svelte';
  import { avatarBg, initial } from '#lib/avatars';
  import { loadList, loadPrefs } from '#lib/stores';
  import { kidsMode } from '#lib/kids';
  import type ItemModalType from '#lib/ItemModal.svelte';
  import { loadModal, prefetchModal } from '#lib/lazy';
  import { startTvLink, type ToTv } from '#lib/remote';
  import { logout as doLogout } from '#lib/session';
  import { capsFrom, serverCaps } from '#lib/capabilities';
  import { setMeta } from '#lib/offline/db';
  import { focusEl, focusFirst, isBackKey, isEditable, startSpatial } from '#lib/spatial';
  import Intro from '#lib/Intro.svelte';
  import { loadIntroSettings, markSessionSeen, readSessionSeen, shouldPlayIntro } from '#lib/intro';
  import { mobile } from '#lib/viewport';
  import { HEADER_TABS, isTabActive } from '#lib/menu';
  import { categoryHref, kindFromPath, showsChips, type Kind } from '#lib/mobile';
  import { dialogKeys } from '#lib/actions';
  import { langLabel } from '#lib/langs';
  import { canRenderEarly, clearReloadFlag, earlyProfile, gateHref, hintOf, kidsRedirect, needsProfileGate, needsWelcome, readActive, readHint, readPicked, readReloading, welcomeHref, writeActive, writeHint } from '#lib/gate';
  import MobilePreviewSheet from '#lib/MobilePreviewSheet.svelte';
  import { closePreview, previewSheet } from '#lib/previewSheet';
  import { isLocale, pageEpoch, pickLocale, ready, setLocale, t, type Locale } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import LanguageGate from '#lib/LanguageGate.svelte';
  import { saveLanguage } from '#lib/stores';

  let me: Me | null = null;
  /** The page renders before /api/me returns when the last answer allows it (see lib/gate.ts): its data requests start right away. */
  const bootHint = typeof location !== 'undefined' ? readHint() : null, bootProfile = earlyProfile(bootHint, typeof location !== 'undefined' ? readActive() : null);
  const early = typeof location !== 'undefined' && canRenderEarly(bootHint, readPicked(), location.pathname, bootProfile, readReloading());
  if (early) setActiveProfile(bootProfile); // early requests carry the profile this tab ran with (a switch elsewhere answers 409 → reload without early render)
  /** TV mode: big UI, D-pad navigation. On for paired televisions; `?tv=1` previews it in any browser (`?tv=0` ends the preview). */
  let tv = false, replaced = false;
  let pending = false, checking = false;
  let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  let scrolled = false, menu = false, bell = false, cats = false, help = false;
  let sentinel: HTMLElement;
  let online = true;
  let intro = false;
  // ---- UI language: the shell waits for the remembered language once; first admin visit / first login ask for a language ----
  let booted = false;
  $: if ($ready) booted = true;
  /**
   * Early render (before /api/me): the page may only mount once the language of the last /api/me answer (boot hint) is
   * active. Without /api/me the page mounts after the server language was applied (boot() awaits setLocale before `me`).
   * Either way the page mounts once in the right language; nothing re-creates it later (see pageEpoch in lib/i18n).
   */
  let earlyLang = !(early && bootHint?.lang);
  if (early && bootHint?.lang) void setLocale(bootHint.lang).finally(() => (earlyLang = true));
  let pageReady = false; // sticky: a later language load (ready = false for a moment) must not unmount the page
  $: if (!pageReady && booted && (me || (early && earlyLang && $ready))) pageReady = true;
  let langAsk: 'instance' | 'profile' | null = null, langPre: Locale = 'de';
  async function chooseInstance(l: Locale) {
    await api('/api/admin/settings/language', { method: 'PUT', body: { language: l } });
    if (me?.languageChosen === false) await saveLanguage(l); // the admin is not asked a second time for their own profile
    if (me) me = { ...me, defaultLanguage: l, defaultLanguageSet: true, languageChosen: true };
    langAsk = null;
  }
  /** "Später": keep the instance default, but store it so the question does not come back */
  const skipLanguage = () => chooseProfile(isLocale(me?.defaultLanguage) ? me!.defaultLanguage as Locale : 'de');
  async function chooseProfile(l: Locale) {
    await saveLanguage(l);
    if (me) me = { ...me, language: l, languageChosen: true };
    langAsk = null;
  }
  $: canDownload = Boolean(me?.downloads?.allowed);
  $: multi = (me?.profileCount ?? 0) > 1;
  $: who = me ? (me.profile?.name ?? me.name) : '';
  $: faceStyle = me?.profile ? `background:${avatarBg(me.profile.avatar)}` : undefined;
  $: admin = Boolean(me?.isAdmin && me?.profile?.isOwner);
  /** kids profile: kids header, no footer links / tab bar / bell; the last /api/me answer decides until the fresh one arrives */
  $: kidsUi = me ? Boolean(me.kids) : Boolean(bootHint?.kids);
  $: if (typeof document !== 'undefined') document.documentElement.classList.toggle('kids', kidsUi);
  $: kidsMode.set(kidsUi); // shared flag for components (no social UI on kids profiles)
  // ---- phone: chip bar + "Kategorien" overlay; desktop: "Kategorien" dropdown (genres, languages, collections) ----
  let catOpen = false, catGenres: string[] | null = null, catKind: Kind = 'movies', catBtn: HTMLElement | null = null;
  let catLangs: string[] | null = null;

  $: path = $page.url.pathname;
  $: publicPage = path.startsWith('/invite/') || path === '/tv' || path === '/offline';
  $: watchPage = path.startsWith('/watch/') || /^\/party\/[^/]+/.test(path); // immersive player pages: no navigation
  $: profilesPage = path === '/profiles' || path === '/welcome'; // full-screen pages without navigation (picker, onboarding)
  $: heroPage = path === '/' || path.startsWith('/item/');
  $: kidsPage = path === '/kids' || path.startsWith('/kids/'); // full-bleed bright kids pages (own background and spacing)
  $: unread = notes.filter((n) => !n.read).length;
  $: if (path) { menu = false; bell = false; cats = false; catOpen = false; closePreview(); }
  $: chips = $mobile && showsChips(path) && !kidsUi;
  // kids profiles stay on kids routes, new profiles go through /welcome once (both also checked in boot() before the page mounts)
  $: if (me && !pending && !publicPage) {
    const to = kidsRedirect(me, path) ?? (needsWelcome(me, path) ? welcomeHref(path + $page.url.search, me.kids) : null);
    if (to) void goto(to, { replaceState: true });
  }
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('m-chips', chips && !watchPage && !profilesPage);
    document.documentElement.style.overflow = catOpen ? 'hidden' : ($previewSheet ? 'hidden' : ''); // no page scroll behind the overlay / sheet
  }
  $: if (!$mobile) { catOpen = false; closePreview(); }
  $: if ($mobile) cats = false;
  $: if (!publicPage) document.documentElement.classList.toggle('tv', tv);

  // ---- detail popup: loaded on first use (or prefetched on hover/focus/touch of a card), not part of the layout chunk ----
  let Modal: typeof ItemModalType | null = null;
  $: modalId = $page.state.modalId;
  $: if (modalId && !Modal) {
    const id = modalId;
    loadModal().then((m) => (Modal = m.default)).catch(() => { location.href = `/item/${id}`; }); // chunk gone (new deploy/offline): open the full page
  }

  async function loadNotes() { if (me?.kids) return; try { notes = (await api('/api/notifications')).notifications; } catch { /* ignore */ } } // kids: 403 kids_profile
  async function toggleBell() {
    bell = !bell; menu = false; cats = false;
    if (bell && unread) { await api('/api/notifications/read', { method: 'POST' }); setTimeout(loadNotes, 1500); }
  }
  const logout = () => doLogout(me?.tv);
  async function surprise() {
    menu = false;
    try { goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { goto('/browse/movies'); }
  }

  // ---- avatar menu: other profiles to switch to (loaded when the menu opens) ----
  let others: Array<{ id: string; name: string; avatar: string; hasPin: boolean }> | null = null;
  async function toggleMenu() {
    menu = !menu; bell = false; cats = false;
    if (menu && multi && others === null) {
      try { others = ((await api('/api/profiles')).profiles as Array<{ id: string; name: string; avatar: string; hasPin: boolean; active: boolean }>).filter((p) => !p.active && p.id !== me?.profile?.id).slice(0, 4); }
      catch { others = []; }
    }
  }
  $: here = publicPage ? path : path + $page.url.search; // (the prerendered /offline page has no search params)
  const switchHref = (id: string) => `/profiles?pick=${encodeURIComponent(id)}&next=${encodeURIComponent(here)}`;
  function openHelp() { menu = false; help = true; }
  const HELP = [['shell.help.searchT', 'shell.help.searchD'], ['shell.help.playerT', 'shell.help.playerD'], ['shell.help.deviceT', 'shell.help.deviceD'], ['shell.help.tvT', 'shell.help.tvD'], ['shell.help.languageT', 'shell.help.languageD'], ['shell.help.moreT', 'shell.help.moreD']] as const;

  // ---- header search (desktop): the icon expands into the input; typing drives /search?q= (the page itself has no second input on desktop) ----
  let searchOpen = false, q = '', searchEl: HTMLInputElement, st: ReturnType<typeof setTimeout>;
  let hSeen: string | null = null, hPushed: string | null = null;
  $: urlQ = path === '/search' ? ($page.url.searchParams.get('q') ?? '').trim() : null;
  // same guard as routes/search: react to URL changes only, and never overwrite what is being typed with our own (older) URL
  $: if (urlQ !== hSeen) {
    hSeen = urlQ;
    if (urlQ === null) { hPushed = null; clearTimeout(st); q = ''; if (document.activeElement !== searchEl) searchOpen = false; }
    else { searchOpen = true; if (urlQ !== hPushed) { hPushed = urlQ; clearTimeout(st); q = urlQ; } }
  }
  function commitSearch(v: string) {
    clearTimeout(st);
    const t = v.trim();
    const href = t ? `/search?q=${encodeURIComponent(t)}` : '/search';
    if (path === '/search') { if (t === hPushed) return; hPushed = t; void goto(href, { replace: true, reset: false }); }
    else if (t) { hPushed = t; void goto(href, { reset: false }).then(() => scrollTo({ top: 0, behavior: 'instant' })); } // keep the focus in the field
  }
  function onSearchInput() { clearTimeout(st); st = setTimeout(() => commitSearch(q), 220); }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (q) { q = ''; commitSearch(''); } else { searchOpen = false; searchEl?.blur(); }
  }
  function openSearch() {
    if ($mobile) { void goto('/search'); return; }
    searchOpen = true; void tick().then(() => searchEl?.focus());
  }
  async function openCats(e: Event) {
    catBtn = e.currentTarget as HTMLElement; catKind = kindFromPath(path); catOpen = true;
    await tick();
    document.querySelector<HTMLElement>('.cats .close')?.focus();
    void fetchGenres();
  }
  async function fetchGenres() { if (!catGenres) { try { catGenres = ((await api('/api/library/genres')).genres as string[]) ?? []; } catch { catGenres = []; } } }
  async function toggleCats() {
    cats = !cats; menu = false; bell = false;
    if (!cats) return;
    catKind = kindFromPath(path);
    void fetchGenres();
    if (!catLangs) { try { catLangs = (((await api('/api/library/languages')).audio ?? []) as Array<{ code: string }>).map((l) => l.code).slice(0, 12); } catch { catLangs = []; } }
  }
  function closeCats(refocus = true) { catOpen = false; if (refocus) catBtn?.focus(); }
  function pickCat(href: string) { catOpen = false; void goto(href); }
  function onKey(e: KeyboardEvent) {
    // "/" and Ctrl/Cmd+K jump to the search field (not while typing somewhere else)
    if (!watchPage && !tv && ((e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) {
      const el = e.target as HTMLElement | null;
      const typing = el && (isEditable(el) || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!typing || e.key !== '/') { e.preventDefault(); openSearch(); return; }
    }
    const back = e.key === 'Escape' || (tv && isBackKey(e));
    if (!back) return;
    if (menu || bell || cats) { menu = bell = cats = false; if (tv) e.preventDefault(); return; } // dropdowns close first
    // TV: Back/Escape walks one step back (the detail popup closes itself on Escape; the player handles its own keys)
    if (tv && !watchPage && !(e.key === 'Escape' && $page.state.modalId) && !isEditable(e.target as Element)) {
      e.preventDefault();
      if (path !== '/' || $page.state.modalId) history.back();
    }
  }

  // ---- commands from the phone (only on a paired TV) ----
  function onTvCommand(m: ToTv) {
    if (m.t === 'cast') goto(`/watch/${m.itemId}${m.startSec ? `?t=${m.startSec}` : ''}`);
    else if (m.action === 'home' || m.action === 'stop') goto('/');
    else window.dispatchEvent(new CustomEvent('ff-remote', { detail: m })); // the player listens
  }

  // ---- TV focus memory: coming back (Back key) puts the focus on the card you left, a new page focuses its first element ----
  const memo = new Map<string, { href: string; nth: number }>();
  beforeNavigate(({ from }) => {
    const el = document.activeElement as HTMLElement | null, href = el?.getAttribute?.('href');
    if (!tv || !from || !href) return;
    // the same title can appear in several rows: remember which occurrence it was
    const nth = [...document.querySelectorAll(`main a[href="${CSS.escape(href)}"]`)].indexOf(el!);
    if (nth >= 0) memo.set(from.url.pathname + from.url.search, { href, nth });
  });
  /** waits for the page content (lazy rows, fetched lists), then focuses the remembered link, [data-autofocus] or the first element */
  async function settleFocus(want?: { href: string; nth: number }) {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, i ? 150 : 30));
      const main = document.querySelector('main');
      if (want) {
        const el = main?.querySelectorAll<HTMLElement>(`a[href="${CSS.escape(want.href)}"]`)[want.nth];
        if (el) return focusEl(el);
      } else if (main?.querySelector('[data-autofocus]') ? focusFirst(main, false) : i >= 4 && focusFirst(main, false)) return;
    }
  }
  afterNavigate(({ to, type }) => {
    if (!tv || !to || /^\/(watch|party)\//.test(to.url.pathname)) return;
    void settleFocus(type === 'popstate' ? memo.get(to.url.pathname + to.url.search) : undefined);
  });

  // ---- page transitions: View Transitions API where available (180 ms crossfade, main content rises 8 px; see app.css) ----
  const immersive = (p: string) => /^\/(watch|party)\//.test(p);
  onNavigate((nav) => {
    const start = (document as Document & { startViewTransition?: (cb: () => Promise<void>) => { finished: Promise<unknown> } }).startViewTransition;
    if (typeof start !== 'function' || tv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = nav.from?.url.pathname ?? '', to = nav.to?.url.pathname ?? '';
    // typing in the header search must not freeze the screen for a crossfade
    if (!nav.to || from === to || to === '/search' || immersive(from) || immersive(to) || intro) return;
    const root = document.documentElement;
    return new Promise<void>((resolve) => {
      root.classList.add('ff-vt'); // names <main> only for the duration of the transition
      const t = start.call(document, async () => { resolve(); await nav.complete; });
      void t.finished.catch(() => undefined).finally(() => root.classList.remove('ff-vt'));
    });
  });

  /** First load in this browser session: the brand intro without sound (no user gesture yet). Honours the per-profile setting. */
  function maybeColdIntro(profileId: string | undefined) {
    if (location.pathname === '/profiles') return;
    const s = loadIntroSettings(profileId);
    const ok = shouldPlayIntro({ setting: s.show, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, route: location.pathname, sessionSeen: readSessionSeen(), tv, cold: true });
    if (ok) { markSessionSeen(); intro = true; }
  }

  function outside(e: MouseEvent) { if (!(e.target as HTMLElement).closest('.pop-anchor')) { menu = false; bell = false; cats = false; } }

  let stops: Array<() => void> = [];
  onMount(() => {
    const onNotes = () => void loadNotes();
    window.addEventListener('ff-notes', onNotes);
    const onHelp = () => (help = true); // "Hilfe" on /me
    window.addEventListener('ff-help', onHelp);
    const onOnboarded = () => { if (me) me = { ...me, onboarded: true }; }; // /welcome finished
    window.addEventListener('ff-onboarded', onOnboarded);
    stops.push(() => { window.removeEventListener('ff-notes', onNotes); window.removeEventListener('ff-help', onHelp); window.removeEventListener('ff-onboarded', onOnboarded); });
    // header background: a 10 px sentinel at the top of the document instead of reading scrollY on every scroll event
    if (typeof IntersectionObserver === 'function' && sentinel) {
      const io = new IntersectionObserver(([e]) => { scrolled = !e!.isIntersecting; });
      io.observe(sentinel);
      stops.push(() => io.disconnect());
    }
    // the detail popup chunk loads as soon as the pointer/focus/finger gets near a card or an info button
    const warm = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.card, .pc, a[href^="/item/"], [data-modal]')) return;
      prefetchModal(); unwarm();
    };
    const evs = ['pointerover', 'focusin', 'touchstart'] as const;
    const unwarm = () => evs.forEach((t) => document.removeEventListener(t, warm));
    evs.forEach((t) => document.addEventListener(t, warm, { passive: true }));
    stops.push(unwarm);
    const flag = new URLSearchParams(location.search).get('tv');
    if (flag === '1') sessionStorage.setItem('ff_tv', '1'); else if (flag === '0') sessionStorage.removeItem('ff_tv');
    online = navigator.onLine;
    const setOnline = () => (online = navigator.onLine);
    window.addEventListener('online', setOnline); window.addEventListener('offline', setOnline);
    stops.push(() => { window.removeEventListener('online', setOnline); window.removeEventListener('offline', setOnline); });
    void boot();
    // Notification clicks (service worker) ask an already open window to navigate in-app.
    const onSwMessage = (e: MessageEvent) => {
      const link = e.data?.type === 'ff-nav' ? e.data.link : null;
      if (typeof link === 'string' && /^\/(?!\/)/.test(link)) void goto(link);
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => { clearTimeout(st); navigator.serviceWorker?.removeEventListener('message', onSwMessage); stops.forEach((f) => f()); };
  });

  /** A pending device checks every few seconds whether it was approved and then reloads into the real app. */
  async function checkApproval() {
    checking = true;
    try { const m = await api<Me>('/api/me'); if (m.deviceApproved) { location.reload(); return true; } } catch { /* retry on the next tick */ } finally { checking = false; }
    return false;
  }
  function watchApproval() { const t = setInterval(checkApproval, 4000); return () => clearInterval(t); }

  async function boot() {
    if (!publicPage) {
      try {
        const m = await api<Me>('/api/me');
        setCsrf(m.csrfToken);
        setActiveProfile(m.profile?.id);
        serverCaps.set(capsFrom(m.server?.capabilities));
        writeHint(hintOf(m)); writeActive(m.profile?.id); clearReloadFlag(); // the profile-switch reload is done: a later reload may render early again
        if (m.profile?.id) void setMeta('lastProfileId', m.profile.id).catch(() => undefined); // the offline hub shows the last active profile's downloads
        pending = !m.deviceApproved;
        // "Wer schaut gerade?": when no profile is chosen, and once per browser session for accounts with several profiles
        if (!pending && needsProfileGate(m, location.pathname, readPicked())) {
          await goto(gateHref(location.pathname + location.search), { replaceState: true });
        }
        // a kids profile never mounts a grown-up page; a new profile starts with /welcome (after the language question, which
        // is an overlay above it)
        else if (!pending && kidsRedirect(m, location.pathname)) await goto(kidsRedirect(m, location.pathname)!, { replaceState: true });
        else if (!pending && needsWelcome(m, location.pathname)) await goto(welcomeHref(location.pathname + location.search, m.kids), { replaceState: true });
        // the server language is active before the page mounts (an early-rendered page only gets the $t texts updated;
        // older servers send no language: keep the remembered one)
        if (m.language) await setLocale(m.language);
        me = m;
        if (!pending && m.isAdmin && m.profile?.isOwner && m.defaultLanguageSet === false) { langAsk = 'instance'; langPre = 'de'; }
        else if (!pending && m.profile && m.languageChosen === false) {
          langAsk = 'profile';
          langPre = pickLocale([m.suggestedLanguage, typeof navigator !== 'undefined' ? navigator.language : null]) ?? (isLocale(m.defaultLanguage) ? m.defaultLanguage : 'de');
        }
        if (early) window.dispatchEvent(new Event('ff-me')); // pages that rendered early can now read the active profile
        if (pending) stops.push(watchApproval());
        tv = m.tv || sessionStorage.getItem('ff_tv') === '1';
        if (!pending) maybeColdIntro(m.profile?.id);
        if (!pending) { loadNotes(); loadList(); loadPrefs(); const notesTimer = setInterval(loadNotes, 60_000); stops.push(() => clearInterval(notesTimer)); }
        if (m.tv) localStorage.setItem('ff_tv_device', '1'); // an expired TV session goes back to the pairing screen, not to a login form
        if (tv) {
          { let t: ReturnType<typeof setTimeout>; const wake = () => { document.documentElement.classList.remove('idle-cursor'); clearTimeout(t); t = setTimeout(() => document.documentElement.classList.add('idle-cursor'), 4000); }; wake(); window.addEventListener('mousemove', wake); stops.push(() => { window.removeEventListener('mousemove', wake); clearTimeout(t); }); }
          stops.push(startSpatial(() => !watchPage || Boolean(document.activeElement?.closest('[data-nav]'))));
          if (!watchPage) void settleFocus();
        }
        if (m.tv && !pending) stops.push(startTvLink(onTvCommand, (code) => { if (code === 4401) location.href = '/tv'; else if (code === 4000) replaced = true; }));
      } catch { /* api() redirects to login on 401 */ }
    }
  }
</script>

<svelte:window on:keydown={onKey} on:click={outside} />
<div class="top-sentinel" aria-hidden="true" bind:this={sentinel}></div>
<a class="skip" href="#main">{$t('shell.skipToContent')}</a>
{#if intro}<Intro on:done={() => (intro = false)} />{/if}

{#if publicPage}
  <slot />
{:else if pageReady}
  {#if !watchPage && !profilesPage && kidsUi}
    <header class="nav kidsnav" class:solid={scrolled || !path.startsWith('/kids')}>
      <a class="klogo" href="/kids" aria-label={$t('kids.nav.home')}><Logo wordmark={!$mobile} size={$mobile ? 30 : 32} label="" /><span class="kbadge">{$t('kids.badge')}</span></a>
      <span class="sp"></span>
      <nav class="knav" aria-label={$t('kids.nav.label')}>
        <a class="kbtn" href="/kids/search" aria-label={$t('kids.nav.search')} aria-current={path.startsWith('/kids/search') ? 'page' : undefined}><Icon name="search" size={26} /></a>
        <a class="kav" href="/profiles" aria-label={$t('kids.nav.switchProfile', { name: who })}><span class="face" style={faceStyle}>{initial(who)}</span></a>
      </nav>
    </header>
  {:else if !watchPage && !profilesPage}
    {#if $mobile}
      <header class="nav m" class:solid={scrolled || !heroPage} class:chips>
        <div class="mrow">
          <a class="mlogo" href="/profiles" aria-label={who ? $t('shell.mobile.switchProfileCurrent', { name: who }) : $t('shell.mobile.switchProfile')}><Logo size={30} label="" /><span class="for">{who ? $t('shell.mobile.forName', { name: who }) : ''}</span></a>
          <span class="sp"></span>
          <a class="icon-btn" href="/search" aria-label={$t('shell.mobile.search')} aria-current={path.startsWith('/search') ? 'page' : undefined}><Icon name="search" size={24} /></a>
          <a class="icon-btn" href="/downloads" aria-label={$t('shell.mobile.downloads')} aria-current={path.startsWith('/downloads') ? 'page' : undefined}><Icon name="download" size={24} /></a>
          <a class="avatar" href="/me" aria-label={unread ? $t('shell.mobile.meUnread', { n: unread }) : $t('shell.mobile.me')}><span class="face" style={faceStyle}>{initial(who)}</span>{#if unread}<span class="dot" aria-hidden="true">{unread}</span>{/if}</a>
        </div>
        {#if chips}
          <nav class="chipbar" aria-label={$t('shell.cats.title')}>
            <a class="chip" href="/browse/series" class:on={path.startsWith('/browse/series')} aria-current={path.startsWith('/browse/series') ? 'page' : undefined}>{$t('shell.nav.series')}</a>
            <a class="chip" href="/browse/movies" class:on={path.startsWith('/browse/movies')} aria-current={path.startsWith('/browse/movies') ? 'page' : undefined}>{$t('shell.nav.movies')}</a>
            <button type="button" class="chip" aria-haspopup="dialog" aria-expanded={catOpen} on:click={openCats}>{$t('shell.nav.categories')}<Icon name="chevron-down" size={16} /></button>
          </nav>
        {/if}
      </header>
    {:else}
    <header class="nav" class:solid={scrolled || !heroPage}>
      <a class="logo" href="/" aria-label={$t('shell.nav.homeLink')}><Logo wordmark size={34} /></a>
      <nav class="links" aria-label={$t('shell.nav.main')}>
        {#each HEADER_TABS as [href, label] (href)}<a {href} class:active={isTabActive(href, path)} aria-current={isTabActive(href, path) ? 'page' : undefined}>{$t(label)}</a>{/each}
        <div class="pop-anchor">
          <button type="button" class="linkbtn" aria-haspopup="true" aria-expanded={cats} on:click={toggleCats}>{$t('shell.nav.categories')}<i class="caret" class:up={cats}></i></button>
          {#if cats}
            <div class="drop catdrop" role="region" aria-label={$t('shell.cats.title')}>
              <div class="cseg">
                <div class="seg" role="group" aria-label={$t('shell.cats.kind')}>
                  <button type="button" class:on={catKind === 'movies'} aria-pressed={catKind === 'movies'} on:click={() => (catKind = 'movies')}>{$t('common.movies')}</button>
                  <button type="button" class:on={catKind === 'series'} aria-pressed={catKind === 'series'} on:click={() => (catKind = 'series')}>{$t('common.series')}</button>
                </div>
                <a class="coll" href="/collections">{$t('shell.cats.collections')}</a>
              </div>
              <div class="ccols">
                <section aria-labelledby="cg-h"><h2 id="cg-h" class="ch">{$t('shell.cats.genres')}</h2>
                  {#if catGenres === null}<p class="muted pad" role="status">{$t('common.loading')}</p>
                  {:else}<ul class="glist">{#each catGenres as g (g)}<li><a href={categoryHref(catKind, g)}>{g}</a></li>{/each}</ul>{/if}
                </section>
                <section aria-labelledby="cl-h"><h2 id="cl-h" class="ch">{$t('shell.cats.byLanguage')}</h2>
                  {#if catLangs === null}<p class="muted pad" role="status">{$t('common.loading')}</p>
                  {:else if !catLangs.length}<p class="muted pad">{$t('shell.cats.none')}</p>
                  {:else}<ul class="glist">{#each catLangs as c (c)}<li><a href="/browse/{catKind}?audio={encodeURIComponent(c)}">{langLabel(c)}</a></li>{/each}</ul>{/if}
                </section>
              </div>
            </div>
          {/if}
        </div>
      </nav>
      <span class="sp"></span>
      <form class="search" class:open={searchOpen} on:submit|preventDefault={() => commitSearch(q)} role="search">
        <button type="button" class="icon-btn" aria-label={searchOpen ? $t('shell.search.submit') : $t('shell.search.open')} on:click={() => (searchOpen ? commitSearch(q) : openSearch())}><Icon name="search" size={22} /></button>
        <input id="hq" type="search" bind:this={searchEl} bind:value={q} autocomplete="off" enterkeyhint="search" placeholder={$t('shell.search.placeholder')} aria-label={$t('shell.search.label')} tabindex={searchOpen ? 0 : -1}
          on:input={onSearchInput} on:keydown={onSearchKey} on:blur={() => { if (!q && path !== '/search') searchOpen = false; }} />
      </form>
      <div class="pop-anchor">
        <button class="icon-btn" aria-label={unread ? $t('shell.bell.unread', { n: unread }) : $t('shell.bell.label')} aria-expanded={bell} on:click={toggleBell}>
          <Icon name="bell" size={22} />{#if unread}<span class="dot">{unread}</span>{/if}
        </button>
        {#if bell}
          <div class="drop wide" role="menu">
            {#each notes as n}{#if n.link}<a href={n.link} class:muted={n.read} role="menuitem">{n.title}</a>{:else}<span class="note" class:muted={n.read} role="none">{n.title}</span>{/if}{:else}<span class="muted pad">{$t('shell.bell.empty')}</span>{/each}
          </div>
        {/if}
      </div>
      <div class="pop-anchor">
        <button class="avatar" aria-label={who ? $t('shell.account.labelWho', { name: who }) : $t('shell.account.label')} aria-haspopup="menu" aria-expanded={menu} disabled={!me} on:click={toggleMenu}><span class="face" style={faceStyle}>{initial(who)}</span><i class="caret" class:up={menu}></i></button>
        {#if menu && me}
          <div class="drop acct" role="menu" aria-label={$t('shell.account.label')}>
            {#if multi}
              {#if others === null}<span class="muted pad" role="status">{$t('shell.account.loadingProfiles')}</span>{/if}
              {#each others ?? [] as p (p.id)}<a class="prof" href={switchHref(p.id)} role="menuitem" data-sveltekit-reload><span class="face xs" style="background:{avatarBg(p.avatar)}" aria-hidden="true">{initial(p.name)}</span>{p.name}{#if p.hasPin}<Icon name="lock" size={14} label={$t('shell.account.withPin')} />{/if}</a>{/each}
            {/if}
            <a href="/profiles?manage=1" role="menuitem"><Icon name="users" size={18} />{$t('shell.account.manageProfiles')}</a>
            <hr />
            <a href="/me" role="menuitem"><Icon name="user" size={18} />{$t('shell.menu.me')}</a>
            <a href="/settings" role="menuitem"><Icon name="settings" size={18} />{$t('shell.menu.accountSettings')}</a>
            <a href="/devices" role="menuitem"><Icon name="monitor" size={18} />{$t('shell.menu.devices')}</a>
            {#if canDownload}<a href="/downloads" role="menuitem"><Icon name="download" size={18} />{$t('shell.menu.downloads')}</a>{/if}
            <button class="plain" role="menuitem" on:click={surprise}><Icon name="shuffle" size={18} />{$t('shell.menu.surprise')}</button>
            <button class="plain" role="menuitem" on:click={openHelp}><Icon name="info" size={18} />{$t('shell.menu.help')}</button>
            {#if admin}<a href="/admin" role="menuitem"><Icon name="shield" size={18} />{$t('shell.menu.admin')}</a>{/if}
            <hr />
            <button class="plain out" role="menuitem" on:click={logout}>{$t('shell.account.logout')}</button>
          </div>
        {/if}
      </div>
    </header>
    {/if}
    <nav class="tabbar" aria-label={$t('shell.mobile.tabbar')}>
      <a href="/" class:active={path === '/'} aria-current={path === '/' ? 'page' : undefined}><Icon name="home" size={22} /><span>{$t('shell.tabs.home')}</span></a>
      <a href="/new" class:active={path.startsWith('/new')} aria-current={path.startsWith('/new') ? 'page' : undefined}><Icon name="star" size={22} /><span>{$t('shell.tabs.new')}</span></a>
      <a href="/me" class:active={path.startsWith('/me')} aria-current={path.startsWith('/me') ? 'page' : undefined}><span class="face sm" aria-hidden="true" style={faceStyle}>{initial(who)}</span><span>{$t('shell.tabs.me')}</span></a>
    </nav>
    {#if catOpen && $mobile}
      <div class="cats" role="dialog" aria-modal="true" aria-label={$t('shell.cats.title')} use:dialogKeys={{ close: () => closeCats() }}>
        <div class="chead">
          <div class="seg" role="group" aria-label={$t('shell.cats.kind')}>
            <button type="button" class:on={catKind === 'movies'} aria-pressed={catKind === 'movies'} on:click={() => (catKind = 'movies')}>{$t('common.movies')}</button>
            <button type="button" class:on={catKind === 'series'} aria-pressed={catKind === 'series'} on:click={() => (catKind = 'series')}>{$t('common.series')}</button>
          </div>
          <button type="button" class="close" aria-label={$t('common.close')} on:click={() => closeCats()}><Icon name="x" size={24} /></button>
        </div>
        <ul class="clist">
          <li><a href="/watchlist" on:click|preventDefault={() => pickCat('/watchlist')}>{$t('shell.nav.myList')}</a></li>
          <li><a href="/collections" on:click|preventDefault={() => pickCat('/collections')}>{$t('shell.cats.collections')}</a></li>
          {#if catGenres === null}<li class="muted" role="status">{$t('shell.cats.loadingCats')}</li>
          {:else}{#each catGenres as g (g)}<li><a href={categoryHref(catKind, g)} on:click|preventDefault={() => pickCat(categoryHref(catKind, g))}>{g}</a></li>{/each}{/if}
        </ul>
      </div>
    {/if}
    {#if $mobile && $previewSheet}<MobilePreviewSheet />{/if}
  {/if}

  {#if !online}<div class="offbar" role="status">{$t('shell.offline.bar')} <a href="/offline" data-sveltekit-reload>{$t('shell.offline.toDownloads')}</a></div>{/if}
  {#if replaced}<div class="panel" role="alert" style="position:fixed;z-index:90;top:5rem;left:50%;transform:translateX(-50%)"><b>{$t('shell.tvReplaced.text')}</b> <button on:click={() => location.reload()}>{$t('shell.tvReplaced.reconnect')}</button></div>{/if}
  {#if modalId && Modal}<svelte:component this={Modal} id={modalId} />{/if}
  <main id="main" class:page={!heroPage && !watchPage && !profilesPage && !kidsPage}>
    {#if pending}
      <div class="page"><div class="panel pendp">
        <b class="warn">{$t('shell.pending.title')}</b>
        <p class="muted">{$t('shell.pending.intro')}</p>
        <ol class="muted">
          <li>{$t('shell.pending.step1')}</li>
          <li><Rich text={$t('shell.pending.step2')} /></li>
          <li><Rich text={$t('shell.pending.step3')} /></li>
        </ol>
        <p class="muted"><Rich text={$t('shell.pending.admin')} /></p>
        <div class="flex"><button class="sec" disabled={checking} on:click={checkApproval}>{checking ? $t('shell.pending.checking') : $t('shell.pending.check')}</button><a class="btn sec" href="/devices">{$t('shell.pending.devices')}</a></div>
      </div></div>
    {:else}
      <!-- a language switch made by the person re-renders the page once, so texts computed in scripts (tr(), fmtDate() …)
           follow it too; the language /api/me reports is applied before the page mounts and never re-renders it -->
      {#key $pageEpoch}<slot />{/key}
    {/if}
  </main>
  {#if !watchPage && !profilesPage && !tv && !pending && !$mobile}<Footer onHelp={() => (help = true)} kids={kidsUi} />{/if}
  {#if langAsk && path !== '/profiles'}<!-- also above /welcome: the language comes first -->
    <LanguageGate mode={langAsk} preselect={langPre} onChoose={langAsk === 'instance' ? chooseInstance : chooseProfile}
      onSkip={langAsk === 'profile' ? skipLanguage : null} />
  {/if}
  {#if help}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="hov" on:click|self={() => (help = false)}>
      <div class="hbox" role="dialog" aria-modal="true" aria-labelledby="help-h" use:dialogKeys={{ close: () => (help = false) }}>
        <div class="hhead"><h2 id="help-h">{$t('shell.help.title')}</h2><button type="button" class="icon-btn" aria-label={$t('common.close')} on:click={() => (help = false)} data-autofocus><Icon name="x" size={22} /></button></div>
        <dl>
          {#each HELP as [dt, dd] (dt)}<dt>{$t(dt)}</dt><dd><Rich text={$t(dd)} onLink={() => (help = false)} /></dd>{/each}
        </dl>
      </div>
    </div>
  {/if}
{:else}
  <main id="main" class="boot"><span class="logo"><Logo wordmark size={44} /></span><div class="spin" aria-label={$t('shell.booting')} role="status"></div></main>
{/if}

<style>
  .offbar { position: fixed; z-index: 80; left: 0; right: 0; bottom: calc(56px + env(safe-area-inset-bottom)); background: #2a2a2a; padding: .6rem var(--pad-x); text-align: center; font-size: .9rem; }
  .offbar a { text-decoration: underline; font-weight: 600; }
  @media (min-width: 721px) { .offbar { bottom: 0; } }
  .logo { display: inline-flex; align-items: center; }
  .nav { position: fixed; top: 0; left: 0; right: 0; height: var(--nav-h); z-index: 50; display: flex; align-items: center; gap: .5rem; padding: 0 var(--pad-x); background: linear-gradient(to bottom, rgba(0,0,0,.9), rgba(0,0,0,.55) 55%, transparent); transition: background var(--t-med); }
  .nav.solid { background: var(--bg); }
  .links { display: flex; gap: 1.5rem; margin-left: 2.2rem; }
  .links a { font-size: .95rem; font-weight: 500; color: #e5e5e5; transition: color var(--t-fast); white-space: nowrap; padding: .6rem 0; }
  .links a:hover { color: #b3b3b3; } .links a.active { color: #fff; font-weight: 700; }
  .sp { flex: 1; }
  .search { display: flex; align-items: center; border: 1px solid transparent; transition: border-color var(--t-fast), background var(--t-fast); border-radius: 4px; }
  .search.open { border-color: #fff; background: rgba(0,0,0,.75); }
  .search input { width: 0; padding: 0; border: 0; background: transparent; transition: width var(--t-med) var(--ease), padding var(--t-med); min-height: 40px; }
  .search.open input { width: clamp(120px, 24vw, 280px); padding: 0 .5rem 0 0; }
  .search input:focus-visible { outline: none; }
  .pop-anchor { position: relative; }
  .dot { position: absolute; top: 4px; right: 2px; background: var(--acc); font-size: .65rem; min-width: 1.1rem; height: 1.1rem; border-radius: 99px; display: grid; place-items: center; font-weight: 700; }
  .avatar { width: auto; min-height: 44px; height: 44px; padding: 0 .1rem; background: transparent; gap: .45rem; border-radius: 4px; }
  .avatar:hover:not(:disabled) { background: transparent; }
  .face { width: 34px; height: 34px; border-radius: 4px; display: grid; place-items: center; background: linear-gradient(135deg, #ff3b52, #7a0a17); font-weight: 800; box-shadow: 0 0 0 1px rgba(255,255,255,.12); }
  .caret { width: 0; height: 0; border: 5px solid transparent; border-top-color: #fff; border-bottom: 0; transition: transform var(--t-fast); }
  .caret.up { transform: rotate(180deg); }
  /* ---- kids header: bright, big touch targets, logo + "Kids" badge, search, avatar (switch profile) ---- */
  .kidsnav { background: linear-gradient(100deg, #4f6bed, #7b5cff); color: #fff; } /* always solid: the white wordmark stays readable */
  .kidsnav.solid { box-shadow: 0 2px 14px rgba(32,35,58,.25); }
  .klogo { display: inline-flex; align-items: center; gap: .6rem; min-height: 48px; color: #fff; }
  .kbadge { display: inline-grid; place-items: center; min-height: 30px; padding: 0 .8rem; border-radius: 99px; background: linear-gradient(135deg, #ff5d8f, #ffb703); color: #fff; font-weight: 900; font-size: .95rem; letter-spacing: .04em; }
  .knav { display: flex; align-items: center; gap: .5rem; }
  .kbtn, .kav { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; color: #20233a; }
  .kbtn { background: #fff; box-shadow: 0 2px 8px rgba(32,35,58,.15); }
  .kbtn:focus-visible, .kav:focus-visible, .klogo:focus-visible { outline: 4px solid #ffb703; outline-offset: 2px; }
  .kav .face { width: 46px; height: 46px; border-radius: 50%; font-size: 1.1rem; color: #fff; box-shadow: 0 0 0 3px rgba(255,255,255,.85); }
  .top-sentinel { position: absolute; top: 0; left: 0; width: 1px; height: 10px; pointer-events: none; visibility: hidden; }
  .drop { position: absolute; right: 0; top: calc(100% + 6px); background: rgba(0,0,0,.94); border: 1px solid #333; border-radius: 4px; min-width: 220px; padding: .4rem 0; display: flex; flex-direction: column; box-shadow: 0 12px 30px rgba(0,0,0,.7); max-height: calc(100vh - var(--nav-h) - 16px); max-height: calc(100dvh - var(--nav-h) - 16px); overflow-y: auto; overscroll-behavior: contain; animation: drop-in .16s var(--ease); }
  @keyframes drop-in { from { opacity: 0; transform: translateY(-4px); } }
  .drop hr { border: 0; border-top: 1px solid #333; margin: .3rem 0; width: 100%; }
  .acct { min-width: 240px; }
  .acct .prof { font-weight: 500; }
  .face.xs { width: 32px; height: 32px; font-size: .85rem; flex: none; }
  .acct .out { justify-content: center; }
  .linkbtn { background: transparent; padding: .6rem 0; min-height: 44px; font-size: .95rem; font-weight: 500; color: #e5e5e5; gap: .4rem; border-radius: 0; }
  .linkbtn:hover:not(:disabled) { background: transparent; color: #b3b3b3; }
  .links .pop-anchor { display: flex; }
  .catdrop { left: -1rem; right: auto; width: min(560px, 80vw); padding: 1rem 1.2rem 1.1rem; }
  .cseg { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .6rem; }
  .catdrop .seg button { min-height: 36px; }
  .catdrop .coll { font-weight: 700; color: #fff; padding: .4rem 0; min-height: 44px; display: inline-flex; align-items: center; }
  .catdrop .coll:hover { text-decoration: underline; }
  .ccols { display: grid; grid-template-columns: 2fr 1fr; gap: 1.2rem; }
  .ch { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); margin: 0 0 .3rem; font-weight: 600; }
  .glist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 1rem; }
  .ccols section:last-child .glist { grid-template-columns: 1fr; }
  .catdrop .glist a { display: flex; align-items: center; min-height: 44px; padding: 0; font-size: .9rem; color: #e5e5e5; }
  .catdrop .glist a:hover { text-decoration: underline; background: transparent; }
  .hov { position: fixed; inset: 0; z-index: 96; background: rgba(0,0,0,.7); display: grid; place-items: center; padding: 1rem; animation: fade .2s ease-out; }
  .hbox { background: #181818; border: 1px solid #333; border-radius: 8px; width: min(560px, 100%); max-height: 90dvh; overflow-y: auto; padding: 1.2rem 1.4rem 1.4rem; box-shadow: 0 20px 60px rgba(0,0,0,.8); }
  .hhead { display: flex; align-items: center; justify-content: space-between; }
  .hhead h2 { margin: 0; font-size: 1.3rem; }
  .hbox dl { margin: .6rem 0 0; display: grid; gap: .25rem; }
  .hbox dt { font-weight: 700; margin-top: .6rem; }
  .hbox dd { margin: 0; color: #cfcfcf; font-size: .93rem; line-height: 1.5; }
  .hbox :global(a) { text-decoration: underline; }
  .hbox :global(kbd), .pendp :global(kbd) { display: inline-block; min-width: 1.4em; padding: 0 .35em; border: 1px solid #555; border-bottom-width: 2px; border-radius: 4px; font: inherit; font-size: .82em; text-align: center; background: #222; }
  .drop.wide { width: min(340px, 90vw); }
  .drop .note { display: block; padding: .55rem 1rem; font-size: .9rem; color: #e5e5e5; }
  .drop .note.muted { color: var(--mut); }
  .drop a, .drop .plain { display: flex; gap: .7rem; align-items: center; padding: .55rem 1rem; font-size: .9rem; color: #e5e5e5; min-height: 44px; }
  .drop a:hover, .drop .plain:hover { text-decoration: underline; background: transparent; }
  .plain { background: transparent; border-radius: 0; justify-content: flex-start; font-weight: 400; width: 100%; }
  .pad { padding: .8rem 1rem; }
  .tabbar { display: none; }
  @media (min-width: 721px) { main:not(.boot) { min-height: 100vh; } } /* the footer starts below the fold on short pages */
  .boot { min-height: 100vh; display: grid; place-content: center; gap: 1.2rem; justify-items: center; }
  .spin { width: 34px; height: 34px; border: 3px solid #333; border-top-color: var(--acc); border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @media (max-width: 900px) { .links { display: none; } }
  @media (max-width: 1100px) { .links { gap: 1.1rem; margin-left: 1.4rem; } }
  @media (max-width: 720px) {
    .tabbar { display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 60; background: rgba(12,12,12,.97); border-top: 1px solid #262626; padding-bottom: env(safe-area-inset-bottom); }
    .tabbar a { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .15rem; min-height: 56px; padding: 0 2px; font-size: .68rem; color: var(--mut); font-weight: 500; }
    .tabbar span:not(.face) { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tabbar a.active { color: #fff; font-weight: 700; }
    .tabbar .face.sm { width: 24px; height: 24px; font-size: .72rem; border-radius: 4px; }
    .tabbar a.active .face.sm { box-shadow: 0 0 0 2px #fff; }
    main { padding-bottom: 70px; }
  }

  /* ---- phone header: transparent over the hero, solid + blurred once scrolled; sticky chip bar below ---- */
  .nav.m { height: auto; flex-direction: column; align-items: stretch; gap: 0; padding: 0; background: linear-gradient(to bottom, rgba(0,0,0,.7), transparent); transition: background var(--t-med), backdrop-filter var(--t-med); }
  .nav.m.solid { background: rgba(20,20,20,.95); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
  .mrow { display: flex; align-items: center; gap: .1rem; height: 56px; padding: 0 calc(var(--pad-x) - 8px) 0 var(--pad-x); }
  .mlogo { display: inline-flex; align-items: center; gap: .6rem; min-height: 44px; min-width: 0; }
  .for { font-size: 1.1rem; font-weight: 800; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; text-shadow: 0 1px 8px rgba(0,0,0,.6); }
  .nav.m .icon-btn { display: inline-flex; align-items: center; justify-content: center; }
  .nav.m .avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 4px; }
  .nav.m .face { width: 30px; height: 30px; font-size: .9rem; }
  .nav.m .dot { top: 2px; right: 0; }
  .chipbar { display: flex; gap: .5rem; align-items: center; height: 48px; padding: 0 var(--pad-x); overflow-x: auto; scrollbar-width: none; }
  .chipbar::-webkit-scrollbar { display: none; }
  .chip::after, .seg button::after { content: ''; position: absolute; inset: -4px 0; }
  .chip { position: relative; flex: none; display: inline-flex; align-items: center; gap: .3rem; min-height: 36px; padding: 0 .95rem; border-radius: 99px; border: 1px solid rgba(255,255,255,.5); background: rgba(0,0,0,.25); color: #fff; font: inherit; font-size: .9rem; font-weight: 500; }
  .chip:hover:not(:disabled) { background: rgba(255,255,255,.12); }
  .chip.on, .chip.on:hover:not(:disabled) { background: #fff; color: #000; border-color: #fff; font-weight: 700; }
  :global(html.m-chips) { --nav-h: 104px; }
  @media (max-width: 720px) { :global(html:not(.m-chips)) { --nav-h: 56px; } }

  /* ---- categories overlay ---- */
  .cats { position: fixed; inset: 0; z-index: 95; background: rgba(10,10,10,.97); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow-y: auto; overscroll-behavior: contain; padding: 0 var(--pad-x) calc(2rem + env(safe-area-inset-bottom)); animation: fade .2s ease-out; }
  .chead { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; padding: .7rem 0; background: linear-gradient(rgba(10,10,10,1) 70%, transparent); z-index: 1; }
  .seg { display: inline-flex; border: 1px solid #555; border-radius: 99px; overflow: hidden; }
  .seg button { position: relative; background: transparent; border-radius: 0; min-height: 40px; padding: 0 1.1rem; color: #ddd; font-weight: 600; }
  .seg button:hover:not(:disabled) { background: rgba(255,255,255,.1); }
  .seg button.on, .seg button.on:hover:not(:disabled) { background: #fff; color: #000; }
  .cats .close { width: 48px; height: 48px; padding: 0; border-radius: 50%; background: #fff; color: #000; }
  .cats .close:hover:not(:disabled) { background: rgba(255,255,255,.8); }
  .clist { list-style: none; margin: .6rem 0 0; padding: 0; text-align: center; }
  .clist li { padding: 0; }
  .clist a { display: block; padding: .72rem 0; font-size: 1.2rem; color: #b8b8b8; }
  .clist li:first-child a, .clist li:nth-child(2) a { font-weight: 700; color: #fff; }
  .clist a:active, .clist a:hover { color: #fff; }
  .clist .muted { padding: 1rem 0; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .cats, .drop, .hov { animation: none; } }
</style>
