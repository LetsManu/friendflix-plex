<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Public page after a sign-in during the deletion grace period: no session, the signed ff_restore cookie names the account.
  // Restoring creates no session either: the person signs in again (the IdP session is still alive, so no extra prompt).
  import { fmtDate, publicLocale, setLocale, t } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';
  import { onMount } from 'svelte';
  type State = { state: 'scheduled'; deletionAt: string } | { state: 'none' } | { state: 'done'; accessEnded: boolean } | { state: 'gone' }
    | { state: 'kept'; deletionAt: string };
  let s: State | null = null;
  let busy = false;
  let failed = false;

  async function check() {
    try {
      const r = await fetch('/api/restore', { credentials: 'same-origin' });
      if (r.ok) s = (await r.json()) as State;
      else failed = true;
    } catch { failed = true; }
  }
  async function restore() {
    busy = true;
    failed = false;
    try {
      // JSON only: the server refuses anything a cross-site form could send
      const r = await fetch('/api/restore', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = (await r.json().catch(() => ({}))) as { accessEnded?: boolean; error?: string };
      if (r.ok) s = { state: 'done', accessEnded: Boolean(body.accessEnded) };
      else if (r.status === 401 || body.error === 'not_scheduled') s = { state: 'none' }; // the 15 minutes ran out, or restored meanwhile
      else if (body.error === 'deletion_in_progress') s = { state: 'gone' };
      else failed = true;
    } catch { failed = true; }
    busy = false;
  }
  /**
   * "Keep the deletion" stays on this page: without a session `/` would go to the login, and the still valid IdP session would
   * bring the person straight back here. The cookie is dropped (best effort; it also runs out after 15 minutes).
   */
  function keep(deletionAt: string) {
    s = { state: 'kept', deletionAt };
    failed = false;
    void fetch('/api/restore', { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
  }
  onMount(() => {
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    void check();
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.restore.pageTitle') })}</title></svelte:head>
<div class="auth">
  <a class="logo" href="/"><Logo wordmark size={40} /></a>
  <main class="card" id="main" aria-live="polite">
    {#if !s}
      {#if failed}
        <p class="err" role="alert">{$t('account.restore.failed')}</p>
        <p><button class="sec" on:click={() => { failed = false; void check(); }}>{$t('account.restore.retry')}</button></p>
      {:else}
        <p class="muted" role="status">{$t('account.restore.checking')}</p>
      {/if}
    {:else if s.state === 'scheduled'}
      <h1>{$t('account.restore.title')}</h1>
      <p>{$t('account.restore.text', { date: fmtDate(s.deletionAt) })}</p>
      {#if failed}<p class="err" role="alert">{$t('account.restore.failed')}</p>{/if}
      <div class="flex actions">
        <button disabled={busy} on:click={restore}>{busy ? $t('account.restore.restoring') : $t('account.restore.restore')}</button>
        <button class="sec" disabled={busy} on:click={() => s?.state === 'scheduled' && keep(s.deletionAt)}>{$t('account.restore.keep')}</button>
      </div>
    {:else if s.state === 'done'}
      <h1>{$t('account.restore.doneTitle')}</h1>
      {#if s.accessEnded}
        <p>{$t('account.restore.expiredText')}</p>
      {:else}
        <p>{$t('account.restore.doneText')}</p>
        <p><a class="btn" href="/auth/login">{$t('account.restore.signIn')}</a></p>
      {/if}
    {:else if s.state === 'kept'}
      <h1>{$t('account.restore.keptTitle')}</h1>
      <p>{$t('account.restore.keptText', { date: fmtDate(s.deletionAt) })}</p>
    {:else if s.state === 'gone'}
      <h1>{$t('account.restore.goneTitle')}</h1>
      <p>{$t('account.restore.goneText')}</p>
    {:else}
      <h1>{$t('account.restore.noneTitle')}</h1>
      <p>{$t('account.restore.noneText')}</p>
      <p><a class="btn" href="/auth/login">{$t('account.restore.signIn')}</a></p>
    {/if}
  </main>
</div>

<style>
  .auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: calc(2rem + var(--safe-top)) max(1rem, var(--safe-right)) calc(2rem + var(--safe-bottom)) max(1rem, var(--safe-left)); background: linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.9)), radial-gradient(circle at 20% 10%, #5a0b14, #000 60%); }
  .logo { display: inline-flex; align-self: flex-start; }
  .card { background: rgba(0,0,0,.78); padding: 2.4rem clamp(1.4rem, 5vw, 4rem); border-radius: 8px; width: min(100%, 460px); margin: auto; }
  h1 { font-size: 2rem; }
  .actions { margin-top: 1.4rem; }
  @media (max-width: 480px) { .actions > * { flex: 1 1 100%; } }
</style>
