<script lang="ts">
  import type { Item } from '#lib/api';
  import { ageText, byType, moodTags, type Person } from '#lib/detail/format';
  import { t } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import type { Facts } from '#lib/fresh';
  import QualityChips from '#lib/QualityChips.svelte';

  export let item: Item;
  export let people: Person[] = [];
  /** facts of the title (quality chips); optional */
  export let facts: Facts | null = null;

  $: directors = byType(people, 'Director');
  $: writers = byType(people, 'Writer');
  $: actors = byType(people, 'Actor', 'GuestStar');
  $: moods = moodTags(item.genres);
  $: age = ageText(item.rating);
</script>

<section class="info" id="dv-info" aria-labelledby="info-h">
  <h2 id="info-h"><Rich key="detail.info.title" params={{ name: item.name }} /></h2>
  <dl>
    {#if directors.length}<div><dt>{$t('detail.info.director')}</dt><dd>{#each directors as p, n (p.id + n)}{#if n}{', '}{/if}<a href="/person/{p.id}">{p.name}</a>{/each}</dd></div>{/if}
    {#if actors.length}<div><dt>{$t('detail.info.cast')}</dt><dd>{#each actors as p, n (p.id + n)}{#if n}{', '}{/if}<a href="/person/{p.id}">{p.name}</a>{/each}</dd></div>{/if}
    {#if writers.length}<div><dt>{$t('detail.info.writer')}</dt><dd>{#each writers as p, n (p.id + n)}{#if n}{', '}{/if}<a href="/person/{p.id}">{p.name}</a>{/each}</dd></div>{/if}
    {#if item.genres.length}<div><dt>{$t('detail.info.genres')}</dt><dd>{item.genres.join(', ')}</dd></div>{/if}
    {#if moods.length}<div><dt>{$t('detail.info.moods')}</dt><dd>{moods.join(', ')}</dd></div>{/if}
    {#if facts?.traits}<div><dt>{$t('fresh.q.label')}</dt><dd class="qd"><QualityChips traits={facts.traits} /></dd></div>{/if}
    {#if item.rating}<div><dt>{$t('detail.info.age')}</dt><dd><span class="age">{item.rating}</span>{#if age} <span>{age}</span>{/if}</dd></div>{/if}
  </dl>
</section>

<style>
  .info { margin-top: 2.4rem; }
  h2 { font-size: 1.4rem; margin: 0 0 .8rem; font-weight: 400; }
  h2 :global(b) { font-weight: 700; }
  dl { margin: 0; display: grid; gap: .55rem; font-size: .95rem; }
  dl > div { display: grid; grid-template-columns: minmax(8.5rem, 11rem) 1fr; gap: .8rem; }
  dt { color: var(--mut); }
  dd { margin: 0; }
  dd a { text-decoration: underline; text-decoration-color: transparent; transition: text-decoration-color var(--t-fast); }
  dd a:hover, dd a:focus-visible { text-decoration-color: currentColor; }
  @media (pointer: coarse) { dd a { display: inline-flex; align-items: center; min-height: 44px; } }
  .qd :global(.qc) { margin: 0; }
  .age { border: 1px solid rgba(255, 255, 255, .45); padding: 0 .4rem; margin-right: .4rem; }
  @media (max-width: 520px) { dl > div { grid-template-columns: 1fr; gap: .1rem; } }
</style>
