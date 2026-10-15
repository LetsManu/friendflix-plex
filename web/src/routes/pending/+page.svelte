<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Public waiting room after a login without an invite: no session, the signed ff_pending cookie names the request.
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';
  import { onMount } from 'svelte';
  type State = { state: 'pending' | 'approved' | 'rejected' | 'none'; message?: string };
  const POLL_MS = 30_000;
  let s: State | null = null;

  async function check() {
    try {
      const r = await fetch('/api/pending', { credentials: 'same-origin' });
      if (r.ok) s = (await r.json()) as State;
    } catch { /* offline: keep the last state, the next poll retries */ }
  }
  onMount(() => {
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    void check();
    // also while the state is unknown (first answer was a 5xx or the network was down): never stuck on "Checking"
    const timer = setInterval(() => { if (!s || s.state === 'pending') void check(); }, POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.pending.pageTitle') })}</title></svelte:head>
<div class="auth">
  <a class="logo" href="/"><Logo wordmark size={40} /></a>
  <main class="card" id="main" aria-live="polite">
    {#if !s}
      <p class="muted" role="status">{$t('account.pending.checking')}</p>
    {:else if s.state === 'pending'}
      <h1>{$t('account.pending.title')}</h1>
      <p>{$t('account.pending.sent')}</p>
      <p class="muted small">{$t('account.pending.autoUpdate')}</p>
    {:else if s.state === 'approved'}
      <h1>{$t('account.pending.approvedTitle')}</h1>
      <p>{$t('account.pending.approvedText')}</p>
      <p><a class="btn" href="/auth/login">{$t('account.pending.signIn')}</a></p>
    {:else if s.state === 'rejected'}
      <h1>{$t('account.pending.rejectedTitle')}</h1>
      <p>{$t('account.pending.rejectedText')}</p>
      {#if s.message}<p class="muted">{$t('account.pending.messageLabel')}</p><blockquote>{s.message}</blockquote>{/if}
    {:else}
      <h1>{$t('account.pending.noneTitle')}</h1>
      <p>{$t('account.pending.noneText')}</p>
      <p><a class="btn" href="/auth/login">{$t('account.pending.signIn')}</a></p>
    {/if}
  </main>
</div>

<style>
  .auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: calc(2rem + var(--safe-top)) max(1rem, var(--safe-right)) calc(2rem + var(--safe-bottom)) max(1rem, var(--safe-left)); background: linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.9)), radial-gradient(circle at 20% 10%, #5a0b14, #000 60%); }
  .logo { display: inline-flex; align-self: flex-start; }
  .card { background: rgba(0,0,0,.78); padding: 2.4rem clamp(1.4rem, 5vw, 4rem); border-radius: 8px; width: min(100%, 460px); margin: auto; }
  h1 { font-size: 2rem; } .small { font-size: .85rem; }
  blockquote { margin: .4rem 0 0; padding: .6rem .9rem; border-left: 3px solid var(--accent, #e50914); background: rgba(255,255,255,.06); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
