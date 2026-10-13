<script lang="ts">
  import { locale, t, type TKey } from '#lib/i18n';
  import { ratingParts, type About, type RatingKey } from '#lib/detail/about';

  /** `undefined` = still loading (fixed-height placeholder, no layout shift); `null` = no data (line hidden) */
  export let about: About | null | undefined = undefined;

  const ARIA: Record<RatingKey, TKey> = {
    community: 'detail.about.aria.community', critic: 'detail.about.aria.critic', imdb: 'detail.about.aria.imdb',
    rt: 'detail.about.aria.rt', mc: 'detail.about.aria.mc', friends: 'detail.about.aria.friends',
  };
  // $locale as a dependency: the texts follow a language switch
  $: parts = $locale ? ratingParts(about ?? null) : [];
  $: values = new Map((about?.ratings ?? []).map((r) => [r.key, r.value]));
  /** plain value for the screen-reader label (the visible text carries the short source name) */
  const aria = (k: RatingKey, tt: typeof $t, vals: Map<RatingKey, number>) => { const v = vals.get(k); return v === undefined ? '' : tt(ARIA[k], { n: k === 'rt' || k === 'mc' || k === 'critic' ? Math.round(v) : v }); };
</script>

{#if about === undefined}
  <div class="rl ph" aria-hidden="true"></div>
{:else if parts.length}
  <ul class="rl" aria-label={$t('detail.about.ratings')}>
    {#each parts as p (p.key)}<li class="r-{p.key}"><span aria-hidden="true">{p.text}</span><span class="sr-only">{aria(p.key, $t, values)}</span></li>{/each}
  </ul>
{/if}

<style>
  .rl { position: relative; min-height: 1.6rem; margin: 0 0 .5rem; padding: 0; list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: .2rem 0; color: #d2d2d2; font-size: .98rem; font-variant-numeric: tabular-nums; }
  .rl li { white-space: nowrap; }
  .rl li + li::before { content: '·'; margin: 0 .55rem; color: var(--mut); }
  .r-community, .r-friends { color: var(--fg); font-weight: 600; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
  @media (max-width: 640px) {
    .rl { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain; font-size: .92rem; }
    .rl::-webkit-scrollbar { display: none; }
  }
</style>
