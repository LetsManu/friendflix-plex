<svelte:head><title>{$t('common.pageTitle', { page: $t('kids.welcome.pageTitle') })}</title></svelte:head>
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError, img, type Item, type Me } from '#lib/api';
  import { AVATARS, avatarBg, initial } from '#lib/avatars';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import { safeNext } from '#lib/gate';
  import { t, tr, type TKey } from '#lib/i18n';
  const colorKey = (key: string) => `account.profiles.colors.${key}` as TKey;

  /**
   * Onboarding of a new profile (shown once, after the profile and language gates): 1 name + colour, 2 three titles you like
   * (stored as thumbs = "Gefällt mir", which feed "Weil du … geschaut hast" and "Mehr wie das"; kids: also Jellyfin favourites
   * for their "Lieblinge" row), 3 done. Finishing or skipping stores `onboarded` (PUT /api/prefs/onboarded).
   */
  const MIN_PICKS = 3;
  let me: Me | null = null, step = 1, err = '', busy = false;
  let name = '', avatar = 'red';
  let titles: Item[] | null = null, picked = new Set<string>(), loadErr = false;
  let main: HTMLElement;
  $: kids = Boolean(me?.kids || me?.profile?.kids);
  $: total = 3;

  onMount(async () => {
    try {
      me = await api<Me>('/api/me');
      name = me.profile?.name ?? '';
      avatar = me.profile?.avatar ?? 'red';
    } catch { /* api() redirects on 401 */ }
  });

  async function focusStep() { await tick(); main?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }); }

  async function saveProfile() {
    if (!me?.profile) return;
    const n = name.trim();
    if (!n || n.length > 20) { err = tr('account.profiles.nameLength'); return; }
    busy = true; err = '';
    try {
      if (n !== me.profile.name || avatar !== me.profile.avatar) {
        await api(`/api/profiles/${me.profile.id}`, { method: 'PATCH', body: kids ? { avatar } : { name: n, avatar } });
        me = { ...me, profile: { ...me.profile, name: kids ? me.profile.name : n, avatar } };
      }
      step = 2; void loadTitles(); void focusStep();
    } catch (e) {
      err = e instanceof ApiError && e.status === 409 ? tr('kids.welcome.nameTaken') : tr('kids.welcome.saveFailed');
    } finally { busy = false; }
  }

  async function loadTitles() {
    if (titles) return;
    loadErr = false;
    try {
      // the best rated titles of the library this profile can see (a kids profile only gets what its cap allows)
      titles = (await api<{ items: Item[] }>('/api/library/items?types=Movie,Series&sort=CommunityRating&desc=true&limit=24')).items ?? [];
    } catch { loadErr = true; }
  }
  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    picked = next;
  }

  async function savePicks() {
    if (picked.size < MIN_PICKS) { err = tr('kids.welcome.pickMore'); return; }
    busy = true; err = '';
    try {
      await Promise.all([...picked].map(async (id) => {
        await api(`/api/items/${id}/thumb`, { method: 'PUT', body: { value: 1 } });
        if (kids) await api(`/api/items/${id}/favorite`, { method: 'POST' });
      }));
      step = 3; void focusStep();
    } catch { err = tr('kids.welcome.saveFailed'); } finally { busy = false; }
  }
  function skip() { err = ''; step = 3; void focusStep(); }

  async function finish() {
    busy = true; err = '';
    try {
      await api('/api/prefs/onboarded', { method: 'PUT', body: { onboarded: true } });
      window.dispatchEvent(new Event('ff-onboarded')); // the layout stops sending this profile here
      await goto(safeNext(new URLSearchParams(location.search).get('next'), kids ? '/kids' : '/'), { replace: true });
    } catch { err = tr('kids.welcome.saveFailed'); busy = false; }
  }
</script>

