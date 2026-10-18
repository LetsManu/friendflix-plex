<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Caption of a recommendation row (engine v2): the reason of the top pick ("Because you watched X · same director").
   * A tap on it opens "Why am I seeing this?": the reason of the first titles of the row, inline (no dialog). Renders nothing
   * for rows without reasons (engine v1).
   */
  import type { Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { reasonLines, reasonText } from '#lib/reason';

  export let items: readonly Item[];
  export let limit = 5;
  let open = false;
  const uid = `why-${Math.random().toString(36).slice(2, 8)}`;
  $: caption = reasonText(items.find((i) => i.reason)?.reason, $t);
  $: lines = open ? reasonLines(items, $t, limit) : [];
</script>

{#if caption}
  <div class="why" data-testid="reason-caption">
    <button type="button" class="cap" data-testid="reason-toggle" aria-expanded={open} aria-controls={uid} title={$t('reco.why.button')} on:click={() => (open = !open)}>{caption}</button>
    {#if open}
      <div id={uid} class="list" role="region" aria-label={$t('reco.why.heading')}>
        <b>{$t('reco.why.heading')}</b>
        <ul>{#each lines as l (l.id)}<li>{$t('reco.why.item', { name: l.name, reason: l.text })}</li>{/each}</ul>
        <button type="button" class="link" on:click={() => (open = false)}>{$t('reco.why.close')}</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .why { margin: -.25rem var(--pad-x) .5rem; font-size: .85rem; color: var(--mut, #9aa4ae); min-width: 0; }
  .cap { background: none; border: 0; padding: .25rem 0; margin: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; overflow-wrap: anywhere; min-height: 28px; }
  .cap:hover, .cap:focus-visible { color: #fff; }
  .list { margin: .3rem 0 0; padding: .6rem .8rem; border: 1px solid #2c343d; border-radius: 8px; background: rgba(22, 27, 33, .85); color: #d6dce2; display: grid; gap: .3rem; }
  .list ul { margin: 0; padding-left: 1.1rem; display: grid; gap: .2rem; }
  .link { justify-self: start; background: none; border: 0; color: #fff; text-decoration: underline; padding: .2rem 0; cursor: pointer; font: inherit; }
</style>
