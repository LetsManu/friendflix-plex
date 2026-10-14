<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Row/overflow menu ("⋯") for secondary and destructive actions. Built on MoreActions (popover on desktop, bottom
   * sheet on touch; Arrow keys, Escape, focus return). Items: { id, label, icon?, run?, href?, danger?, disabled? }.
   *   <ActionMenu label={$t('ui.table.actionsFor', { name: u.name })} title={u.name} busy={$busyKeys.has('user:' + u.id)}
   *     items={[{ id: 'lock', label: $t('admin.users.lock'), icon: 'lock', danger: true, run: () => lock(u) }]} />
   */
  import MoreActions, { type MoreAction } from '#lib/MoreActions.svelte';
  import { t } from '#lib/i18n';
  export let items: MoreAction[] = [];
  /** accessible name of the trigger (say whose actions these are) */
  export let label = '';
  /** heading inside the menu/sheet */
  export let title = '';
  /** a running action: the trigger shows a spinner and the menu cannot open */
  export let busy = false;
</script>

<span class="am">
  {#if busy}
    <button type="button" class="busy" aria-disabled="true" aria-busy="true" aria-label={label || $t('ui.table.actions')}><span class="spinner" aria-hidden="true"></span></button>
  {:else}
    <MoreActions actions={items} label={label || $t('ui.table.actions')} {title} variant="ring" />
  {/if}
</span>

<style>
  .am { display: inline-flex; }
  .am :global(.ma.ring), .busy { width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; background: transparent; border: 1px solid #46505a; color: var(--fg); display: grid; place-items: center; }
  .am :global(.ma.ring:hover:not(:disabled)), .am :global(.ma.ring.on) { background: rgba(255,255,255,.08); border-color: #8a8a8a; }
  .busy { cursor: progress; }
  .busy:hover:not(:disabled) { background: transparent; }
</style>
