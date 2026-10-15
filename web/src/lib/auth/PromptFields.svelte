<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * A flow prompt as a form: one input per field the flow asks for (invite sign-up, the new password of a reset, "Passwort ändern",
   * "E-Mail-Adresse ändern"). Labels go through `fieldLabel()` (FriendFlix's own `ff:` labels are localised; Authentik's text is shown as
   * plain text, never as markup). Password fields are cleared after every answer. Without a `title`, a password prompt (two password
   * fields) is "Passwort ändern", an e-mail prompt "E-Mail-Adresse ändern". Never navigates: emits `next` / `done`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, fieldLabel, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'prompt' }> & { errors?: FlowError[] };
  export let classicHref: string;
  /** the heading, the text under it and the button; the defaults are the account page's wording (ReauthDialog) */
  export let title = '';
  export let text = '';
  export let submitLabel = '';

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let values: Record<string, string> = {};
  let busy = false, show = false;
  let form: HTMLFormElement;
  const label = (l: string) => fieldLabel(l, (k: TKey) => $t(k));
  const auto = (type: string) => (type === 'password' ? 'new-password' : type === 'email' ? 'email' : type === 'username' ? 'username' : 'off');
  $: isPassword = step.fields.some((f) => f.type === 'password');
  $: isEmail = !isPassword && step.fields.some((f) => f.type === 'email');
  $: heading = title || (isPassword ? $t('login.sec.prompt.passwordTitle') : isEmail ? $t('login.sec.prompt.emailTitle') : $t('login.sec.prompt.title'));
  $: submitText = submitLabel || $t('login.sec.prompt.submit');

  onMount(() => form?.querySelector('input')?.focus());

  async function submit() {
    if (busy) return;
    busy = true;
    const fields = step.fields; // the reply replaces the step (and this screen): the clean-up below uses this copy
    try {
      const body: Record<string, string> = {};
      for (const f of fields) if ((values[f.key] ?? '') !== '') body[f.key] = values[f.key]!;
      const r = await answer(step, body);
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      for (const f of fields) if (f.type === 'password') values[f.key] = '';
      values = values;
    }
  }
</script>

<form class="af-form" bind:this={form} on:submit|preventDefault={submit} aria-busy={busy}>
  <h1>{heading}</h1>
  {#if text}<p class="af-sub">{text}</p>{/if}
  {#each step.fields as f, i (f.key)}
    <div class="af-field">
      <label for="af-f-{i}">{label(f.label)}</label>
      {#if f.type === 'password'}
        <div class="af-secret">
          <input id="af-f-{i}" name={f.key} type={show ? 'text' : 'password'} autocomplete="new-password" autocapitalize="none" spellcheck="false" maxlength="1024" required={f.required}
            disabled={busy} value={values[f.key] ?? ''} on:input={(e) => (values[f.key] = e.currentTarget.value)} />
          {#if i === step.fields.findIndex((x) => x.type === 'password')}
            <button class="icon-btn" type="button" aria-label={$t('login.password.show')} title={show ? $t('login.password.hide') : $t('login.password.show')} aria-pressed={show} on:click={() => (show = !show)}>
              <Icon name={show ? 'eye-off' : 'eye'} size={20} />
            </button>
          {/if}
        </div>
      {:else}
        <input id="af-f-{i}" name={f.key} type={f.type === 'email' ? 'email' : 'text'} autocomplete={auto(f.type)} autocapitalize="none" spellcheck="false" maxlength={f.type === 'email' ? 254 : 1024}
          required={f.required} disabled={busy} value={values[f.key] ?? ''} on:input={(e) => (values[f.key] = e.currentTarget.value)} />
      {/if}
    </div>
  {/each}
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy}>{submitText}</button>
</form>
