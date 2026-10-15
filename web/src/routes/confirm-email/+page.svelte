<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /confirm-email?token= (Block 23 phase 3): the link in the mail Authentik sends to a new e-mail address. A public page: it works
   * without a FriendFlix session and never asks /api/me. The token goes into memory and out of the address bar at once; nothing is sent
   * until the button is pressed (a mail scanner or link preview that only opens the page confirms nothing). The click continues the
   * e-mail change's flow (`resume {token, kind:'email-confirm'}`): `done` → "E-Mail-Adresse geändert", `expired` → used or expired link.
   */
  import { onMount } from 'svelte';
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import AuthShell from '#lib/auth/AuthShell.svelte';
  import Icon from '#lib/Icon.svelte';
  import { flowConfig, resumeFlow } from '#lib/auth/flow';

  /** what Authentik's FlowToken key looks like; anything else cannot be a link from the mail */
  const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
  let token = '';
  let view: 'ready' | 'busy' | 'done' | 'expired' | 'unavailable' = 'ready';
  let heading: HTMLElement;

  onMount(() => {
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    const q = new URLSearchParams(location.search);
    const given = q.get('token') ?? '';
    token = TOKEN.test(given) ? given : '';
    // the address after a confirmation (`done.next`), e.g. when the page is reloaded
    if (q.get('ok') === '1' && !token) view = 'done';
    else if (!token) view = 'expired';
    // the token does not stay in the address bar or the history entry. Not SvelteKit's replaceState: it keeps the old URL (with the
    // token) in history.state (`sveltekit:metadata.pageUrl`)
    if (q.has('token')) history.replaceState(history.state, '', location.pathname);
    void flowConfig().catch(() => undefined); // sets the csrf cookie; no executor call
  });

  async function confirmAddress() {
    if (view === 'busy' || !token) return;
    view = 'busy';
    const t0 = token;
    const r = await resumeFlow(t0, 'email-confirm');
    token = '';
    view = r.stage === 'done' ? 'done' : r.stage === 'unavailable' ? 'unavailable' : 'expired';
    if (view === 'unavailable') token = t0; // retry with the same link
  }
  $: if (view && heading) heading.focus();
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('login.confirm.pageTitle') })}</title></svelte:head>
<AuthShell>
  <div class="af-form af-center" aria-busy={view === 'busy'}>
    {#if view === 'done'}
      <div class="af-big" aria-hidden="true"><Icon name="check" size={30} /></div>
      <h1 bind:this={heading} tabindex="-1">{$t('login.confirm.doneTitle')}</h1>
      <p class="af-sub">{$t('login.confirm.doneText')}</p>
      <a class="btn af-pri" href="/me/account">{$t('login.confirm.toAccount')}</a>
    {:else if view === 'expired'}
      <div class="af-big" aria-hidden="true"><Icon name="clock" size={30} /></div>
      <h1 bind:this={heading} tabindex="-1">{$t('login.confirm.expiredTitle')}</h1>
      <p class="af-sub">{$t('login.confirm.expiredText')}</p>
      <a class="btn af-pri" href="/me/account">{$t('login.confirm.toAccount')}</a>
    {:else}
      <div class="af-big" aria-hidden="true"><Icon name="mail" size={30} /></div>
      <h1>{$t('login.confirm.title')}</h1>
      <p class="af-sub">{$t('login.confirm.text')}</p>
      {#if view === 'unavailable'}<p class="af-hint" role="alert">{$t('login.confirm.unavailable')}</p>{/if}
      <button class="af-pri" type="button" disabled={view === 'busy'} on:click={confirmAddress}>{$t('login.confirm.button')}</button>
    {/if}
  </div>
</AuthShell>
