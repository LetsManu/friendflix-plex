<script lang="ts">
  // Block 17: featured themed lists ("Themenlisten") as home rows (owned by worker S1, mounted on the home page by D1).
  // Pinned by an admin, items already filtered to what this profile may see; a list without a visible title is not rendered.
  import { onMount } from 'svelte';
  import { getActiveProfile } from '#lib/api';
  import { homeCache, swrLoad } from '#lib/home';
  import { coverGradient, loadThemed, type ThemedList } from '#lib/lists';
  import Row from '#lib/Row.svelte';
  import { t } from '#lib/i18n';

  let lists: ThemedList[] = [];
  onMount(() => {
    // no spinner / skeleton: themed rows are optional, the home page must not jump when there are none
    void swrLoad(homeCache, `${getActiveProfile()}|themed`, loadThemed, (v) => (lists = v), undefined, () => (lists = [])).catch(() => undefined);
  });
</script>

{#each lists as l (l.id)}
  <div class="themed" style:--tc={coverGradient(l.coverColor)}>
    <span class="eyebrow">{$t('mine.themed.eyebrow')}</span>
    <Row title={(l.emoji ? l.emoji + ' ' : '') + l.name} items={l.items} href="/lists/{l.id}" />
  </div>
{/each}

<style>
  .themed { position: relative; padding-top: 1.4rem; }
  /* a small pill in the list's cover colour above the row title; the row's own top margin is tightened under it */
  .eyebrow { display: inline-block; margin: 0 var(--pad-x); padding: .05rem .6rem; border-radius: 99px; background: var(--tc); color: #fff; font-size: .68rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .themed :global(.row) { margin-top: .5rem; }
</style>
