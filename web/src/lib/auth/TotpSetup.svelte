<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The authenticator-app setup (an enrolment, or the account page via ReauthDialog): the QR code (drawn from `qrPath(otpauth)`, as SVG path data, no markup injected), the
   * secret in groups of 4 for a manual entry, and 6 boxes for the first code. The otpauth link stays in this component's props: it is
   * never stored, logged or put into a URL. Never navigates: emits `next` / `done`.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import { qrPath } from '#lib/qr';
  import Errors from './Errors.svelte';
  import { answer, codeFromBoxes, pasteCode, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'totp-setup' }> & { errors?: FlowError[] };
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let digits: string[] = ['', '', '', '', '', ''];
  let boxes: HTMLInputElement[] = [];
  let busy = false;
  let qr: { size: number; d: string } | null = null;
  let secret = '';
  $: {
    try {
      qr = qrPath(step.otpauth);
    } catch {
      qr = null;
    }
    secret = new URLSearchParams(step.otpauth.split('?')[1] ?? '').get('secret')?.replace(/=+$/, '').toUpperCase() ?? '';
  }
  $: groups = secret.match(/.{1,4}/g) ?? [];

  onMount(async () => {
    await tick();
    boxes[0]?.focus();
  });
  onDestroy(() => {
    secret = '';
    qr = null;
  });

  async function send() {
    const code = codeFromBoxes(digits);
    if (code.length !== 6) return void boxes[digits.findIndex((d) => !d)]?.focus();
    if (busy) return;
    busy = true;
    try {
      const r = await answer(step, { code });
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      digits = ['', '', '', '', '', ''];
    }
    await tick();
    boxes[0]?.focus();
  }
  function fill(from: number, ds: string[]) {
    for (let k = 0; k < ds.length && from + k < 6; k++) digits[from + k] = ds[k]!;
    digits = digits;
    const next = digits.findIndex((d) => !d);
    boxes[next < 0 ? 5 : next]?.focus();
    if (codeFromBoxes(digits).length === 6) void send();
  }
  function onInput(i: number, e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const ds = pasteCode(el.value);
    if (ds.length > 1) {
      el.value = digits[i] ?? '';
      return fill(ds.length === 6 ? 0 : i, ds);
    }
    digits[i] = ds[0] ?? '';
    el.value = digits[i]!;
    if (digits[i] && i < 5) boxes[i + 1]?.focus();
    if (codeFromBoxes(digits).length === 6) void send();
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
    }
  }
</script>

<div class="af-form" aria-busy={busy}>
  <h1>{$t('login.totp.title')}</h1>
  <p class="af-sub">{$t('login.totp.text')}</p>
  {#if qr}
    <svg class="qr" viewBox="-2 -2 {qr.size + 4} {qr.size + 4}" role="img" aria-label={$t('login.totp.qr')} shape-rendering="crispEdges">
      <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  {/if}
  {#if groups.length}
    <div class="key">
      <p class="af-hint">{$t('login.totp.secret')}</p>
      <p class="secret" data-secret>{#each groups as g, i (i)}<span>{g}</span>{/each}</p>
    </div>
  {/if}
  <form class="af-form" on:submit|preventDefault={send}>
    <div class="af-code" role="group" aria-label={$t('login.totp.group')}>
      {#each digits as d, i (i)}
        <label>
          <span class="sr-only">{$t('login.mfa.digit', { n: i + 1 })}</span>
          <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength={i === 0 ? 6 : 1} autocomplete="off" value={d} disabled={busy}
            bind:this={boxes[i]} on:input={(e) => onInput(i, e)} on:paste={(e) => onPaste(i, e)} on:keydown={(e) => onKey(i, e)} on:focus={(e) => e.currentTarget.select()} />
        </label>
      {/each}
    </div>
    <Errors errors={step.errors ?? []} {classicHref} />
    <button class="af-pri" type="submit" disabled={busy}>{$t('login.totp.submit')}</button>
  </form>
</div>

<style>
  .qr { width: min(100%, 200px); aspect-ratio: 1; justify-self: center; border-radius: 10px; }
  .key { display: grid; gap: 4px; }
  .secret { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 10px; justify-content: center; font-family: ui-monospace, monospace; font-size: 1.05rem; letter-spacing: .05em; user-select: all; }
</style>
