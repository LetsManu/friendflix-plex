<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /me/account, delete the account: a dialog that offers the export first, explains the 7 days (restore by signing in
   * again), that it signs out every device at once and that the sign-in account is deactivated only when the deletion is
   * final. Deleting needs a recent sign-in: the button always asks the backend
   * first (the last admin is refused before any sign-in); a 401 reauth_required goes through /auth/reauth and comes back as
   * `?delete=1`, which opens the dialog again. On success the session is gone: the dialog
   * shows the date, then the page leaves for `/`. The last admin is refused (400 last_admin).
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { dialogKeys } from '#lib/actions';
  import { api, ApiError, type Account } from '#lib/api';
  import { fmtDate, t, tr } from '#lib/i18n';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { EXPORT_URL } from './DataCard.svelte';
  import { isReauthError, startReauth } from './reauth';

  export let account: Account;

  /** where the forced sign-in returns to (`#` is outside the backend's `next` charset, F6) */
  const NEXT = '/me/account?delete=1';
  let open = false, busy = false, err = '', doneAt: string | null = null;
  let opener: HTMLElement | undefined, cancelBtn: HTMLButtonElement | undefined, okBtn: HTMLButtonElement | undefined;
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  /** only for the hint: the backend decides (401 reauth_required) */
  $: needsReauth = !account.reauthUntil || account.reauthUntil <= Date.now();

  async function show() {
    open = true; err = ''; doneAt = null;
    await tick();
    cancelBtn?.focus(); // a destructive dialog starts on Cancel
  }
  function close() {
    if (doneAt) return leave(); // the session is gone: nothing to come back to
    if (busy) return;
    open = false;
    opener?.focus({ preventScroll: true });
  }
  function leave() { location.href = '/'; }

  onMount(() => {
    // back from the forced sign-in: open the dialog again, drop the flag so a reload does not repeat it
    const u = new URL(location.href);
    if (u.searchParams.get('delete') !== '1') return;
    u.searchParams.delete('delete');
    void goto(u.pathname + u.search + u.hash, { shallow: true, replace: true });
    void show();
  });

  async function remove() {
    if (busy) return;
    busy = true; err = '';
    try {
      doneAt = (await api<{ deletionAt: string }>('/api/account/delete', { method: 'POST', body: { confirm: true } })).deletionAt;
      busy = false;
      await tick();
      okBtn?.focus();
    } catch (e) {
      busy = false;
      if (isReauthError(e)) return startReauth(NEXT); // no recent sign-in (or the window ran out meanwhile)
      err = e instanceof ApiError && (e.body as { error?: string } | null)?.error === 'last_admin' ? tr('account.account.delete.lastAdmin') : errorText(e);
    }
  }
</script>

<section class="panel card" aria-labelledby="acc-delete">
  <h2 id="acc-delete">{$t('account.account.delete.title')}</h2>
  <p class="muted text">{$t('account.account.delete.text')}</p>
  <div class="acts"><button type="button" class="danger" bind:this={opener} on:click={show}>{$t('account.account.delete.open')}</button></div>
</section>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions (Escape is handled by dialogKeys) -->
  <div class="scrim" use:portal on:click={close}></div>
  <div class="dlg" use:portal use:dialogKeys={{ close }} role="dialog" aria-modal="true" aria-labelledby="del-h" aria-describedby="del-d" aria-busy={busy ? 'true' : undefined}>
    {#if doneAt}
      <h2 id="del-h">{$t('account.account.delete.doneTitle')}</h2>
      <div id="del-d">
        <p class="done">{$t('account.account.delete.done', { date: fmtDate(doneAt) })}</p>
        <p class="muted">{$t('account.account.delete.doneHint')}</p>
      </div>
      <div class="acts end"><button type="button" aria-describedby="del-d" bind:this={okBtn} on:click={leave}>{$t('account.account.delete.ok')}</button></div>
    {:else}
      <h2 id="del-h">{$t('account.account.delete.dialogTitle')}</h2>
      <p class="muted">{$t('account.account.delete.exportHint')}</p>
      <div class="exp"><Button variant="secondary" icon="download" href={EXPORT_URL} download="">{$t('account.account.data.download')}</Button></div>
      <div id="del-d">
        <p>{$t('account.account.delete.grace')}</p>
        <p>{$t('account.account.delete.signIn')}</p>
      </div>
      {#if needsReauth}<p class="muted">{$t('account.account.delete.reauthHint')}</p>{/if}
      {#if err}<p class="err" role="alert">{err}</p>{/if}
      <div class="acts end">
        <button type="button" class="sec" bind:this={cancelBtn} on:click={close}>{$t('account.account.delete.cancel')}</button>
        <Button variant="danger" solid pending={busy} on:click={remove}>{$t('account.account.delete.confirm')}</Button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .card { display: flex; flex-direction: column; gap: 1rem; margin: 0; min-width: 0; }
  .card h2 { font-size: 1.15rem; margin: 0; }
  .text { margin: 0; font-size: .9rem; }
  .acts { display: flex; flex-wrap: wrap; gap: .6rem; }
  .acts.end { justify-content: flex-end; margin-top: .4rem; }
  .scrim { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, .7); }
  .dlg {
    position: fixed; z-index: 121; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem); overflow-y: auto; display: flex; flex-direction: column; gap: .8rem; padding: 1.4rem;
    border: 1px solid #323a43; border-radius: 12px; background: #1b2127; color: var(--fg); box-shadow: var(--shadow-pop);
  }
  .dlg h2 { margin: 0; font-size: 1.2rem; }
  .dlg p { margin: 0; overflow-wrap: anywhere; }
  #del-d { display: flex; flex-direction: column; gap: .6rem; }
  .done { font-weight: 700; }
  .exp { display: flex; }
  @media (max-width: 600px) {
    .acts > :global(button) { width: 100%; }
    .dlg { top: auto; bottom: 0; left: 0; right: 0; transform: none; width: auto; max-height: calc(100dvh - 1rem); border-radius: 14px 14px 0 0; padding-bottom: calc(1.4rem + var(--safe-bottom)); }
    .exp :global(.btn) { width: 100%; }
    .acts.end { flex-direction: column-reverse; }
    .acts.end > :global(*) { width: 100%; }
  }
</style>
