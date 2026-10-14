<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Item } from '#lib/api';
  import type { Person } from '#lib/detail/format';
  import type { Facts } from '#lib/fresh';
  import { fmtDate, intlLocale, locale, t } from '#lib/i18n';
  import type { About, AboutLink } from '#lib/detail/about';
  import Icon from '#lib/Icon.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import InfoBlock from '#lib/detail/InfoBlock.svelte';
  import SocialCard from '#lib/detail/SocialCard.svelte';

  /** Block 21 "Details" tab: info block (no cast line, the cast row sits above the tabs), facts, outbound links, social card, download. */
  export let item: Item;
  export let people: Person[] = [];
  export let facts: Facts | null = null;
  export let about: About | null | undefined = undefined;
  /** visible download button (desktop, non-series) */
  export let download = false;

  const LINK_LABEL: Record<AboutLink['kind'], string> = { imdb: 'IMDb', tmdb: 'TMDB', tvdb: 'TVDB', trakt: 'Trakt' };
  /** "2026-10-24" as a local calendar day (new Date('…') would be UTC midnight and can shift a day) */
  const local = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1); };
  function countryNames(list: string[]): string[] {
    let dn: Intl.DisplayNames | null = null;
    try { dn = new Intl.DisplayNames([intlLocale()], { type: 'region' }); } catch { dn = null; }
    return list.map((c) => { if (dn && /^[A-Za-z]{2}$/.test(c)) { try { return dn.of(c.toUpperCase()) ?? c; } catch { return c; } } return c; });
  }
  // $locale as a dependency: names and dates follow a language switch
  $: countries = $locale ? countryNames(about?.countries ?? []) : [];
  $: release = $locale && about?.releaseDate ? fmtDate(local(about.releaseDate)) : '';
  $: tags = [...(about?.tags ?? []), ...(about?.keywords ?? [])];
  $: links = about?.links ?? [];
  $: hasFacts = Boolean(about && (about.studios.length || tags.length || release || about.originalTitle || countries.length));
</script>

<div class="dt">
  <InfoBlock {item} {people} {facts} cast={false} />
  {#if hasFacts && about}
    <dl class="facts">
      {#if about.studios.length}<div><dt>{$t('detail.about.studios')}</dt><dd>{about.studios.join(', ')}</dd></div>{/if}
      {#if tags.length}<div><dt>{$t('detail.about.tags')}</dt><dd>{tags.join(', ')}</dd></div>{/if}
      {#if release}<div><dt>{$t('detail.about.releaseDate')}</dt><dd>{release}</dd></div>{/if}
      {#if about.originalTitle}<div><dt>{$t('detail.about.originalTitle')}</dt><dd>{about.originalTitle}</dd></div>{/if}
      {#if countries.length}<div><dt>{$t('detail.about.countries')}</dt><dd>{countries.join(', ')}</dd></div>{/if}
    </dl>
  {/if}
  {#if links.length}
    <section class="links" aria-labelledby="dt-links-h">
      <h3 id="dt-links-h">{$t('detail.about.links')}</h3>
      <ul>
        {#each links as l (l.kind)}<li><a href={l.url} target="_blank" rel="noopener noreferrer">{LINK_LABEL[l.kind]}<Icon name="link" size={16} /><span class="sr-only"> {$t('detail.about.newTab')}</span></a></li>{/each}
      </ul>
    </section>
  {/if}
  {#if about?.sources.includes('tmdb')}<p class="attrib">{$t('detail.about.tmdbNotice')}</p>{/if}
  <SocialCard id={item.id} type={item.type} on:rated />
  {#if download}<div class="dl"><DownloadButton itemId={item.id} /></div>{/if}
</div>

<style>
  .dt :global(.info) { margin-top: 1.4rem; }
  .facts { margin: .55rem 0 0; display: grid; gap: .55rem; font-size: .95rem; }
  .facts > div { display: grid; grid-template-columns: minmax(8.5rem, 11rem) 1fr; gap: .8rem; }
  .facts dt { color: var(--mut); }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  .links { margin-top: 1.4rem; }
  .links h3 { font-size: 1rem; margin: 0 0 .5rem; color: var(--mut); font-weight: 600; }
  .links ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
  .links a { display: inline-flex; align-items: center; gap: .35rem; min-height: 36px; padding: .2rem .8rem; border: 1px solid var(--line); border-radius: 99px; color: var(--fg); font-size: .9rem; text-decoration: none; }
  .links a:hover, .links a:focus-visible { border-color: var(--fg); }
  .attrib { margin: 1rem 0 0; color: var(--mut); font-size: .85rem; }
  .dl { margin-top: 1.6rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
  @media (pointer: coarse) { .links a { min-height: 44px; } }
  @media (max-width: 520px) { .facts > div { grid-template-columns: 1fr; gap: .1rem; } }
</style>