<div class="wel" class:kids bind:this={main}>
  <span class="brand" aria-hidden="true"><Logo wordmark size={30} /></span>
  {#if me}
    <p class="step">{$t('kids.welcome.step', { n: step, total })}</p>
    <div class="dots" aria-hidden="true">{#each [1, 2, 3] as s (s)}<i class:on={s <= step}></i>{/each}</div>

    {#if step === 1}
      <section class="card" aria-labelledby="w1">
        <span class="face" style="background:{avatarBg(avatar)}">{initial(kids ? me.profile?.name : name)}</span>
        <h1 id="w1">{$t('kids.welcome.hi', { name: me.profile?.name ?? me.name })}</h1>
        <p class="lead">{kids ? $t('kids.welcome.kidsIntro') : $t('kids.welcome.profileIntro')}</p>
        <form on:submit|preventDefault={saveProfile}>
          {#if !kids}<label class="nm">{$t('kids.welcome.name')}<input bind:value={name} maxlength="20" autocomplete="off" required data-autofocus /></label>{/if}
          <fieldset data-nav>
            <legend>{$t('kids.welcome.color')}</legend>
            <div class="cols">
              {#each AVATARS as [key, , css], i (key)}
                <button type="button" class="sw" class:sel={avatar === key} style="background:{css}" aria-label={$t(colorKey(key))} aria-pressed={avatar === key} data-autofocus={kids && i === 0 ? '' : undefined} on:click={() => (avatar = key)}>{#if avatar === key}<Icon name="check" size={22} />{/if}</button>
              {/each}
            </div>
          </fieldset>
          {#if err}<p class="err" role="alert">{err}</p>{/if}
          <div class="acts"><button type="submit" class="go" disabled={busy}>{$t('kids.welcome.next')}</button></div>
        </form>
      </section>
    {:else if step === 2}
      <section class="card wide" aria-labelledby="w2">
        <h1 id="w2">{kids ? $t('kids.welcome.kidsPickTitle') : $t('kids.welcome.pickTitle')}</h1>
        <p class="lead">{kids ? $t('kids.welcome.kidsPickIntro') : $t('kids.welcome.pickIntro')}</p>
        {#if loadErr}<p class="err" role="alert">{$t('kids.welcome.loadFailed')}</p>
        {:else if !titles}<div class="grid">{#each Array(12) as _, i (i)}<span class="skel"></span>{/each}</div>
        {:else}
          <div class="grid" data-nav>
            {#each titles as it, i (it.id)}
              <button type="button" class="pick" class:on={picked.has(it.id)} aria-pressed={picked.has(it.id)} aria-label={picked.has(it.id) ? $t('kids.welcome.selected', { name: it.name }) : it.name} data-autofocus={i === 0 ? '' : undefined} on:click={() => toggle(it.id)}>
                {#if it.image}<img src={img(it.id, 240)} alt="" loading="lazy" decoding="async" width="160" height="240" />{:else}<span class="noimg">{it.name}</span>{/if}
                {#if picked.has(it.id)}<span class="tick" aria-hidden="true"><Icon name="check" size={22} /></span>{/if}
              </button>
            {/each}
          </div>
        {/if}
        <p class="count" aria-live="polite">{$t('kids.welcome.picked', { n: picked.size })}</p>
        {#if err}<p class="err" role="alert">{err}</p>{/if}
        <div class="acts">
          <button type="button" class="go" disabled={busy || picked.size < MIN_PICKS} on:click={savePicks}>{$t('kids.welcome.next')}</button>
          <button type="button" class="sec" disabled={busy} on:click={skip}>{$t('kids.welcome.skip')}</button>
        </div>
      </section>
    {:else}
      <section class="card" aria-labelledby="w3">
        <span class="face" style="background:{avatarBg(avatar)}">{initial(me.profile?.name)}</span>
        <h1 id="w3">{$t('kids.welcome.doneTitle')}</h1>
        <p class="lead">{kids ? $t('kids.welcome.kidsDoneText') : $t('kids.welcome.doneText')}</p>
        {#if err}<p class="err" role="alert">{err}</p>{/if}
        <div class="acts"><button type="button" class="go" disabled={busy} data-autofocus on:click={finish}>{$t('kids.welcome.start')}</button></div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .wel { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: calc(5rem + var(--safe-top)) max(var(--pad-x), var(--safe-right)) calc(3rem + var(--safe-bottom)) max(var(--pad-x), var(--safe-left)); text-align: center; }
  .brand { position: absolute; top: calc(1.2rem + var(--safe-top)); left: max(var(--pad-x), var(--safe-left)); display: inline-flex; }
  .step { margin: 0; color: var(--mut); font-size: .9rem; letter-spacing: .06em; text-transform: uppercase; }
  .dots { display: flex; gap: .4rem; margin: .5rem 0 1.4rem; }
  .dots i { width: 28px; height: 4px; border-radius: 99px; background: #3b444e; transition: background var(--t-med); }
  .dots i.on { background: var(--acc); }
  .card { width: min(520px, 100%); display: flex; flex-direction: column; align-items: center; gap: .7rem; animation: rise .35s var(--ease); }
  .card.wide { width: min(1040px, 100%); }
  h1 { margin: .2rem 0 0; font-size: clamp(1.6rem, 4vw, 2.4rem); }
  .lead { margin: 0 0 .6rem; color: #cfcfcf; font-size: 1.05rem; }
  .face { width: 96px; height: 96px; border-radius: 10px; display: grid; place-items: center; font-size: 2.6rem; font-weight: 800; }
  form { width: 100%; display: flex; flex-direction: column; gap: 1rem; text-align: left; }
  .nm { display: flex; flex-direction: column; gap: .3rem; }
  fieldset { border: 0; padding: 0; margin: 0; }
  legend { color: var(--mut); font-size: .9rem; margin-bottom: .4rem; padding: 0; }
  .cols { display: flex; flex-wrap: wrap; gap: .6rem; }
  .sw { width: 48px; min-height: 48px; padding: 0; border-radius: 10px; box-shadow: 0 0 0 1px rgba(255, 255, 255, .15); }
  .sw.sel { box-shadow: 0 0 0 3px #fff; }
  .acts { display: flex; gap: .8rem; justify-content: center; flex-wrap: wrap; margin-top: .6rem; }
  .go { min-width: 12rem; min-height: 52px; font-size: 1.1rem; }
  .grid { width: 100%; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(140px, 28vw), 1fr)); gap: .8rem; }
  .pick { position: relative; padding: 0; height: auto; aspect-ratio: 2 / 3; border-radius: 8px; overflow: hidden; background: var(--surface-2); box-shadow: 0 0 0 0 transparent; transition: box-shadow var(--t-fast), transform var(--t-fast); }
  .pick img, .pick .noimg { width: 100%; height: 100%; object-fit: cover; display: grid; place-items: center; padding: 0; font-size: .9rem; }
  .pick .noimg { padding: .5rem; }
  .pick:hover:not(:disabled), .pick:focus-visible { background: var(--surface-2); box-shadow: 0 0 0 3px #fff; }
  .pick.on { box-shadow: 0 0 0 4px var(--acc); }
  .pick.on img { opacity: .55; }
  .tick { position: absolute; inset: auto .45rem .45rem auto; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--acc-fill); color: #fff; }
  .skel { aspect-ratio: 2 / 3; border-radius: 8px; background: var(--surface-2); }
  .count { margin: .4rem 0 0; color: var(--mut); }
  /* kids: brighter, rounder, bigger */
  .wel.kids { background: linear-gradient(180deg, #bfe9ff 0%, #e8f7ff 60%, #fffaf0 100%); color: #20233a; }
  .wel.kids .lead, .wel.kids .step, .wel.kids .count, .wel.kids legend { color: #3c4a8f; }
  .wel.kids .face, .wel.kids .sw, .wel.kids .pick { border-radius: 24px; }
  .wel.kids .sw { width: 64px; min-height: 64px; }
  .wel.kids .sw.sel, .wel.kids .pick:focus-visible { box-shadow: 0 0 0 5px #ffb703; }
  .wel.kids .pick.on { box-shadow: 0 0 0 5px #ff5d8f; }
  .wel.kids .tick { background: #ff5d8f; }
  .wel.kids .go { border-radius: 99px; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } .pick, .dots i { transition: none; } }
</style>
