<script lang="ts">
  /**
   * Button with the kit's variants (docs/ui-kit.md). Renders <a> when `href` is set.
   *   <Button variant="danger" pending={busy} on:click={remove} icon="x">{$t('ui.confirm.delete')}</Button>
   * `pending`: spinner, aria-busy, disabled (the label stays so the width does not jump).
   */
  import Icon from '#lib/Icon.svelte';
  export let variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'primary';
  export let pending = false;
  export let disabled = false;
  export let type: 'button' | 'submit' | 'reset' = 'button';
  export let href: string | undefined = undefined;
  /** name from Icon.svelte, shown before the label */
  export let icon = '';
  export let size: 'md' | 'sm' = 'md';
  /** full width */
  export let block = false;
  /** a solid red danger button (the confirm button of a dialog) */
  export let solid = false;
  let cls = '';
  export { cls as class };
  const guard = (e: MouseEvent) => { if (pending) { e.preventDefault(); e.stopImmediatePropagation(); } };
  $: klass = ['ui-btn', variant === 'secondary' ? 'sec' : variant === 'primary' ? '' : variant, size === 'sm' ? 'sm' : '', block ? 'block' : '', solid ? 'solid' : '', cls].filter(Boolean).join(' ');
</script>

{#if href && !disabled}
  <a {href} class="btn {klass}" {...$$restProps} on:click>{#if icon}<Icon name={icon} size={18} />{/if}<slot /></a>
{:else}
  <!-- pending keeps focus (aria-disabled instead of disabled) and swallows clicks before any on:click handler runs -->
  <button {type} class={klass} {disabled} aria-disabled={pending ? 'true' : undefined} aria-busy={pending ? 'true' : undefined} {...$$restProps} on:click|capture={guard} on:click>
    {#if pending}<span class="spinner" aria-hidden="true"></span>{:else if icon}<Icon name={icon} size={18} />{/if}<slot />
  </button>
{/if}

<style>
  .sm { min-height: 36px; padding: .35rem .8rem; font-size: .9rem; }
  @media (pointer: coarse) { .sm { min-height: 44px; } }
  .block { width: 100%; }
  [aria-disabled='true'] { opacity: .75; }
  :global(html.tv) .sm { min-height: 48px; }
</style>
