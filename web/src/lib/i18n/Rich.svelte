<script lang="ts">
  import { t, type TKey } from './index';
  import { markParams, richParts } from './rich';
  /** an already translated message without interpolated values, e.g. {$t('shell.help.deviceD')} (allowed markup: see rich.ts) */
  export let text = '';
  /** or: a message key plus values; the values are inserted as plain text after the markup was parsed (never markup) */
  export let key: TKey | null = null;
  export let params: Record<string, string | number | null | undefined> = {};
  /** called when one of its internal links is clicked (e.g. to close a dialog) */
  export let onLink: (href: string) => void = () => undefined;
  $: parts = key ? richParts($t(key, markParams(params)), params) : richParts(text);
</script>

{#each parts as p, i (i)}{#if p.kind === 'b'}<b>{p.text}</b>{:else if p.kind === 'kbd'}<kbd>{p.text}</kbd>{:else if p.kind === 'a'}<a href={p.href} on:click={() => onLink(p.href)}>{p.text}</a>{:else}{p.text}{/if}{/each}
