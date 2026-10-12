<script lang="ts">
  import { onMount } from 'svelte';
  import { SIZE_LABELS, COLOR_LABELS, BG_LABELS, FONT_LABELS, subClasses } from '#lib/substyle';
  import { api, getActiveProfile } from '#lib/api';
  import Intro from '#lib/Intro.svelte';
  import { loadIntroSettings, saveIntroSettings, shouldPlayIntroSound } from '#lib/intro';
  import { prefs, savePrefs, saveLanguage, mergePrefsInto, DEFAULT_PREFS, type Prefs } from '#lib/stores';
  import { pushState, enablePush, disablePush, updateBroadcast, testPush, syncPush, type PushState } from '#lib/push';
  import { LOCALES, isLocale, keepPageOnSwitch, locale, localeName, t, tr, type Locale, type TKey } from '#lib/i18n';
  import { langLabel } from '#lib/langs';
  import type { Me } from '#lib/api';

  /** audio/subtitle track languages (ISO 639-2 as Jellyfin reports them; names in the UI language) */
  const LANGS = ['ger', 'eng', 'fre', 'spa', 'ita', 'jpn'];
  const QUALITIES: Array<[number, TKey]> = [[0, 'account.settings.qualityAuto'], [8_000_000, 'account.settings.quality1080'], [4_000_000, 'account.settings.quality720'], [1_500_000, 'account.settings.quality480'], [800_000, 'account.settings.quality360']];
  /** track language names in the UI language; re-evaluated on a switch (the page is not rebuilt, see below) */
  $: trackName = $locale ? (v: string) => langLabel(v) : langLabel;
  type BoolPref = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs];
  let form: Prefs = { ...DEFAULT_PREFS }, saved = false, error = '', busy = false;
  let owner = false, me: Me | null = null;
  // ---- UI language (own section, saved right away). This page is not rebuilt on a switch (keepPageOnSwitch): all its
  // texts are reactive, and unsaved edits in the form below survive the switch. ----
  let langBusy = false, langErr = '', instLang: Locale = 'de', instBusy = false, instMsg = '';
  $: admin = Boolean(me?.isAdmin && me?.profile?.isOwner);
  $: defaultName = localeName(isLocale(me?.defaultLanguage) ? me!.defaultLanguage! : 'de');
  async function pickLanguage(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    langBusy = true; langErr = '';
    try { await saveLanguage(sel.value as Locale); } catch { langErr = tr('account.language.saveFailed'); sel.value = $locale; }
    langBusy = false;
  }
  async function saveInstance() {
    instBusy = true; instMsg = '';
    try { await api('/api/admin/settings/language', { method: 'PUT', body: { language: instLang } }); if (me) me = { ...me, defaultLanguage: instLang, defaultLanguageSet: true }; instMsg = tr('account.language.savedTo'); }
    catch { instMsg = tr('account.language.saveFailed'); }
    instBusy = false;
  }
  onMount(() => {
    api<Me>('/api/me').then((m) => { me = m; owner = Boolean(m.profile?.isOwner); if (isLocale(m.defaultLanguage)) instLang = m.defaultLanguage; }).catch(() => undefined);
    // only fields that changed in the store are taken over (a language switch must not discard unsaved edits)
    let prev: Prefs | null = null;
    const unsub = prefs.subscribe((p) => { form = mergePrefsInto(form, prev, p); prev = p; });
    const keep = keepPageOnSwitch();
    return () => { unsub(); keep(); };
  });
  // ---- brand intro (stored per profile in localStorage, not on the server) ----
  let introShow = true, introSound = true, previewing = false, previewSound = false;
  onMount(() => { const s = loadIntroSettings(getActiveProfile()); introShow = s.show; introSound = s.sound; });
  const saveIntro = () => saveIntroSettings(getActiveProfile(), { show: introShow, sound: introSound });
  function previewIntro() {
    // pressing the button is an explicit request, so the sound plays even with reduced motion if "Intro-Ton" is on
    previewSound = shouldPlayIntroSound({ sound: introSound, soundExplicit: true, reducedMotion: false });
    previewing = true;
  }
  let ps: PushState = 'off', pushOn = false, pushBroadcast = false, pushBusy = false, pushMsg = '';
  async function refreshPush() { ps = await pushState().catch(() => 'unsupported' as PushState); pushOn = ps === 'on'; }
  onMount(() => { void refreshPush().then(async () => { if (ps === 'on') { const b = await syncPush(); if (b !== null) pushBroadcast = b; } }); });
  async function togglePush() {
    pushBusy = true; pushMsg = '';
    try {
      if (pushOn) ps = await enablePush(pushBroadcast); else { await disablePush(); ps = 'off'; }
    } catch { pushMsg = tr('common.failed'); ps = await pushState().catch(() => 'off' as PushState); }
    pushOn = ps === 'on'; pushBusy = false;
  }
  async function toggleBroadcast() { try { await updateBroadcast(pushBroadcast); } catch { pushMsg = tr('common.saveFailed'); } }
  async function sendTest() {
    pushBusy = true; pushMsg = '';
    try { const r = await testPush(); pushMsg = r.sent ? tr('account.settings.push.testSent') : tr('account.settings.push.testRejected'); } catch { pushMsg = tr('account.settings.push.testFailed'); }
    pushBusy = false;
  }
  async function save() {
    busy = true; error = ''; saved = false;
    try { await savePrefs({ ...form, quality: Number(form.quality) }); saved = true; setTimeout(() => (saved = false), 2500); } catch { error = tr('common.saveFailed'); }
    busy = false;
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.settings.pageTitle') })}</title></svelte:head>
<section class="panel form langsec" id="language" aria-labelledby="langh">
  <h2 id="langh">{$t('account.language.settingsTitle')}</h2>
  <div class="field"><label for="ui-lang" class="sr-only">{$t('account.language.settingsTitle')}</label>
    <select id="ui-lang" value={$locale} disabled={langBusy} on:change={pickLanguage}>{#each LOCALES as l (l.code)}<option value={l.code} lang={l.code}>{l.name}</option>{/each}</select>
    <small class="muted">{$t('account.language.settingsHint', { name: defaultName })}</small>
    {#if langErr}<span class="err" role="alert">{langErr}</span>{/if}</div>
  {#if admin}
    <div class="field"><label for="inst-lang">{$t('account.language.instanceSetting')}</label>
      <div class="flex"><select id="inst-lang" bind:value={instLang} disabled={instBusy}>{#each LOCALES as l (l.code)}<option value={l.code} lang={l.code}>{l.name}</option>{/each}</select>
        <button type="button" class="sec" disabled={instBusy} on:click={saveInstance}>{$t('common.save')}</button>{#if instMsg}<span role="status" class="muted">{instMsg}</span>{/if}</div>
      <small class="muted">{$t('account.language.instanceSettingHint')}</small></div>
  {/if}
</section>
<h1>{$t('account.settings.title')}</h1>
<p class="muted">{$t('account.settings.lead')}</p>
<form class="panel form" on:submit|preventDefault={save}>
  {@render check('autoplayNext', 'account.settings.autoplayNext', 'account.settings.autoplayNextHint')}
  {@render check('stillWatching', 'account.settings.stillWatching', 'account.settings.stillWatchingHint')}
  {#if form.stillWatching}<div class="field"><label for="swe">{$t('account.settings.stillWatchingEpisodes')}</label>
    <select id="swe" bind:value={form.stillWatchingEpisodes}>{#each [2, 3, 4, 5] as n}<option value={n}>{n}</option>{/each}</select></div>{/if}
  {@render check('spoilerProtection', 'account.settings.spoiler', 'account.settings.spoilerHint')}
  {@render check('autoSkipIntro', 'account.settings.skipIntro', 'account.settings.skipIntroHint')}
  {@render check('hoverTrailers', 'account.settings.hoverTrailers', 'account.settings.hoverTrailersHint')}
  {@render check('hoverClip', 'account.settings.hoverClip', 'account.settings.hoverClipHint')}
  {@render check('autoStartPreview', 'account.settings.autoStart', 'account.settings.autoStartHint')}
  {@render check('shareHistory', 'account.settings.shareHistory', 'account.settings.shareHistoryHint')}
  {@render check('shareRatings', 'account.settings.shareRatings', 'account.settings.shareRatingsHint')}
  {#if owner}
    {@render check('weeklyDigest', 'account.settings.digest', 'account.settings.digestHint')}
    <div class="field"><label for="nt">{$t('account.settings.ntfy')}</label>
      <input id="nt" bind:value={form.ntfyTopic} maxlength="64" pattern="[A-Za-z0-9_\-]*" autocomplete="off" spellcheck="false" placeholder={$t('account.settings.ntfyPlaceholder')} />
      <small class="muted">{$t('account.settings.ntfyHint')}</small></div>
  {/if}
  <div class="field"><label for="al">{$t('account.settings.audio')}</label>
    <select id="al" bind:value={form.audioLang}><option value="">{$t('account.settings.audioDefault')}</option>{#each LANGS as v}<option value={v}>{trackName(v)}</option>{/each}</select></div>
  <div class="field"><label for="sl">{$t('account.settings.subtitles')}</label>
    <select id="sl" bind:value={form.subtitleLang}><option value="">{$t('common.off')}</option>{#each LANGS as v}<option value={v}>{trackName(v)}</option>{/each}</select></div>
  <div class="field"><label for="q">{$t('account.settings.quality')}</label>
    <select id="q" bind:value={form.quality}>{#each QUALITIES as [v, l]}<option value={v}>{$t(l)}</option>{/each}</select>
    <small class="muted">{$t('account.settings.qualityHint')}</small></div>
  <fieldset class="field sub"><legend>{$t('account.settings.subStyle')}</legend>
    <div class="grid">
      <label>{$t('account.settings.subSize')}<select bind:value={form.subtitleStyle.size}>{#each Object.entries(SIZE_LABELS) as [v, l]}<option value={v}>{$t(l)}</option>{/each}</select></label>
      <label>{$t('account.settings.subColor')}<select bind:value={form.subtitleStyle.color}>{#each Object.entries(COLOR_LABELS) as [v, l]}<option value={v}>{$t(l)}</option>{/each}</select></label>
      <label>{$t('account.settings.subBackground')}<select bind:value={form.subtitleStyle.background}>{#each Object.entries(BG_LABELS) as [v, l]}<option value={v}>{$t(l)}</option>{/each}</select></label>
      <label>{$t('account.settings.subFont')}<select bind:value={form.subtitleStyle.font}>{#each Object.entries(FONT_LABELS) as [v, l]}<option value={v}>{$t(l)}</option>{/each}</select></label>
    </div>
    <div class="preview {subClasses(form.subtitleStyle)}" aria-label={$t('common.preview')}><span>{$t('account.settings.subPreview')}</span></div>
    <small class="muted">{$t('account.settings.subIosHint')}</small>
  </fieldset>
  <div class="flex"><button disabled={busy}>{$t('common.save')}</button>{#if saved}<span class="ok" role="status">{$t('common.saved')}</span>{/if}{#if error}<span class="err" role="alert">{error}</span>{/if}</div>
</form>
<section class="panel form push" aria-labelledby="introh">
  <h2 id="introh">{$t('account.settings.intro.title')}</h2>
  <label class="row"><input type="checkbox" bind:checked={introShow} on:change={saveIntro} /><span><b>{$t('account.settings.intro.show')}</b><small class="muted">{$t('account.settings.intro.showHint')}</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={introSound} on:change={saveIntro} /><span><b>{$t('account.settings.intro.sound')}</b><small class="muted">{$t('account.settings.intro.soundHint')}</small></span></label>
  <div class="flex"><button type="button" class="sec" on:click={previewIntro}>{$t('account.settings.intro.preview')}</button></div>
</section>
{#if previewing}<Intro sound={previewSound} on:done={() => (previewing = false)} />{/if}
<section class="panel form push" aria-labelledby="pushh">
  <h2 id="pushh">{$t('account.settings.push.title')}</h2>
  {#if ps === 'unsupported'}<p class="muted">{$t('account.settings.push.unsupported')}</p>
  {:else if ps === 'ios-install'}<p class="muted">{$t('account.settings.push.iosInstall')}</p>
  {:else if ps === 'server-off'}<p class="muted">{$t('account.settings.push.serverOff')}</p>
  {:else}
    {#if ps === 'denied'}<p class="muted" role="alert">{$t('account.settings.push.denied')}</p>{/if}
    <label class="row"><input type="checkbox" bind:checked={pushOn} disabled={pushBusy || ps === 'denied'} on:change={togglePush} /><span><b>{$t('account.settings.push.device')}</b><small class="muted">{$t('account.settings.push.deviceHint')}</small></span></label>
    {#if pushOn}
      <label class="row"><input type="checkbox" bind:checked={pushBroadcast} disabled={pushBusy} on:change={toggleBroadcast} /><span><b>{$t('account.settings.push.broadcast')}</b></span></label>
      <div class="flex"><button type="button" disabled={pushBusy} on:click={sendTest}>{$t('account.settings.push.test')}</button></div>
    {/if}
    {#if pushMsg}<span role="status" class="muted">{pushMsg}</span>{/if}
  {/if}
</section>

{#snippet check(k: BoolPref, label: TKey, hint: TKey)}
  <label class="row"><input type="checkbox" bind:checked={form[k]} /><span><b>{$t(label)}</b><small class="muted">{$t(hint)}</small></span></label>
{/snippet}
<style>
  .langsec { margin-bottom: 1.5rem; } .langsec h2 { margin: 0; font-size: 1.15rem; } .langsec .flex { align-items: center; }
  .push { margin-top: 1.5rem; } .push h2 { margin: 0; font-size: 1.15rem; }
  .form { max-width: 640px; display: grid; gap: 1.2rem; }
  .row { display: flex; gap: .9rem; align-items: flex-start; color: var(--fg); font-size: 1rem; } .row span { display: grid; gap: .1rem; }
  .field { display: grid; gap: .35rem; } .field select, .field input { max-width: 360px; }
  small { font-size: .82rem; }
  .sub { border: 0; padding: 0; margin: 0; } .sub legend { padding: 0; margin-bottom: .35rem; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .8rem; } .grid label { display: grid; gap: .3rem; font-size: .9rem; }
  .preview { background: linear-gradient(135deg, #3a4a5a, #1c232b); border-radius: 8px; padding: 2rem 1rem; text-align: center; color: #fff; }
  .preview span { padding: .1em .35em; }
  .preview.sub-size-s span { font-size: .9rem; } .preview.sub-size-m span { font-size: 1.15rem; } .preview.sub-size-l span { font-size: 1.5rem; } .preview.sub-size-xl span { font-size: 1.9rem; }
  .preview.sub-color-white span { color: #fff; } .preview.sub-color-yellow span { color: #ffe14d; } .preview.sub-color-cyan span { color: #4de8ff; } .preview.sub-color-green span { color: #6dff7a; }
  .preview.sub-bg-none span { background: transparent; } .preview.sub-bg-shadow span { background: transparent; text-shadow: 0 0 4px #000, 0 0 4px #000, 1px 1px 3px #000; }
  .preview.sub-bg-semi span { background: rgba(0,0,0,.65); } .preview.sub-bg-solid span { background: #000; }
  .preview.sub-font-sans span { font-family: system-ui, sans-serif; } .preview.sub-font-serif span { font-family: Georgia, 'Times New Roman', serif; } .preview.sub-font-mono span { font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
