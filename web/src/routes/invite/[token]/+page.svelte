<script lang="ts">
  import { fmtDateTime, publicLocale, setLocale, t } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  type Info = { roleLabel: string; expiresAt: string; enrollUrl?: string; defaultLanguage?: string };
  let info: Info | null = null, invalid = false;
  const token = $page.params.token!;
  const get = (lang: string | null) => fetch(`/api/invite/${encodeURIComponent(token)}${lang ? `?lang=${lang}` : ''}`);
  onMount(async () => {
    // This page never calls /api/me: language = remembered → browser → instance default (from the answer). The language
    // is active (chunk loaded) before the account type is fetched, and ?lang names it in exactly that language.
    const pre = publicLocale();
    let lang: string | null = pre ? await setLocale(pre) : null;
    let r = await get(lang);
    if (!r.ok) { invalid = true; return; }
    let d = (await r.json()) as Info;
    if (!lang) {
      lang = await setLocale(d.defaultLanguage);
      if (lang !== (d.defaultLanguage ?? 'de')) { r = await get(lang); if (r.ok) d = await r.json(); } // chunk not loadable: stay consistent
    }
    info = d;
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.invite.pageTitle') })}</title></svelte:head>
<div class="auth">
  <a class="logo" href="/"><Logo wordmark size={40} /></a>
  <main class="card" id="main">
    {#if invalid}
      <h1>{$t('account.invite.invalidTitle')}</h1><p class="muted">{$t('account.invite.invalidText')}</p>
    {:else if info}
      <h1>{$t('account.invite.title')}</h1>
      <p>{$t('account.invite.accountType')} <b>{info.roleLabel}</b><br /><span class="muted">{$t('account.invite.validUntil', { when: fmtDateTime(info.expiresAt) })}</span></p>
      {#if info.enrollUrl}
        <p>{$t('account.invite.enrollText')}</p>
        <p><a class="btn" href={info.enrollUrl}>{$t('account.invite.enroll')}</a></p>
        <p class="muted small">{$t('account.invite.haveAccount')} <a href="/auth/login?invite={token}">{$t('account.invite.signIn')}</a></p>
      {:else}
        <p>{$t('account.invite.existingText')}</p>
        <p><a class="btn" href="/auth/login?invite={token}">{$t('account.invite.signIn')}</a></p>
      {/if}
      <p class="muted small">{$t('account.invite.twoFactor')}</p>
    {:else}<p class="muted" role="status">{$t('account.invite.checking')}</p>{/if}
  </main>
</div>

<style>
  .auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: calc(2rem + var(--safe-top)) max(1rem, var(--safe-right)) calc(2rem + var(--safe-bottom)) max(1rem, var(--safe-left)); background: linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.9)), radial-gradient(circle at 20% 10%, #5a0b14, #000 60%); }
  .logo { display: inline-flex; align-self: flex-start; }
  .card { background: rgba(0,0,0,.78); padding: 2.4rem clamp(1.4rem, 5vw, 4rem); border-radius: 8px; width: min(100%, 460px); margin: auto; }
  h1 { font-size: 2rem; } .small { font-size: .85rem; }
</style>
