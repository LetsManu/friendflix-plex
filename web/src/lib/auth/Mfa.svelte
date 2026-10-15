<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Screen 3, the second factor: 6 single-digit boxes for the authenticator app (submitted on the 6th digit; a paste fills all boxes),
   * "Stattdessen Wiederherstellungscode nutzen" (one text field) and "Passkey verwenden" (in-app when the step carries options, else a
   * link to the sign-in page). When a passkey is the only factor, the screen starts with the passkey button and no boxes.
   * Never navigates: emits `next` / `done`; the sign-in page links use `classicHref`.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, codeFromBoxes, passkeyGet, pasteCode, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'mfa' }> & { errors?: FlowError[] };
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  type Mode = 'code' | 'recovery' | 'passkey';
  let mode: Mode = step.totp ? 'code' : step.passkey ? 'passkey' : 'recovery';
  let digits: string[] = ['', '', '', '', '', ''];
  let boxes: HTMLInputElement[] = [];
  let recoveryCode = '';
  let busy = false;
  let passkeyHint: '' | 'cancelled' | 'unsupported' = '';
  let recoveryInput: HTMLInputElement, heading: HTMLElement, passkeyBtn: HTMLButtonElement;

  onMount(() => focusMode());

  async function focusMode() {
    await tick();
    if (mode === 'code') boxes[0]?.focus();
    else if (mode === 'recovery') recoveryInput?.focus();
    else (passkeyBtn ?? heading)?.focus();
  }
  function switchTo(m: Mode) {
    mode = m;
    passkeyHint = '';
    void focusMode();
  }

  function emit(r: FlowReply) {
    if (r.stage === 'done') dispatch('done', { next: r.next });
    else dispatch('next', r);
  }
  async function send(body: Record<string, unknown>) {
    if (busy) return;
    busy = true;
    passkeyHint = '';
    try {
      emit(await answer(step, body));
    } finally {
      busy = false;
      digits = ['', '', '', '', '', ''];
      recoveryCode = '';
    }
    void focusMode();
  }

  // ---- the 6 boxes ----
  function fill(from: number, ds: string[]) {
    for (let k = 0; k < ds.length && from + k < 6; k++) digits[from + k] = ds[k]!;
    digits = digits;
    const next = digits.findIndex((d) => !d);
    boxes[next < 0 ? 5 : next]?.focus();
    maybeSubmit();
  }
  function onInput(i: number, e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const ds = pasteCode(el.value);
    if (ds.length > 1) {
      el.value = digits[i] ?? '';
      fill(ds.length === 6 ? 0 : i, ds); // autofill of the whole code into one box
      return;
    }
    digits[i] = ds[0] ?? '';
    el.value = digits[i]!;
    if (digits[i] && i < 5) boxes[i + 1]?.focus();
    maybeSubmit();
  }
  function onPaste(i: number, e: ClipboardEvent) {
    e.preventDefault();
    const ds = pasteCode(e.clipboardData?.getData('text') ?? '');
    if (ds.length) fill(ds.length === 6 ? 0 : i, ds);
  }
  function onKey(i: number, e: KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      e.preventDefault();
      digits[i - 1] = '';
      boxes[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      boxes[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < 5) {
      e.preventDefault();
      boxes[i + 1]?.focus();
    }
  }
  function maybeSubmit() {
    const code = codeFromBoxes(digits);
    if (code.length === 6) void send({ code });
  }
  function submitCode() {
    const code = codeFromBoxes(digits);
    if (code.length === 6) void send({ code });
    else boxes[digits.findIndex((d) => !d)]?.focus();
  }
  function submitRecovery() {
    const code = recoveryCode.replace(/[\s-]/g, '');
    if (code) void send({ code });
  }

  async function usePasskey() {
    if (busy || !step.passkey) return;
    busy = true;
    passkeyHint = '';
    let webauthn;
    try {
      webauthn = await passkeyGet(step.passkey);
    } catch (e) {
      passkeyHint = (e as Error | null)?.message === 'passkey_unsupported' ? 'unsupported' : 'cancelled';
      busy = false;
      return;
    }
    busy = false;
    await send({ webauthn });
  }
</script>

<div class="af-form" aria-busy={busy}>
  {#if mode === 'code'}
    <h1 bind:this={heading} tabindex="-1">{$t('login.mfa.title')}</h1>
    <p class="af-sub">{$t('login.mfa.text')}</p>
    <form class="af-form" on:submit|preventDefault={submitCode}>
      <div class="af-code" role="group" aria-label={$t('login.mfa.group')}>
        {#each digits as d, i (i)}
          <label>
            <span class="sr-only">{$t('login.mfa.digit', { n: i + 1 })}</span>
            <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength={i === 0 ? 6 : 1} autocomplete={i === 0 ? 'one-time-code' : 'off'} value={d}
              disabled={busy} bind:this={boxes[i]} on:input={(e) => onInput(i, e)} on:paste={(e) => onPaste(i, e)} on:keydown={(e) => onKey(i, e)} on:focus={(e) => e.currentTarget.select()} />
          </label>
        {/each}
      </div>
      <Errors errors={step.errors ?? []} {classicHref} />
      <button class="af-pri" type="submit" disabled={busy}>{$t('login.mfa.submit')}</button>
    </form>
  {:else if mode === 'recovery'}
    <h1 bind:this={heading} tabindex="-1">{$t('login.mfa.recoveryTitle')}</h1>
    <p class="af-sub">{$t('login.mfa.recoveryText')}</p>
    <form class="af-form" on:submit|preventDefault={submitRecovery}>
      <div class="af-field">
        <label for="af-recovery">{$t('login.mfa.recoveryLabel')}</label>
        <input id="af-recovery" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" required bind:value={recoveryCode} bind:this={recoveryInput} disabled={busy} />
      </div>
      <Errors errors={step.errors ?? []} {classicHref} />
      <button class="af-pri" type="submit" disabled={busy}>{$t('login.mfa.submit')}</button>
    </form>
  {:else}
    <div class="af-big" aria-hidden="true"><Icon name="key" size={30} /></div>
    <h1 class="af-center" bind:this={heading} tabindex="-1">{$t('login.mfa.passkeyTitle')}</h1>
    <p class="af-sub af-center">{$t('login.mfa.passkeyText')}</p>
    <Errors errors={step.errors ?? []} {classicHref} />
  {/if}

  {#if step.passkey}
    <button class={mode === 'passkey' ? 'af-pri' : 'af-sec'} type="button" disabled={busy} bind:this={passkeyBtn} on:click={usePasskey}><Icon name="key" size={20} />{$t('login.mfa.passkey')}</button>
  {:else if step.passkeyClassic}
    <a class="af-link" href={classicHref}>{$t('login.mfa.passkey')}</a>
  {/if}
  {#if passkeyHint}
    <p class="af-hint" role="status">
      {passkeyHint === 'unsupported' ? $t('login.passkey.unsupported') : $t('login.passkey.noMatch')}
      <a class="af-link" href={classicHref}>{$t('login.passkey.classic')}</a>
    </p>
  {/if}
  {#if mode !== 'recovery' && step.recovery}
    <button class="af-link" type="button" disabled={busy} on:click={() => switchTo('recovery')}>{$t('login.mfa.useRecovery')}</button>
  {/if}
  {#if mode !== 'code' && step.totp}
    <button class="af-link" type="button" disabled={busy} on:click={() => switchTo('code')}>{$t('login.mfa.useCode')}</button>
  {/if}
</div>
