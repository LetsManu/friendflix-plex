<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Check your inbox": the masked address. Two uses, one component (P25: never navigates, only emits events):
   * - `resend` (default; recovery and enrolment, screen 4): "Erneut senden (m:ss)" counts down from 60 s (the backend's resend gap) and
   *   then enables; "Zurück zur Anmeldung" emits `cancel` (the page gives the attempt up).
   * - `resend={false}` (after an e-mail change, ReauthDialog): "Bestätigungslink gesendet" and the note that the address changes only once
   *   the link is opened. No resend: the attempt is over on the server (the link works without a session); "Fertig" emits `done`.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, classicHref as defaultClassic, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'email-sent' }> & { errors?: FlowError[] };
  export let classicHref: string = defaultClassic();
  /** false after an e-mail change: no resend, no way back to the sign-in, a "done" button */
  export let resend = true;
  const GAP_S = 60;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string }; cancel: void }>();
  let left = GAP_S, busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heading: HTMLElement;
  onMount(() => { if (!resend) heading?.focus(); });

  function startCount() {
    left = GAP_S;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      left = Math.max(0, left - 1);
      if (left === 0 && timer) clearInterval(timer);
    }, 1000);
  }
  // a new mail (a new step id) restarts the countdown
  $: if (resend && step.step) startCount();
  onDestroy(() => timer && clearInterval(timer));
  $: time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  async function again() {
    if (busy || left > 0) return;
    busy = true;
    try {
      const r = await answer(step, {});
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      startCount();
    }
  }
</script>

<div class="af-form af-center" aria-busy={busy}>
  <div class="af-big" aria-hidden="true"><Icon name="mail" size={30} /></div>
  {#if resend}
    <h1>{$t('login.emailSent.title')}</h1>
    <p class="af-sub">{step.to ? $t('login.emailSent.text', { to: step.to }) : $t('login.emailSent.textNoAddress')}</p>
    <p class="af-hint">{$t('login.emailSent.hint')}</p>
    <Errors errors={step.errors ?? []} {classicHref} />
    <button class="af-sec" type="button" disabled={busy || left > 0} on:click={again} data-resend>
      {left > 0 ? $t('login.emailSent.resendIn', { time }) : $t('login.emailSent.resend')}
    </button>
    <button class="af-link" type="button" on:click={() => dispatch('cancel')}>{$t('login.emailSent.back')}</button>
  {:else}
    <h1 bind:this={heading} tabindex="-1">{$t('login.sec.emailSent.title')}</h1>
    <p class="af-sub">{step.to ? $t('login.sec.emailSent.text', { to: step.to }) : $t('login.sec.emailSent.textNoTo')}</p>
    <Errors errors={step.errors ?? []} {classicHref} />
    <button class="af-pri" type="button" on:click={() => dispatch('done', { next: '' })}>{$t('login.sec.done')}</button>
  {/if}
</div>
