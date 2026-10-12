<svelte:head><title>{$t('common.pageTitle', { page: $t('account.profiles.pageTitle') })}</title></svelte:head>
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { AVATARS, avatarBg, initial } from '#lib/avatars';
  import Icon from '#lib/Icon.svelte';
  import PinPad from '#lib/PinPad.svelte';
  import { setMeta } from '#lib/offline/db';
  import Intro from '#lib/Intro.svelte';
  import { stopSonicLogo } from '#lib/sonic';
  import Logo from '#lib/Logo.svelte';
  import { markPicked } from '#lib/gate';
  import { loadIntroSettings, markSessionSeen, shouldPlayIntro, shouldPlayIntroSound } from '#lib/intro';
  import { cachedCalm } from '#lib/stores';
  import { t, tr, type TKey } from '#lib/i18n';
  import { confirm } from '#lib/ui/confirm';
  const colorKey = (key: string) => `account.profiles.colors.${key}` as TKey;

  /** unlock 'owner': leaving the active kids profile towards this profile needs the owner profile's PIN (it has none of its own) */
  interface Profile { id: string; name: string; avatar: string; isOwner: boolean; hasPin: boolean; active: boolean; kids?: boolean; maxRating?: number; unlock?: 'owner' }
  let profiles: Profile[] = [], max = 5, activeId: string | null = null, loaded = false;
  let manage = false, loadErr = '';
  /** kids profile this session is locked to (switching away needs a PIN); account has a kids profile but no owner PIN */
  let kidsLock: string | null = null, kidsUnguarded = false;
  /** /auth/login?resetPin=1 was refused: 'kids' = this device is locked to a kids profile, 'stale' = the IdP did not ask for the login again */
  let resetNote: 'kids' | 'stale' | null = null;
  let pinFor: Profile | null = null, pinErr = '', pinBusy = false, pinOwner = false;
  const KIDS_RATINGS = [0, 6, 12] as const;
  const ratingKey = (n: number) => `kids.profiles.rating${n}` as TKey;
  // editor: null = closed, {} without id = new profile
  let ed: { id?: string; name: string; avatar: string; hasPin: boolean; isOwner: boolean; pin: string; currentPin: string; removePin: boolean; kids: boolean; maxRating: number } | null = null;
  let edErr = '', edBusy = false;

  $: ownerActive = profiles.some((p) => p.active && p.isOwner);
  $: canCreate = ownerActive && profiles.length < max;
  $: owner = profiles.find((p) => p.isOwner);
  const canEdit = (p: Profile) => ownerActive || p.active;

  async function load() {
    try {
      const r = await api('/api/profiles');
      profiles = r.profiles; max = r.max ?? 5; activeId = r.activeId ?? null; kidsLock = r.kidsLock ?? null; kidsUnguarded = Boolean(r.kidsUnguarded);
      // a session without a chosen profile has no "active" owner: the owner (when unlocked) manages, otherwise nothing to manage
      loadErr = '';
    } catch { loadErr = tr('account.profiles.loadFailed'); } finally { loaded = true; }
  }
  onMount(async () => {
    const sp = new URLSearchParams(location.search);
    if (sp.get('manage') === '1') manage = true;
    const pr = sp.get('pinReset');
    if (pr === 'kids' || pr === 'stale') resetNote = pr;
    await load();
    // avatar menu "switch to …": pick that profile right away (asks for the PIN when it has one)
    const pick = sp.get('pick'), p = pick ? profiles.find((x) => x.id === pick) : undefined;
    if (p && !manage) void choose(p);
  });

  function target() {
    const next = new URLSearchParams(location.search).get('next');
    return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
  }
  function done() { location.href = target(); }

  // ---- brand intro: the profile click is a user gesture, so the sonic logo may play ----
  let intro: { sound: boolean } | null = null, introDone: (() => void) | null = null;
  async function playIntro(profileId: string) {
    const s = loadIntroSettings(profileId);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches || cachedCalm(profileId); // calm mode: the calm fade
    const route = target().split(/[?#]/)[0];
    markSessionSeen(); // the page reloads into the app next: no second (silent) intro on top of this one
    if (!shouldPlayIntro({ setting: s.show, reducedMotion, route, sessionSeen: false, tv: document.documentElement.classList.contains('tv') })) return;
    intro = { sound: shouldPlayIntroSound({ sound: s.sound, soundExplicit: s.soundExplicit, reducedMotion }) };
    await new Promise<void>((r) => (introDone = r));
    await stopSonicLogo(200); // the page reload would cut the chord's tail with a click
  }

  async function choose(p: Profile, pin?: string) {
    if (manage) return openEdit(p);
    // leaving a kids profile: the target's own PIN, else the owner profile's (the server enforces both)
    if (pin === undefined && (p.hasPin || p.unlock === 'owner')) { pinFor = p; pinOwner = !p.hasPin; pinErr = ''; return; }
    pinBusy = true; pinErr = '';
    try {
      await api(`/api/profiles/${p.id}/select`, { method: 'POST', body: pin === undefined ? {} : { pin } });
      await setMeta('lastProfileId', p.id).catch(() => undefined); // offline hub: downloads of the last active profile
      markPicked(p.id); // "Wer schaut gerade?" was answered for this browser session
      await playIntro(p.id).catch(() => undefined);
      done();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : '';
      pinOwner = e instanceof ApiError && e.body?.pinOf === 'owner';
      if (code === 'pin_required') { pinFor = p; pinErr = ''; }
      else if (code === 'pin_wrong') { pinFor = p; pinErr = tr('account.profiles.pinWrong'); }
      else if (code === 'pin_locked') { pinFor = p; pinErr = tr('account.profiles.pinLocked'); }
      else { pinFor = p; pinErr = tr('account.profiles.selectFailed'); }
    } finally { pinBusy = false; }
  }

  function openEdit(p?: Profile) {
    edErr = '';
    ed = p
      ? { id: p.id, name: p.name, avatar: p.avatar, hasPin: p.hasPin, isOwner: p.isOwner, pin: '', currentPin: '', removePin: false, kids: Boolean(p.kids), maxRating: p.maxRating ?? 12 }
      : { name: '', avatar: AVATARS[profiles.length % AVATARS.length][0], hasPin: false, isOwner: false, pin: '', currentPin: '', removePin: false, kids: false, maxRating: 12 };
  }
  const bad = (pin: string) => pin !== '' && !/^\d{4}$/.test(pin);

  async function save() {
    if (!ed) return;
    const name = ed.name.trim();
    if (!name || name.length > 20) { edErr = tr('account.profiles.nameLength'); return; }
    if (bad(ed.pin) || bad(ed.currentPin)) { edErr = tr('account.profiles.pinFormat'); return; }
    edBusy = true; edErr = '';
    try {
      let id = ed.id;
      if (!id) {
        const r = await api('/api/profiles', { method: 'POST', body: { name, avatar: ed.avatar, ...(ed.pin ? { pin: ed.pin } : {}), ...(ed.kids ? { kids: true, maxRating: ed.maxRating } : {}) } });
        id = r?.id ?? r?.profile?.id;
      } else {
        const cur = profiles.find((p) => p.id === id);
        if (cur && (cur.name !== name || cur.avatar !== ed.avatar)) await api(`/api/profiles/${id}`, { method: 'PATCH', body: { name, avatar: ed.avatar } });
        // kids mode / cap: owner profile only (the server checks it too)
        if (cur && ownerActive && !cur.isOwner && (Boolean(cur.kids) !== ed.kids || (ed.kids && (cur.maxRating ?? 12) !== ed.maxRating))) {
          await api(`/api/profiles/${id}`, { method: 'PATCH', body: { kids: ed.kids, ...(ed.kids ? { maxRating: ed.maxRating } : {}) } });
        }
        if (ed.pin || ed.removePin) {
          await api(`/api/profiles/${id}/pin`, { method: 'PUT', body: { pin: ed.removePin ? null : ed.pin, ...(ed.currentPin ? { currentPin: ed.currentPin } : {}) } });
        }
      }
      ed = null; await load();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : '';
      edErr = code === 'max_profiles' ? tr('account.profiles.maxProfiles', { n: max })
        : code === 'jellyfin' ? tr('account.profiles.jellyfinCreate')
        : e instanceof ApiError && e.status === 409 ? tr('account.profiles.nameTaken')
        : code === 'pin_wrong' || (e instanceof ApiError && e.status === 403) ? tr('account.profiles.currentPinWrong')
        : code === 'pin_locked' ? tr('account.profiles.pinLockedLater')
        : tr('account.profiles.saveFailed');
    } finally { edBusy = false; }
  }
  async function remove() {
    if (!ed?.id || !(await confirm({ title: tr('account.profiles.confirmDelete', { name: ed.name }), danger: true, confirmLabel: tr('account.profiles.delete') }))) return;
    edBusy = true; edErr = '';
    try { await api(`/api/profiles/${ed.id}`, { method: 'DELETE' }); ed = null; await load(); }
    catch (e) { edErr = e instanceof ApiError && e.body?.error === 'jellyfin' ? tr('account.profiles.jellyfinDelete') : tr('account.profiles.deleteFailed'); }
    finally { edBusy = false; }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && ed && !pinFor) { e.preventDefault(); e.stopPropagation(); ed = null; }
  }
</script>

<svelte:window on:keydown|capture={onKey} />

<span class="brand" aria-hidden="true"><Logo wordmark size={30} /></span>
<div class="wrap" inert={!!pinFor || !!ed}>
  <h1>{manage ? $t('account.profiles.manage') : $t('account.profiles.who')}</h1>
  {#if resetNote}<p class="err" role="alert">{resetNote === 'kids' ? $t('kids.profiles.resetBlocked') : $t('kids.profiles.resetStale')}</p>{/if}
  {#if loadErr}<p class="err" role="alert">{loadErr} <button class="sec" on:click={load}>{$t('common.retry')}</button></p>{/if}
  {#if !loaded}
    <div class="grid2"><div class="skeleton sk"></div><div class="skeleton sk"></div></div>
  {:else}
    <div class="grid2" data-nav>
      {#each profiles as p (p.id)}
        {@const label = p.kids ? $t('kids.profiles.ariaKids', { name: p.name }) : p.name}
        <button class="prof" class:cur={p.id === activeId} class:kid={p.kids} data-autofocus={p === profiles[0] ? '' : undefined} aria-label={p.hasPin ? (manage ? $t('account.profiles.ariaPinEdit', { name: label }) : $t('account.profiles.ariaPin', { name: label })) : manage ? $t('account.profiles.ariaEdit', { name: label }) : label} disabled={pinBusy} on:click={() => choose(p)}>
          <span class="face" style="background:{avatarBg(p.avatar)}">{initial(p.name)}
            {#if p.kids}<span class="kb" aria-hidden="true">{$t('kids.badge')}</span>{/if}
            {#if p.hasPin || p.unlock === 'owner'}<span class="lock"><Icon name="lock" size={18} /></span>{/if}
            {#if manage && canEdit(p)}<span class="edit">{$t('account.profiles.edit')}</span>{/if}
          </span>
          <span class="nm">{p.name}</span>
        </button>
      {/each}
      {#if canCreate}
        <button class="prof addp" aria-label={$t('account.profiles.add')} on:click={() => openEdit()}>
          <span class="face add"><Icon name="plus" size={52} /></span><span class="nm">{$t('account.profiles.add')}</span>
        </button>
      {/if}
    </div>
    {#if manage && !ownerActive}<p class="muted">{$t('account.profiles.ownerOnly')}</p>{/if}
    {#if ownerActive && kidsUnguarded && owner}
      <p class="khint" role="note">{$t('kids.profiles.unguarded')} <button type="button" class="sec" on:click={() => { manage = true; owner && openEdit(owner); }}>{$t('kids.profiles.setPin')}</button></p>
    {/if}
    <p><button class={manage ? 'light done' : 'outline'} on:click={() => (manage = !manage)}>{manage ? $t('account.profiles.done') : $t('account.profiles.manage')}</button></p>
  {/if}
</div>

{#if intro}<Intro sound={intro.sound} on:done={() => introDone?.()} />{/if}

{#if pinFor}
  <div class="ov" role="dialog" aria-modal="true" aria-label={$t('account.profiles.pinFor', { name: pinFor.name })}>
    <div class="box">
      <span class="face sm" style="background:{avatarBg(pinFor.avatar)}">{initial(pinFor.name)}</span>
      <PinPad title={pinOwner ? $t('kids.profiles.ownerPinTitle', { name: owner?.name ?? '' }) : $t('account.profiles.pinFor', { name: pinFor.name })} hint={pinOwner ? $t('kids.profiles.ownerPinHint') : ''} error={pinErr} busy={pinBusy} on:submit={(e) => pinFor && choose(pinFor, e.detail)} on:cancel={() => (pinFor = null)} />
      <!-- never offered while leaving a kids profile (the server refuses the reset on a kid-locked device anyway) -->
      {#if pinFor.isOwner && !pinOwner && !kidsLock}<button type="button" class="sec forgot" on:click={() => (location.href = '/auth/login?resetPin=1')}>{$t('account.profiles.forgotPin')}</button>{/if}
    </div>
  </div>
{/if}

{#if ed}
  <div class="ov" role="dialog" aria-modal="true" aria-label={ed.id ? $t('account.profiles.editTitle') : $t('account.profiles.add')}>
    <form class="box ed" on:submit|preventDefault={save}>
      <h2>{ed.id ? $t('account.profiles.editTitle') : $t('account.profiles.add')}</h2>
      <span class="face sm" style="background:{avatarBg(ed.avatar)}">{initial(ed.name)}</span>
      <label>{$t('account.profiles.name')}<input bind:value={ed.name} maxlength="20" autocomplete="off" data-autofocus required /></label>
      <fieldset data-nav>
        <legend>{$t('account.profiles.color')}</legend>
        <div class="cols">
          {#each AVATARS as [key, , css]}
            <button type="button" class="sw" class:sel={ed.avatar === key} style="background:{css}" aria-label={$t(colorKey(key))} aria-pressed={ed.avatar === key} on:click={() => ed && (ed.avatar = key)}>{#if ed.avatar === key}<Icon name="check" size={20} />{/if}</button>
          {/each}
        </div>
      </fieldset>
      {#if ownerActive && !ed.isOwner}
        <fieldset class="kidsf">
          <label class="chk"><input type="checkbox" bind:checked={ed.kids} /> <b>{$t('kids.profiles.toggle')}</b></label>
          <p class="muted small">{$t('kids.profiles.toggleHint')}</p>
          {#if ed.kids}
            <label>{$t('kids.profiles.rating')}
              <select bind:value={ed.maxRating}>{#each KIDS_RATINGS as n (n)}<option value={n}>{$t(ratingKey(n))}</option>{/each}</select>
            </label>
          {/if}
        </fieldset>
      {/if}
      <fieldset>
        <legend>{$t('account.profiles.pinOptional')}</legend>
        {#if ed.hasPin}
          <label>{$t('account.profiles.currentPin')}<input bind:value={ed.currentPin} inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" /></label>
          <label class="chk"><input type="checkbox" bind:checked={ed.removePin} /> {$t('account.profiles.removePin')}</label>
        {/if}
        {#if !ed.removePin}<label>{ed.hasPin ? $t('account.profiles.newPin') : $t('account.profiles.pin')}<input bind:value={ed.pin} inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" /></label>{/if}
      </fieldset>
      {#if edErr}<p class="err" role="alert">{edErr}</p>{/if}
      <div class="flex">
        <button type="submit" disabled={edBusy}>{edBusy ? $t('common.saving') : $t('common.save')}</button>
        <button type="button" class="sec" on:click={() => (ed = null)}>{$t('common.cancel')}</button>
        <span class="sp"></span>
        {#if ed.id && ownerActive && !ed.isOwner}<button type="button" class="sec" disabled={edBusy} on:click={remove}>{$t('account.profiles.delete')}</button>{/if}
      </div>
    </form>
  </div>
{/if}

<style>
  .brand { position: absolute; top: 1.2rem; left: var(--pad-x); display: inline-flex; z-index: 1; }
  .outline { background: transparent; color: var(--mut); border: 1px solid var(--mut); border-radius: 0; padding: .55rem 1.6rem; font-weight: 500; letter-spacing: .14em; text-transform: uppercase; font-size: .95rem; }
  .outline:hover:not(:disabled), .outline:focus-visible { background: transparent; color: #fff; border-color: #fff; }
  .done { border-radius: 0; padding: .55rem 1.8rem; letter-spacing: .1em; text-transform: uppercase; }
  .face.add { border: 2px solid transparent; }
  .prof:hover .face.add, .prof:focus-visible .face.add { background: #3a3a3a; color: #fff; }
  .wrap { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2rem var(--pad-x); gap: 1rem; }
  h1 { font-size: clamp(1.8rem, 4vw, 3rem); font-weight: 500; margin: 0 0 1rem; }
  .grid2 { display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: clamp(.8rem, 2.5vw, 2rem); }
  .prof { flex-direction: column; justify-content: flex-start; background: transparent; color: var(--mut); width: clamp(96px, 20vw, 160px); padding: .4rem; gap: .6rem; height: auto; font-weight: 400; }
  .prof:hover:not(:disabled), .prof:focus-visible { background: transparent; color: #fff; }
  .prof:hover .face, .prof:focus-visible .face { box-shadow: 0 0 0 4px #fff; }
  .prof.cur .nm { color: #fff; }
  .nm { font-size: 1.05rem; overflow-wrap: break-word; hyphens: auto; max-width: 100%; }
  .prof.addp .nm { font-size: .92rem; }
  .face { position: relative; width: 100%; aspect-ratio: 1; border-radius: 8px; display: grid; place-items: center; font-size: clamp(2.2rem, 6vw, 4rem); font-weight: 800; color: #fff; transition: box-shadow var(--t-fast); }
  .face.sm { width: 72px; font-size: 2rem; margin: 0 auto .5rem; }
  .face.add { background: var(--surface-2); color: var(--mut); }
  .lock { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.65); border-radius: 99px; width: 28px; height: 28px; display: grid; place-items: center; }
  .edit { position: absolute; inset: 0; border-radius: 8px; background: rgba(0,0,0,.55); display: grid; place-items: center; font-size: .95rem; font-weight: 600; }
  .sk { width: 140px; height: 140px; }
  .ov { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.88); display: grid; place-items: center; padding: 1rem; overflow-y: auto; }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 1.6rem; display: flex; flex-direction: column; align-items: center; max-width: 100%; }
  .ed { width: min(440px, 100%); align-items: stretch; gap: .8rem; text-align: left; }
  .ed h2 { margin: 0; text-align: center; }
  .ed label { display: flex; flex-direction: column; gap: .25rem; }
  .ed label.chk { flex-direction: row; align-items: center; gap: .5rem; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .5rem; }
  legend { color: var(--mut); font-size: .9rem; padding: 0; margin-bottom: .3rem; }
  .cols { display: flex; flex-wrap: wrap; gap: .5rem; }
  .sw { width: 44px; padding: 0; border-radius: 8px; box-shadow: 0 0 0 1px rgba(255,255,255,.15); }
  .sw.sel { box-shadow: 0 0 0 3px #fff; }
  .sw:hover:not(:disabled) { filter: brightness(1.15); }
  .sp { flex: 1; }
  .kb { position: absolute; left: 6px; top: 6px; padding: .1rem .55rem; border-radius: 99px; background: linear-gradient(135deg, #ff5d8f, #ffb703); color: #fff; font-size: .78rem; font-weight: 900; letter-spacing: .04em; }
  .prof.kid .face { border-radius: 50%; }
  .khint { max-width: 560px; color: #e5e5e5; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .8rem 1rem; display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; justify-content: center; }
  .kidsf { gap: .35rem; border: 1px solid var(--line); border-radius: 8px; padding: .7rem .8rem; }
  .small { font-size: .85rem; margin: 0; }
</style>
