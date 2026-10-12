<script lang="ts">
  /**
   * Titled card for admin pages (the page <h1> comes from the shell, so cards use <h2>).
   *   <AdminCard title={$t('…')} description={$t('…')}><svelte:fragment slot="actions"><Button …/></svelte:fragment>…</AdminCard>
   */
  import { uid } from '#lib/ui/ids';
  export let title = '';
  export let description = '';
  /** heading id (aria-labelledby of the section); default: generated */
  export let id = '';
  const hid = id || uid('ac');
</script>

<section class="card" aria-labelledby={title ? hid : undefined}>
  {#if title || $$slots.actions}
    <div class="head">
      <div class="ttl">
        {#if title}<h2 id={hid}>{title}</h2>{/if}
        {#if description}<p class="desc">{description}</p>{/if}
      </div>
      {#if $$slots.actions}<div class="acts"><slot name="actions" /></div>{/if}
    </div>
  {/if}
  <slot />
</section>

<style>
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; min-width: 0; margin-bottom: 1rem; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: .8rem 1rem; flex-wrap: wrap; margin-bottom: .9rem; }
  .ttl { flex: 1 1 16rem; min-width: 0; }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  .desc { margin: .25rem 0 0; color: var(--mut); font-size: .9rem; }
  .acts { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  @media (max-width: 560px) { .card { padding: .85rem .9rem; } .acts { width: 100%; } }
</style>
