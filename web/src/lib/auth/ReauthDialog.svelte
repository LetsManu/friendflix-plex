<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The in-app re-authentication as a modal (account page): `start {kind:'reauth', then?}` and the flow's steps inline (password, second
   * factor, then the follow-up flow's own steps: authenticator app, recovery codes, passkey, new password, new e-mail). The step components
   * only emit events, so this dialog decides what happens: `done` (the flow finished: the parent reloads / retries its action) and `close`
   * (given up: the attempt is cancelled at the server, Authentik's session too). "Passkey verwenden" is phase 2's redirect re-auth.
   * A role=dialog with a name; Escape and the backdrop close it; Tab stays inside.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { startReauth } from '#lib/account/reauth';
  import Mfa from './Mfa.svelte';
  import Notice from './Notice.svelte';
  import PasskeySetup from './PasskeySetup.svelte';
  import Password from './Password.svelte';
  import PromptFields from './PromptFields.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';
  import EmailSent from './EmailSent.svelte';
  import TotpSetup from './TotpSetup.svelte';
  import { cancelFlow, classicHref, flowConfig, FlowRefused, startFlow, type FlowReply, type ThenKind } from './flow';
  import './auth.css';

  /** the follow-up flow; none = only a fresh sign-in (the parent then repeats its action) */
  export let then: ThenKind | undefined = undefined;

  const dispatch = createEventDispatcher<{ done: void; close: void }>();
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  const DONE_TEXT: Record<ThenKind, TKey> = {
    'setup-totp': 'login.sec.doneText.totp', 'setup-static': 'login.sec.doneText.static', 'setup-webauthn': 'login.sec.doneText.passkey',
    'change-password': 'login.sec.doneText.password', 'change-email': 'login.sec.doneText.email',
  };
  /** null while loading */
  let view: FlowReply | null = null;
  let finished = false;
  let classic = classicHref();
  let ended = false;
  let dlg: HTMLElement;

  onMount(() => { dlg?.focus(); void begin(); }); // the steps move the focus on to their first control

  async function begin() {
    view = null;
    try {
      await flowConfig();
      show(await startFlow('reauth', then ? { then } : {}));
    } catch (e) {
      if (e instanceof FlowRefused && e.code === 'passkey_classic') {
        classic = '/auth/flow/classic/webauthn-setup';
        view = { stage: 'classic', reason: 'passkey_origin' };
      } else view = { stage: 'unavailable' };
    }
  }
  function show(r: FlowReply) {
    if (r.stage !== 'done') view = r;
    else if (then) finished = true;
    else { ended = true; dispatch('done'); }
  }
  async function close() {
    const live = !ended && !finished && view !== null && 'step' in view;
    ended = true;
    if (live) await cancelFlow().catch(() => undefined);
    dispatch('close');
  }
  function finish() {
    ended = true;
    dispatch('done');
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions (Escape is handled by dialogKeys) -->
<div class="scrim" use:portal on:click={close}></div>
<div class="dlg" use:portal use:dialogKeys={{ close }} bind:this={dlg} tabindex="-1" role="dialog" aria-modal="true" aria-label={$t('login.sec.dialog')}>
  <button class="x icon-btn" type="button" aria-label={$t('login.sec.close')} on:click={close}><Icon name="x" size={20} /></button>
  {#if finished && then}
    <div class="af-form af-center">
      <div class="af-big" aria-hidden="true"><Icon name="check" size={30} /></div>
      <h1>{$t('login.sec.doneTitle')}</h1>
      <p class="af-sub">{$t(DONE_TEXT[then])}</p>
      <button class="af-pri" type="button" on:click={finish}>{$t('login.sec.done')}</button>
    </div>
  {:else if !view}
    <p class="loading muted" role="status">{$t('login.sec.loading')}</p>
  {:else if view.stage === 'password'}
    <Password step={view} classicHref={classic} canRestart={false} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
    <button class="af-link alt" type="button" on:click={() => startReauth('/me/account')}>{$t('login.sec.usePasskey')}</button>
  {:else if view.stage === 'mfa'}
    <Mfa step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'totp-setup'}
    <TotpSetup step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'recovery-codes'}
    <RecoveryCodes step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'prompt'}
    <PromptFields step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'passkey-setup'}
    <PasskeySetup step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'email-sent'}
    <EmailSent step={view} classicHref={classic} resend={false} on:done={finish} />
  {:else if view.stage === 'identify'}
    <Notice kind="classic" classicHref={classic} />
  {:else if view.stage === 'denied' || view.stage === 'locked' || view.stage === 'expired' || view.stage === 'unavailable' || view.stage === 'classic'}
    <Notice kind={view.stage} classicHref={classic} on:retry={begin} on:restart={begin} />
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, .7); }
  .dlg {
    position: fixed; z-index: 121; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(26rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem); overflow-y: auto; padding: 1.6rem 1.4rem 1.4rem; display: grid; gap: 12px;
    border: 1px solid #323a43; border-radius: 12px; background: #1b2127; color: var(--fg); box-shadow: var(--shadow-pop);
  }
  .x { position: absolute; top: .4rem; right: .4rem; color: var(--mut); }
  .loading { margin: 0; text-align: center; padding: 1rem 0; }
  .alt { justify-self: center; }
  .dlg:focus { outline: none; }
  @media (max-width: 600px) {
    .dlg { top: auto; bottom: 0; left: 0; right: 0; transform: none; width: auto; max-height: calc(100dvh - 1rem); border-radius: 14px 14px 0 0; padding-bottom: calc(1.4rem + var(--safe-bottom)); }
  }
</style>
