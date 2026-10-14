<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Number tile for dashboards (the value is not a heading).
   *   <StatTile icon="users" label={$t('admin.dash.users')} value={12} hint="3 gesperrt" href="/admin/users" tone="warn" />
   * value=null → skeleton. `pressed` (true/false) makes the tile a toggle button (filter tiles; on:click, aria-pressed).
   */
  import Icon from '#lib/Icon.svelte';
  import Skeleton from './Skeleton.svelte';
  export let label: string;
  export let value: string | number | null = null;
  export let icon = '';
  export let hint = '';
  export let href: string | undefined = undefined;
  export let tone: 'default' | 'ok' | 'warn' | 'err' = 'default';
  export let pressed: boolean | undefined = undefined;
  $: toggle = !href && pressed !== undefined;
</script>

{#if toggle}
<button type="button" aria-pressed={pressed} class="tile {tone} link toggle" class:on={pressed} on:click>
  {#if icon}<span class="ic" aria-hidden="true"><Icon name={icon} size={20} /></span>{/if}
  <span class="txt">
    <span class="val">{#if value === null}<Skeleton w="3rem" h="1.6rem" />{:else}{value}{/if}</span>
    <span class="lbl">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
</button>
{:else}
<svelte:element this={href ? 'a' : 'div'} {href} class="tile {tone}" class:link={!!href}>
  {#if icon}<span class="ic" aria-hidden="true"><Icon name={icon} size={20} /></span>{/if}
  <span class="txt">
    <span class="val">{#if value === null}<Skeleton w="3rem" h="1.6rem" />{:else}{value}{/if}</span>
    <span class="lbl">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  {#if href}<span class="go" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>{/if}
</svelte:element>
{/if}

<style>
  .tile { display: flex; align-items: flex-start; gap: .8rem; padding: 1rem 1.1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; min-width: 0; transition: background var(--t-fast), border-color var(--t-fast); }
  .link:hover { background: #1b2127; border-color: #353d46; }
  .toggle { width: 100%; min-height: 44px; font: inherit; font-weight: 400; color: inherit; text-align: left; justify-content: flex-start; cursor: pointer; }
  .toggle.on, .toggle.on:hover { border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc); background: #1b2127; }
  .ic { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 50%; background: rgba(255,255,255,.08); }
  .ok .ic { background: var(--tone-ok); color: var(--ok); }
  .warn .ic { background: var(--tone-warn); color: var(--warn); }
  .err .ic { background: var(--tone-err); color: var(--err); }
  .txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .val { font-size: 1.6rem; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .lbl { color: var(--mut); font-size: .88rem; }
  .hint { font-size: .8rem; color: var(--mut); margin-top: .15rem; }
  .warn .hint { color: var(--warn); } .err .hint { color: var(--err); }
  .go { align-self: center; color: var(--mut); }
</style>
