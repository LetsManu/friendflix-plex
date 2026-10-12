<script lang="ts">
  /**
   * Labelled form field with hint and error (aria-describedby / aria-invalid wired up).
   *   <Field label={$t('…')} bind:value={name} required error={nameErr} />
   *   <Field label="Max" type="number" bind:value={max} min={0} max={200} hint="0–200" />
   *   <Field label="Custom" let:id let:describedby let:invalid><textarea {id} aria-describedby={describedby} aria-invalid={invalid} /></Field>
   */
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { uid } from './ids';
  export let label: string;
  export let value: string | number | null = '';
  export let type: 'text' | 'number' | 'email' | 'search' | 'url' | 'password' | 'time' | 'date' = 'text';
  export let hint = '';
  export let error = '';
  export let required = false;
  export let disabled = false;
  export let placeholder = '';
  /** number, or an ISO date (YYYY-MM-DD) for type="date" */
  export let min: number | string | undefined = undefined;
  export let max: number | string | undefined = undefined;
  export let step: number | undefined = undefined;
  export let maxlength: number | undefined = undefined;
  /** visually hidden label (still the accessible name) */
  export let hideLabel = false;
  /** input width, e.g. "8rem"; default fills the field */
  export let width = '';
  export let autocomplete: HTMLInputAttributes['autocomplete'] = undefined;
  export let id = uid('fld');
  $: hintId = hint ? `${id}-h` : '';
  $: errId = error ? `${id}-e` : '';
  $: describedby = [hintId, errId].filter(Boolean).join(' ') || undefined;
  $: invalid = error ? 'true' as const : undefined;
</script>

<div class="field" class:has-err={!!error}>
  <label for={id} class:sr-only={hideLabel}>{label}{#if required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
  {#if $$slots.default}
    <slot {id} {describedby} {invalid} />
  {:else}
    <input {id} {type} bind:value {required} {disabled} {placeholder} {min} {max} {step} {maxlength} {autocomplete} aria-describedby={describedby} aria-invalid={invalid} style={width ? `width:${width}` : undefined} on:change on:input on:blur on:keydown />
  {/if}
  {#if hint}<span class="hint" id={hintId}>{hint}</span>{/if}
  {#if error}<span class="error" id={errId} role="alert">{error}</span>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .field :global(input:not([type='checkbox']):not([type='radio'])), .field :global(select), .field :global(textarea) { width: 100%; max-width: 100%; }
  .req { color: var(--err); }
  .hint { font-size: .82rem; color: var(--mut); }
  .error { font-size: .85rem; color: var(--err); font-weight: 600; }
  .has-err :global(input), .has-err :global(select), .has-err :global(textarea) { border-color: var(--err); }
</style>
