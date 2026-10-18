<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  export interface SelectOption { value: string; label: string; disabled?: boolean }
</script>

<script lang="ts">
  /**
   * Labelled native <select> (keyboard/TV friendly) with hint and error.
   *   <Select label={$t('admin.users.role')} bind:value={role} options={[{ value: 'friend', label: 'Freund' }]} on:change={save} />
   */
  import Icon from '#lib/Icon.svelte';
  import { uid } from './ids';
  export let label: string;
  export let value = '';
  export let options: SelectOption[] = [];
  export let hint = '';
  export let error = '';
  export let disabled = false;
  export let hideLabel = false;
  export let id = uid('sel');
  $: describedby = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
</script>

<div class="field" class:inline={hideLabel}>
  <label for={id} class:sr-only={hideLabel}>{label}</label>
  <span class="wrap">
    <select {id} bind:value {disabled} aria-describedby={describedby} aria-invalid={error ? 'true' : undefined} on:change>
      {#each options as o (o.value)}<option value={o.value} disabled={o.disabled}>{o.label}</option>{/each}
    </select>
    <span class="chev" aria-hidden="true"><Icon name="chevron-down" size={16} /></span>
  </span>
  {#if hint}<span class="hint" id="{id}-h">{hint}</span>{/if}
  {#if error}<span class="error" id="{id}-e" role="alert">{error}</span>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .wrap { position: relative; display: block; }
  select { width: 100%; appearance: none; -webkit-appearance: none; padding-right: 2.2rem; cursor: pointer; }
  .chev { position: absolute; right: .7rem; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--mut); }
  .hint { font-size: .82rem; color: var(--mut); overflow-wrap: anywhere; } /* long example URLs wrap at 320 px */
  .error { font-size: .85rem; color: var(--err); font-weight: 600; }
</style>
