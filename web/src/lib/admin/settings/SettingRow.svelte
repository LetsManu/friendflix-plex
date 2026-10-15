<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One setting of Admin → Settings: label, help, source badge and an input by kind. Controlled: the page owns the draft (`draft`
   * undefined = untouched) and gets `edit` events. Secrets are write-only: Replace opens an empty field, Remove marks the key for
   * clearing (the page sends null); a value typed here is never shown again once saved. Env rows are locked and offer "Move".
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { fmtDate, t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import CopyField from '#lib/ui/CopyField.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { uid } from '#lib/ui/ids';
  import type { SettingView, Source } from './api';
  import { enumOptions, keyHelp, keyLabel, shownDraft, type Draft } from './form';

  export let item: SettingView;
  export let draft: Draft | undefined = undefined;
  /** error text of the last save (400 invalid_settings) */
  export let error = '';
  /** the env names to remove, once the value was moved into the settings */
  export let movedHint = '';
  export let moving = false;
  export let generating = false;
  /** a generated webhook secret: shown once, never stored */
  export let generated = '';

  const dispatch = createEventDispatcher<{ edit: Draft | undefined; move: void; generate: void }>();
  const id = uid('set');
  let secretInput: HTMLInputElement | undefined;

  $: label = keyLabel(item.key);
  $: help = keyHelp(item.key);
  $: locked = item.source === 'env';
  $: secret = item.kind === 'secret';
  $: shown = shownDraft(item);
  $: text = typeof draft === 'string' ? draft : typeof shown === 'string' ? shown : '';
  $: checked = typeof draft === 'boolean' ? draft : shown === true;
  $: replacing = secret && typeof draft === 'string';

  const TONE: Record<Source, Tone> = { env: 'info', db: 'ok', default: 'muted', bootstrap: 'info', unset: 'muted' };
  const ICON: Record<Source, string> = { env: 'lock', db: 'check', default: 'x', bootstrap: 'lock', unset: 'x' };
  $: numeric = item.kind === 'int' || item.kind === 'number';

  async function replace() {
    dispatch('edit', '');
    await tick();
    secretInput?.focus();
  }
  const input = (e: Event) => dispatch('edit', (e.currentTarget as HTMLInputElement).value);
</script>

<div class="row" role="group" aria-labelledby="{id}-l">
  <div class="head">
    <span class="lbl" id="{id}-l">{label}</span>
    <code class="key">{item.key}</code>
    <span class="pills">
      {#if !secret}<StatusPill tone={TONE[item.source]} icon={ICON[item.source]} label={$t(`settings.source.${item.source}`)} />
      {:else if locked}<StatusPill tone="info" icon="lock" label={$t('settings.source.env')} />{/if}
      {#if item.apply === 'restart'}<StatusPill tone="warn" icon="refresh" label={$t('settings.restart')} />{/if}
    </span>
  </div>

  {#if secret}
    {#if help}<p class="help">{help}</p>{/if}
    <div class="secret">
      {#if item.invalid}<StatusPill tone="err" label={$t('settings.secret.unset')} />
      {:else if item.set}<StatusPill tone="ok" label={item.last4 ? $t('settings.secret.last4', { last4: item.last4 }) : $t('settings.secret.set')} />
      {:else}<StatusPill tone="muted" label={$t('settings.secret.unset')} />{/if}
      {#if item.set && item.updatedAt && !locked}<span class="muted small">{$t('settings.secret.updated', { date: fmtDate(item.updatedAt, { dateStyle: 'medium' }) })}</span>{/if}
    </div>
    {#if item.invalid}<p class="error">{$t('settings.invalid')}</p>{/if}
    {#if !locked}
      {#if draft === null}
        <div class="acts">
          <p class="note">{$t('settings.secret.cleared')}</p>
          <Button variant="ghost" size="sm" icon="refresh" on:click={() => dispatch('edit', undefined)}>{$t('settings.secret.keep')}</Button>
        </div>
      {:else if replacing}
        <div class="replace">
          <Field label={$t('settings.secret.newValue')} let:id={fid} let:describedby let:invalid>
            <input id={fid} bind:this={secretInput} type="password" autocomplete="off" spellcheck="false" value={text} aria-describedby={describedby} aria-invalid={invalid} maxlength={4096} on:input={input} />
          </Field>
          <Button variant="ghost" size="sm" icon="x" on:click={() => dispatch('edit', undefined)}>{$t('settings.secret.cancel')}</Button>
        </div>
      {:else}
        <div class="acts">
          <Button variant="secondary" size="sm" icon="key" aria-label={$t('settings.secret.replaceA11y', { label })} on:click={replace}>{$t('settings.secret.replace')}</Button>
          <Button variant="ghost" size="sm" icon="x" disabled={!item.set && !item.invalid} aria-label={$t('settings.secret.clearA11y', { label })} on:click={() => dispatch('edit', null)}>{$t('settings.secret.clear')}</Button>
          {#if item.generate}
            <Button variant="ghost" size="sm" icon="refresh" pending={generating} aria-label={$t('settings.generate.a11y', { label, action: $t(`settings.generate.${item.generate}`) })} on:click={() => dispatch('generate')}>{$t(`settings.generate.${item.generate}`)}</Button>
          {/if}
        </div>
      {/if}
      {#if generated}<CopyField label={$t('settings.generate.newSecret')} value={generated} hint={$t('settings.generate.once')} />{/if}
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {:else if item.kind === 'bool'}
    <Toggle label={label} hideLabel hint={help} {checked} disabled={locked} on:change={(e) => dispatch('edit', e.detail)} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {:else if item.kind === 'enum' && item.options}
    <Select label={label} hideLabel hint={help} {error} disabled={locked} value={text} options={enumOptions(item)}
      on:change={(e) => dispatch('edit', (e.target as HTMLSelectElement).value)} />
  {:else}
    <Field label={label} hideLabel hint={help} {error} let:id={fid} let:describedby let:invalid>
      {#if numeric}
        <input id={fid} type="number" inputmode={item.kind === 'int' ? 'numeric' : 'decimal'} step={item.kind === 'int' ? 1 : 'any'} min={item.min} max={item.max}
          value={text} disabled={locked} aria-describedby={describedby} aria-invalid={invalid} on:input={input} />
      {:else}
        <input id={fid} type="text" inputmode={item.kind === 'url' ? 'url' : undefined} spellcheck="false" autocomplete="off" value={text} disabled={locked}
          aria-describedby={describedby} aria-invalid={invalid} maxlength={2048} on:input={input} />
      {/if}
    </Field>
  {/if}

  {#if item.invalid && !secret}<p class="error">{$t('settings.invalid')}</p>{/if}
  {#if locked}
    {#if movedHint}
      <p class="moved" role="status">{movedHint}</p>
    {:else}
      <div class="acts">
        <span class="muted small">{$t('settings.locked')}</span>
        <Button variant="secondary" size="sm" icon="download" pending={moving} aria-label={$t('settings.moveA11y', { label })} on:click={() => dispatch('move')}>{$t('settings.move')}</Button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .row { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5rem; padding: .9rem 0; border-top: 1px solid var(--line); min-width: 0; }
  .row:first-child { border-top: 0; padding-top: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .6rem; min-width: 0; }
  .lbl { font-weight: 600; }
  .key { font-size: .78rem; color: var(--mut); overflow-wrap: anywhere; }
  .pills { display: inline-flex; flex-wrap: wrap; gap: .4rem; }
  .help { margin: 0; font-size: .82rem; color: var(--mut); }
  .secret { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .8rem; }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .6rem; }
  .replace { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .5rem; }
  .replace :global(.field) { flex: 1 1 14rem; }
  .note { margin: 0; color: var(--warn); font-size: .9rem; }
  .small { font-size: .85rem; }
  .error { margin: 0; font-size: .85rem; color: var(--err); font-weight: 600; }
  .moved { margin: 0; font-size: .88rem; padding: .5rem .7rem; border-radius: 6px; background: var(--tone-info); color: var(--fg); overflow-wrap: anywhere; }
  input { width: 100%; max-width: 100%; }
</style>
