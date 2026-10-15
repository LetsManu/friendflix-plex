<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Screen 1, identification: e-mail or username (plus the password when the flow asks for it on the same stage), "Mit Passkey
   * anmelden" and "Noch kein Konto? Einladung einlösen".
   * Never navigates: it answers the step and emits `next` / `done`; `classic` (the sign-in page) and `invite` (a pasted invite token)
   * are for the page to act on.
   * Passkey: in-app when the step carries options (the RP ID is the app host), else the sign-in page. A cancelled or unmatched passkey
   * shows the sign-in page's passkey link: passkeys made on Authentik's own pages only work there (plan Ruling 1, trade-off).
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, inviteToken, passkeyGet, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'identify' }> & { errors?: FlowError[] };
  /** the sign-in page (keeps a portal invite) */
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string }; classic: void; invite: { token: string } }>();
  let identifier = '', password = '', busy = false;
  let passkeyHint: '' | 'cancelled' | 'unsupported' = '';
  let inviteOpen = false, inviteText = '', inviteBad = false;
  let first: HTMLInputElement, inviteInput: HTMLInputElement;

  onMount(() => first?.focus());

  function emit(r: FlowReply) {
    if (r.stage === 'done') dispatch('done', { next: r.next });
    else dispatch('next', r);
  }
  /** after an answer that stays on this stage (errors), the first field gets the focus again */
  async function refocus() {
    await tick();
    first?.focus();
  }

  async function submit() {
    const id = identifier.trim();
    if (busy || !id) return;
    busy = true;
    passkeyHint = '';
    try {
      emit(await answer(step, step.passwordInline && password ? { identifier: id, password } : { identifier: id }));
    } finally {
      busy = false;
      password = '';
    }
    void refocus();
  }

  async function withPasskey() {
    if (busy) return;
    if (!step.passkey) {
      dispatch('classic');
      return;
    }
    busy = true;
    passkeyHint = '';
    try {
      const passkey = await passkeyGet(step.passkey);
      emit(await answer(step, { passkey }));
    } catch (e) {
      passkeyHint = (e as Error | null)?.message === 'passkey_unsupported' ? 'unsupported' : 'cancelled';
    } finally {
      busy = false;
    }
  }

  async function toggleInvite() {
    inviteOpen = !inviteOpen;
    inviteBad = false;
    if (inviteOpen) {
      await tick();
      inviteInput?.focus();
    }
  }
  function redeem() {
    const token = inviteToken(inviteText);
    inviteBad = !token;
    if (token) dispatch('invite', { token });
  }
</script>

<form class="af-form" on:submit|preventDefault={submit} aria-busy={busy}>
  <h1>{$t('login.identify.title')}</h1>
  <p class="af-sub">{$t('login.identify.text')}</p>
  <div class="af-field">
    <label for="af-identifier">{$t('login.identify.identifier')}</label>
    <input id="af-identifier" name="username" type="text" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required maxlength="254" bind:value={identifier} bind:this={first} />
  </div>
  {#if step.passwordInline}
    <div class="af-field">
      <label for="af-inline-password">{$t('login.identify.password')}</label>
      <input id="af-inline-password" name="password" type="password" autocomplete="current-password" maxlength="1024" bind:value={password} />
    </div>
  {/if}
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy}>{$t('login.identify.next')}</button>
  <div class="af-or">{$t('login.identify.or')}</div>
  <button class="af-sec" type="button" disabled={busy} on:click={withPasskey}><Icon name="key" size={20} />{$t('login.identify.passkey')}</button>
  {#if passkeyHint}
    <p class="af-hint" role="status">
      {passkeyHint === 'unsupported' ? $t('login.passkey.unsupported') : $t('login.passkey.noMatch')}
      <a class="af-link" href={classicHref}>{$t('login.passkey.classic')}</a>
    </p>
  {/if}
  <button class="af-link" type="button" aria-expanded={inviteOpen} aria-controls="af-invite" on:click={toggleInvite}>{$t('login.identify.noAccount')}</button>
</form>
{#if inviteOpen}
  <form id="af-invite" class="af-form invite" on:submit|preventDefault={redeem}>
    <div class="af-field">
      <label for="af-invite-input">{$t('login.identify.inviteLabel')}</label>
      <input id="af-invite-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="512" bind:value={inviteText} bind:this={inviteInput} />
    </div>
    <Errors errors={[]} {classicHref} extra={inviteBad ? $t('login.identify.inviteBad') : ''} />
    <button class="af-sec" type="submit">{$t('login.identify.inviteGo')}</button>
  </form>
{/if}

<style>
  .invite { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
</style>
