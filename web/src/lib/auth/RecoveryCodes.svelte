<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Recovery codes, shown once (an enrolment, or new codes from the account page, where the old codes stop working only after the
   * confirmation): the list (wraps on a phone), copy, download as a text file and the "Gespeichert" confirmation that answers the step. The codes stay in this component's props: never stored, logged or put into a URL. Never navigates.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'recovery-codes' }> & { errors?: FlowError[] };
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let busy = false, copied = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => timer && clearTimeout(timer));

  async function copy() {
    try {
      await navigator.clipboard.writeText(step.codes.join('\n'));
      copied = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 2500);
    } catch { /* no clipboard permission: the list can still be selected or downloaded */ }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([step.codes.join('\n') + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'friendflix-recovery-codes.txt';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function saved() {
    if (busy) return;
    busy = true;
    try {
      const r = await answer(step, {});
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
    }
  }
</script>

<div class="af-form" aria-busy={busy}>
  <h1>{$t('login.codes.title')}</h1>
  <p class="af-sub">{$t('login.codes.text')}</p>
  <ul class="codes" data-codes aria-label={$t('login.codes.title')}>
    {#each step.codes as c (c)}<li>{c}</li>{/each}
  </ul>
  <div class="row">
    <button class="af-sec" type="button" on:click={copy}><Icon name={copied ? 'check' : 'copy'} size={18} />{copied ? $t('login.codes.copied') : $t('login.codes.copy')}</button>
    <button class="af-sec" type="button" on:click={download}><Icon name="download" size={18} />{$t('login.codes.download')}</button>
  </div>
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="button" disabled={busy} on:click={saved}>{$t('login.codes.saved')}</button>
</div>

<style>
  .codes { list-style: none; margin: 0; padding: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr)); gap: 6px 12px; background: var(--surface-2); border-radius: 10px;
    font-family: ui-monospace, monospace; font-size: .95rem; user-select: all; }
  .codes li { min-width: 0; overflow-wrap: anywhere; }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: 8px; }
  .row :global(.af-sec) { display: inline-flex; gap: 6px; align-items: center; justify-content: center; }
</style>
