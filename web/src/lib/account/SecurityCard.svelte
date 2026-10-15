<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /me/account, security (Block 23 phase 3): password, authenticator app, passkeys, recovery codes and the e-mail address, all changed
   * inside FriendFlix. Adding or changing something always goes through the in-app re-authentication (ReauthDialog with the follow-up
   * flow); removing a device asks the backend first and opens the dialog on 401 `reauth_required`, then repeats the removal once.
   */
  import { onMount } from 'svelte';
  import { api, ApiError, type Account, type AccountSecurity, type Me } from '#lib/api';
  import { isReauthError } from './reauth';
  import EmailChange from './EmailChange.svelte';
  import ReauthDialog from '#lib/auth/ReauthDialog.svelte';
  import type { ThenKind } from '#lib/auth/flow';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import { errorText } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import { createEventDispatcher } from 'svelte';

  export let account: Account;

  type Device = AccountSecurity['devices'][number];
  const dispatch = createEventDispatcher<{ changed: void }>();
  let sec: AccountSecurity | null = null;
  let failed = false, isAdmin = false, err = '';
  let dialog: { then?: ThenKind; opener?: HTMLElement } | null = null;
  /** a removal waiting for the re-authentication */
  let retry: (() => Promise<void>) | null = null;

  $: totp = (sec?.devices ?? []).filter((d) => d.type === 'totp');
  $: keys = (sec?.devices ?? []).filter((d) => d.type === 'webauthn');
  $: codes = (sec?.devices ?? []).filter((d) => d.type === 'static');
  $: inApp = sec?.passkeySetup === 'in-app';

  async function load() {
    try { sec = await api<AccountSecurity>('/api/account/security'); failed = false; }
    catch { failed = true; }
  }
  onMount(() => {
    void load();
    api<Me>('/api/me').then((m) => { isAdmin = Boolean(m.isAdmin && m.profile?.isOwner); }).catch(() => undefined);
  });

  function open(then: ThenKind | undefined, e?: Event) {
    err = '';
    dialog = { then, opener: e?.currentTarget instanceof HTMLElement ? e.currentTarget : undefined };
  }
  async function closed(ok: boolean) {
    const d = dialog, again = retry;
    dialog = null; retry = null;
    d?.opener?.focus({ preventScroll: true });
    if (!ok) return;
    if (again) await again();
    else { await load(); dispatch('changed'); }
  }

  async function remove(d: Device) {
    const name = d.name || tr(`login.sec.type.${d.type}`);
    if (!(await confirm({ title: tr('login.sec.remove.confirm', { name }), body: tr('login.sec.remove.body'), danger: true, confirmLabel: tr('login.sec.remove.action') }))) return;
    await doRemove(d, name, true);
  }
  async function doRemove(d: Device, name: string, again: boolean) {
    err = '';
    try {
      await api(`/api/account/security/devices/${d.type}/${d.id}`, { method: 'DELETE' });
      toast.success(tr('login.sec.remove.done', { name }));
      await load();
      dispatch('changed');
    } catch (e) {
      if (isReauthError(e) && again) { retry = () => doRemove(d, name, false); dialog = {}; return; }
      err = e instanceof ApiError && (e.body as { error?: string } | null)?.error === 'last_factor' ? tr('login.sec.remove.lastFactor') : errorText(e);
    }
  }
</script>

