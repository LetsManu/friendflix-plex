<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** /me/account (owner profile only): profile, security (2FA state), sessions & devices, your data (export), delete the account, and the privacy note. */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError, type Account } from '#lib/api';
  import DataCard from '#lib/account/DataCard.svelte';
  import { clearPending } from '#lib/admin/settings/form';
  import DeleteCard from '#lib/account/DeleteCard.svelte';
  import ProfileCard from '#lib/account/ProfileCard.svelte';
  import SecurityCard from '#lib/account/SecurityCard.svelte';
  import SessionsCard from '#lib/account/SessionsCard.svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  let account: Account | null = null, phase: 'loading' | 'ok' | 'owner' | 'error' = 'loading', reauthFailed = false;

  async function load() {
    phase = 'loading';
    try { account = await api<Account>('/api/account'); phase = 'ok'; }
    catch (e) { phase = e instanceof ApiError && e.status === 403 ? 'owner' : 'error'; }
  }
  /** re-reads the account without the loading state (the security section stays mounted) */
  async function refresh() {
    try { account = await api<Account>('/api/account'); } catch { /* the old state stays */ }
  }
  onMount(() => {
    // back from /auth/reauth signed in as somebody else; the flag is dropped from the address so a reload does not repeat it
    const u = new URL(location.href);
    if (u.searchParams.get('reauth') === 'failed') {
      reauthFailed = true;
      clearPending(); // an Admin → Settings change waiting for this sign-in is not repeated
      u.searchParams.delete('reauth');
      void goto(u.pathname + u.search + u.hash, { shallow: true, replace: true });
    }
    void load();
  });
  function saved(a: Account) {
    account = a;
    window.dispatchEvent(new Event('ff-me-changed')); // the shell re-reads /api/me (header name and avatar)
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.account.pageTitle') })}</title></svelte:head>
<div class="acct">
  <h1>{$t('account.account.title')}</h1>
  {#if reauthFailed}<p class="err banner" role="alert">{$t('account.account.reauthFailed')}</p>{/if}

  {#if phase === 'loading'}<div class="skeleton sk" aria-hidden="true"></div>
  {:else if phase === 'owner'}<p class="muted">{$t('account.account.ownerOnly')}</p>
  {:else if phase === 'error' || !account}
    <p class="err" role="alert">{$t('account.account.loadFailed')}</p>
    <button type="button" class="sec" on:click={load}>{$t('account.account.retry')}</button>
  {:else}
    <div class="grid">
      <ProfileCard {account} on:saved={(e) => saved(e.detail)} />
      <SecurityCard {account} on:changed={refresh} />
      <div class="wide"><SessionsCard /></div>
      <DataCard />
      <DeleteCard {account} />
    </div>
    <p class="muted privacy"><Icon name="shield" size={18} />{$t('account.account.privacy')}</p>
  {/if}
</div>

<style>
  .acct { max-width: 1000px; margin: 0 auto; }
  h1 { margin: .4rem 0 1rem; }
  .banner { padding: .7rem 1rem; border: 1px solid currentColor; border-radius: 8px; }
  .sk { height: 320px; border-radius: 8px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; align-items: start; }
  @media (min-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wide { grid-column: 1 / -1; } }
  .privacy { display: flex; gap: .6rem; align-items: flex-start; margin: 1.2rem 0 0; font-size: .9rem; }
  .privacy :global(svg) { margin-top: .1rem; }
</style>
