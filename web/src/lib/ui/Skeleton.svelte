<script lang="ts">
  /**
   * Shimmer placeholder (uses the global .skeleton, so reduced motion turns the sweep off).
   *   <Skeleton w="8rem" h="1.2rem" />   <Skeleton lines={3} />   <Skeleton h="120px" radius="8px" />
   */
  export let w = '100%';
  export let h = '1rem';
  export let radius = 'var(--radius)';
  /** >1: stacked text lines, the last one shorter */
  export let lines = 1;
  export let inline = false;
</script>

{#if lines > 1}
  <span class="lines" aria-hidden="true">{#each Array(lines) as _, i (i)}<span class="skeleton" style="width:{i === lines - 1 ? '60%' : w};height:{h};border-radius:{radius}"></span>{/each}</span>
{:else}
  <span class="skeleton" class:inline aria-hidden="true" style="width:{w};height:{h};border-radius:{radius}"></span>
{/if}

<style>
  .skeleton { display: block; max-width: 100%; }
  .skeleton.inline { display: inline-block; vertical-align: middle; }
  .lines { display: flex; flex-direction: column; gap: .5rem; width: 100%; }
</style>
