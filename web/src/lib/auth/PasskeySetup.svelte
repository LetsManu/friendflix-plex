<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Adds a passkey on this page: explains it, runs the browser's ceremony (passkeyCreate, only for the options of an in-app step, whose
   * RP ID is the app host) and answers `{ response }`. Never navigates: emits `next` / `done`; a refusal by the browser shows a hint.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, passkeyCreate, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'passkey-setup' }> & { errors?: FlowError[] };
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let busy = false, hint: '' | 'cancelled' | 'unsupported' = '';
  let heading: HTMLElement;
  onMount(() => heading?.focus());

  async function create() {
    if (busy) return;
    busy = true;
    hint = '';
    let response;
    try {
      response = await passkeyCreate(step.options);
    } catch (e) {
      hint = (e as Error | null)?.message === 'passkey_unsupported' ? 'unsupported' : 'cancelled';
      busy = false;
      return;
    }
    try {
      const r = await answer(step, { response });
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
    }
  }
</script>

<div class="af-form af-center" aria-busy={busy}>
  <div class="af-big" aria-hidden="true"><Icon name="key" size={30} /></div>
  <h1 bind:this={heading} tabindex="-1">{$t('login.sec.passkey.title')}</h1>
  <p class="af-sub">{$t('login.sec.passkey.text')}</p>
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="button" disabled={busy} on:click={create}><Icon name="key" size={20} />{$t('login.sec.passkey.create')}</button>
  {#if hint}<p class="af-hint" role="status">{hint === 'unsupported' ? $t('login.sec.passkey.unsupported') : $t('login.sec.passkey.cancelled')}</p>{/if}
</div>
