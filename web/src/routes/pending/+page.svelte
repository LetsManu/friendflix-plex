<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Public waiting room after a login without an invite: no session, the signed ff_pending cookie names the request.
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import AuthShell from '#lib/auth/AuthShell.svelte';
  import Icon from '#lib/Icon.svelte';
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
<AuthShell center>
  <div class="body" aria-live="polite">
    {#if !s}
      <p class="muted" role="status">{$t('account.pending.checking')}</p>
    {:else if s.state === 'pending'}
      <div class="big" aria-hidden="true"><Icon name="clock" size={30} /></div>
      <h1>{$t('login.pending.title')}</h1>
      <p class="sub">{$t('login.pending.text')}</p>
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
  </div>
</AuthShell>

<style>
  .body { display: grid; gap: 4px; }
  .body p { margin: 0 0 8px; }
  .big { width: 62px; height: 62px; border-radius: 18px; background: rgba(255, 79, 109, .14); color: var(--acc); display: grid; place-items: center; margin: 0 auto 14px; }
  .small { font-size: .85rem; }
  .btn { width: 100%; border-radius: 10px; }
  blockquote { margin: .4rem 0 0; padding: .6rem .9rem; border-left: 3px solid var(--acc); background: rgba(255,255,255,.06); white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
</style>
