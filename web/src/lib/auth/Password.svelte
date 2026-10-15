<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Screen 2, password: the identity pill (the name the person typed, "ändern" starts over), the password with a show toggle,
   * "Anmelden", and "Passwort vergessen?" when the instance has a recovery flow.
   * Never navigates: emits `next` / `done`, `restart` ("ändern") and `forgot` (with the typed name) for the page (or a dialog) to act on.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'password' }> & { errors?: FlowError[] };
  export let classicHref: string;
  /** the instance has a recovery flow (`GET /auth/flow/config`) */
  export let recovery = false;
  /** "ändern" (no new identity in a re-authentication dialog) */
  export let canRestart = true;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string }; restart: void; forgot: { identifier: string } }>();
  let password = '', show = false, busy = false;
  let input: HTMLInputElement;
  $: initial = (step.identity.trim()[0] ?? '?').toUpperCase();

  onMount(() => input?.focus());

  async function submit() {
    if (busy || !password) return;
    busy = true;
    try {
      const r = await answer(step, { password });
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      password = '';
    }
    await tick();
    input?.focus();
  }
</script>

<form class="af-form" on:submit|preventDefault={submit} aria-busy={busy}>
  {#if step.identity}
    <div class="af-pill">
      <span class="av" aria-hidden="true">{initial}</span>
      <span class="who">{step.identity}</span>
      {#if canRestart}<button class="af-link" type="button" aria-label={$t('login.password.changeLabel')} on:click={() => dispatch('restart')}>{$t('login.password.change')}</button>{/if}
    </div>
    <input type="text" name="username" autocomplete="username" value={step.identity} readonly hidden />
  {/if}
  <h1>{$t('login.password.title')}</h1>
  <p class="af-sub">{$t('login.password.text')}</p>
  <div class="af-field">
    <label for="af-password">{$t('login.password.label')}</label>
    <div class="af-secret">
      <input id="af-password" name="password" type={show ? 'text' : 'password'} autocomplete="current-password" autocapitalize="none" spellcheck="false" required maxlength="1024"
        value={password} on:input={(e) => (password = e.currentTarget.value)} bind:this={input} />
      <button class="icon-btn" type="button" aria-label={$t('login.password.show')} title={show ? $t('login.password.hide') : $t('login.password.show')} aria-pressed={show} aria-controls="af-password" on:click={() => (show = !show)}>
        <Icon name={show ? 'eye-off' : 'eye'} size={20} />
      </button>
    </div>
  </div>
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy}>{$t('login.password.submit')}</button>
  {#if recovery}
    <button class="af-link" type="button" disabled={busy} on:click={() => dispatch('forgot', { identifier: step.identity })}>{$t('login.password.forgot')}</button>
  {/if}
</form>
