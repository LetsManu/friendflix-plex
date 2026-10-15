<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /reset?token= (Block 23 phase 3): the link of the recovery e-mail. A public page (no /api/me).
   * - On load the token moves into this component's state only and `replaceState` drops it from the URL (`history.replaceState`); `flowConfig()` sets
   *   the csrf cookie (preflight P14). Authentik is not called yet (Ruling 11).
   * - "Erneut versuchen" after `unavailable` keeps the token (Authentik never used it): a failed config loads it again, a failed
   *   resume sends the same token again.
   * - "Weiter" calls `resume` (the only place the token is sent, in the request body), then: MFA (TOTP) when the flow has it (P19), the
   *   two password fields, and "Passwort geändert" with a link to /login.
   * - A passkey-only account comes back as `classic/passkey_origin`: "add a TOTP app, or ask an admin".
   * - Under LOGIN_UI other than app nothing is forwarded anywhere: the classic notice only.
   */
  import { onDestroy, onMount } from 'svelte';
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import AuthShell from '#lib/auth/AuthShell.svelte';
  import Icon from '#lib/Icon.svelte';
  import Mfa from '#lib/auth/Mfa.svelte';
  import Notice from '#lib/auth/Notice.svelte';
  import PromptFields from '#lib/auth/PromptFields.svelte';
  import { classicHref, flowConfig, resumeFlow, type FlowReply } from '#lib/auth/flow';
  import '../../lib/auth/auth.css';

  const classic = classicHref();
  let token = '';
  /** 'intro' = the "Weiter" screen; null = loading */
  let view: FlowReply | { stage: 'intro' } | { stage: 'finished' } | null = null;
  let busy = false;
  /** the config answered: a retry then resends the token instead of loading the config again */
  let ready = false;

  onMount(() => {
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    const q = new URLSearchParams(location.search);
    const given = q.get('token') ?? '';
    token = given.length <= 512 ? given : '';
    // the token never stays in the address bar or the history entry. Not SvelteKit's replaceState: it keeps the old URL (with the
    // token) in history.state (`sveltekit:metadata.pageUrl`)
    if (q.has('token')) history.replaceState(history.state, '', location.pathname);
    void boot();
  });
  async function boot() {
    view = null;
    let mode: 'app' | 'authentik';
    try {
      mode = (await flowConfig()).mode;
    } catch {
      view = { stage: 'unavailable' }; // the token stays for the retry
      return;
    }
    ready = true;
    if (mode !== 'app') {
      token = ''; // nothing is forwarded: the sign-in page is Authentik's own
      view = { stage: 'classic', reason: 'unsupported_stage' };
      return;
    }
    view = token ? { stage: 'intro' } : { stage: 'expired' };
  }
  onDestroy(() => (token = ''));

  async function go() {
    if (busy || !token) return;
    busy = true;
    const t0 = token;
    token = ''; // single use
    try {
      const r = await resumeFlow(t0);
      if (r.stage === 'unavailable') token = t0; // Authentik did not take it: the retry sends the same link again
      show(r);
    } finally {
      busy = false;
    }
  }
  function retry() {
    if (!ready) void boot();
    else if (token) void go();
    else location.href = '/login';
  }
  function show(r: FlowReply) {
    view = r.stage === 'done' ? { stage: 'finished' } : r;
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('login.reset.newTitle') })}</title></svelte:head>
<AuthShell>
  {#if !view}
    <p class="loading muted" role="status">{$t('login.loading')}</p>
  {:else if view.stage === 'intro'}
    <div class="af-form" aria-busy={busy}>
      <h1>{$t('login.reset.startTitle')}</h1>
      <p class="af-sub">{$t('login.reset.startText')}</p>
      <button class="af-pri" type="button" disabled={busy} on:click={go}>{$t('login.reset.startButton')}</button>
    </div>
  {:else if view.stage === 'prompt'}
    <PromptFields step={view} classicHref={classic} title={$t('login.reset.newTitle')} text={$t('login.reset.newText')} submitLabel={$t('login.reset.submit')} on:next={(e) => show(e.detail)} on:done={() => (view = { stage: 'finished' })} />
  {:else if view.stage === 'mfa'}
    <Mfa step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => (view = { stage: 'finished' })} />
  {:else if view.stage === 'finished'}
    <div class="af-form af-center" data-reset-done>
      <div class="af-big" aria-hidden="true"><Icon name="check" size={30} /></div>
      <h1>{$t('login.reset.doneTitle')}</h1>
      <p class="af-sub">{$t('login.reset.doneText')}</p>
      <a class="btn af-pri" href="/login">{$t('login.reset.doneButton')}</a>
    </div>
  {:else if view.stage === 'classic' && view.reason === 'passkey_origin'}
    <div class="af-form af-center" data-passkey-only>
      <div class="af-big" aria-hidden="true"><Icon name="key" size={30} /></div>
      <h1>{$t('login.reset.passkeyTitle')}</h1>
      <p class="af-sub">{$t('login.reset.passkeyText')}</p>
      <a class="btn af-pri" href="/login">{$t('login.reset.doneButton')}</a>
    </div>
  {:else if view.stage === 'denied' || view.stage === 'locked' || view.stage === 'expired' || view.stage === 'unavailable' || view.stage === 'classic'}
    <Notice kind={view.stage} classicHref={classic} on:retry={retry} on:restart={() => (location.href = '/login')} />
  {:else}
    <Notice kind="classic" classicHref={classic} />
  {/if}
</AuthShell>

<style>
  .loading { margin: 0; text-align: center; padding: 1rem 0; }
</style>