<section class="panel card" aria-labelledby="acc-security">
  <h2 id="acc-security">{$t('account.account.security.title')}</h2>
  {#if err}<p class="err" role="alert">{err}</p>{/if}

  <div class="row">
    <div class="what"><h3 id="sec-pw">{$t('login.sec.password.title')}</h3><p class="muted note">{$t('login.sec.password.text')}</p></div>
    <div class="acts"><Button variant="secondary" size="sm" aria-describedby="sec-pw" on:click={(e) => open('change-password', e)}>{$t('login.sec.password.change')}</Button></div>
  </div>

  <div class="row">
    <div class="what">
      <h3 id="sec-totp">{$t('account.account.security.methods.totp')}</h3>
      {#if sec}
        <ul class="devs" aria-labelledby="sec-totp">
          {#each totp as d (d.id)}
            <li><span class="nm">{d.name || $t('login.sec.type.totp')}</span><Button variant="ghost" size="sm" aria-label={$t('login.sec.remove.for', { name: d.name || $t('login.sec.type.totp') })} on:click={() => remove(d)}>{$t('login.sec.remove.action')}</Button></li>
          {:else}<li class="muted">{$t('login.sec.none')}</li>{/each}
        </ul>
      {/if}
    </div>
    <div class="acts"><Button variant="secondary" size="sm" aria-describedby="sec-totp" on:click={(e) => open('setup-totp', e)}>{$t('login.sec.totp.add')}</Button></div>
  </div>

  <div class="row">
    <div class="what">
      <h3 id="sec-keys">{$t('account.account.security.methods.webauthn')}</h3>
      {#if sec}
        <ul class="devs" aria-labelledby="sec-keys">
          {#each keys as d (d.id)}
            <li><span class="nm">{d.name || $t('login.sec.type.webauthn')}</span><Button variant="ghost" size="sm" aria-label={$t('login.sec.remove.for', { name: d.name || $t('login.sec.type.webauthn') })} on:click={() => remove(d)}>{$t('login.sec.remove.action')}</Button></li>
          {:else}<li class="muted">{$t('login.sec.none')}</li>{/each}
        </ul>
      {/if}
      <p class="muted note">{$t('login.sec.passkey.note')}</p>
    </div>
    {#if sec}
      <div class="acts">
        {#if inApp}
          <Button variant="secondary" size="sm" aria-describedby="sec-keys" on:click={(e) => open('setup-webauthn', e)}>{$t('login.sec.passkey.add')}</Button>
        {:else}
          <a class="btn ui-btn sec sm" href="/auth/flow/classic/webauthn-setup" aria-describedby="sec-keys">{$t('login.sec.passkey.addClassic')}</a>
        {/if}
      </div>
    {/if}
  </div>

  <div class="row">
    <div class="what">
      <h3 id="sec-codes">{$t('account.account.security.methods.static')}</h3>
      <p class="muted note">{sec && codes.length ? $t('login.sec.codes.have') : $t('login.sec.codes.none')}</p>
    </div>
    <div class="acts"><Button variant="secondary" size="sm" aria-describedby="sec-codes" on:click={(e) => open('setup-static', e)}>{codes.length ? $t('login.sec.codes.regenerate') : $t('login.sec.codes.create')}</Button></div>
  </div>

  <EmailChange email={account.email} pending={sec?.emailChangePending ?? account.emailChangePending ?? null} available={sec?.emailChange ?? false} {isAdmin} on:change={() => open('change-email')} />

  {#if failed}<p class="muted note" role="status"><Icon name="info" size={16} /> {$t('account.account.security.notAvailableHint')}</p>{/if}
  {#if account.manageUrl}
    <a class="ext" href={account.manageUrl} target="_blank" rel="noopener noreferrer">{$t('account.account.security.manage')}<span class="sr-only"> {$t('account.account.security.newTab')}</span><Icon name="link" size={16} /></a>
  {/if}
</section>

{#if dialog}
  <ReauthDialog then={dialog.then} on:done={() => closed(true)} on:close={() => closed(false)} />
{/if}

<style>
  .card { display: flex; flex-direction: column; gap: 1.1rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  h3 { font-size: 1rem; margin: 0 0 .3rem; }
  .row { display: flex; align-items: flex-start; justify-content: space-between; gap: .8rem; flex-wrap: wrap; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .what { min-width: 0; flex: 1 1 14rem; }
  .note { margin: .2rem 0 0; font-size: .88rem; }
  .devs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
  .devs li { display: flex; align-items: center; justify-content: space-between; gap: .6rem; min-height: 36px; padding: .2rem .2rem .2rem .8rem; background: var(--surface-2); border-radius: 8px; }
  .devs li.muted { background: none; padding-left: 0; }
  .nm { min-width: 0; overflow-wrap: anywhere; }
  .ext { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; color: #54b9c5; font-weight: 600; align-self: flex-start; }
  .ext:hover { text-decoration: underline; }
  @media (max-width: 600px) {
    .row { flex-direction: column; align-items: stretch; }
    .acts :global(.ui-btn), .acts :global(.btn) { width: 100%; }
  }
</style>
