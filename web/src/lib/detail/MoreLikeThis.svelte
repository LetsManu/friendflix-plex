<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { backdrop, img, srcset, type Item } from '#lib/api';
  import { listIds, toggleList } from '#lib/stores';
  import Icon from '#lib/Icon.svelte';
  import { openModal, swapModal } from '#lib/modal';
  import { lengthLabel } from '#lib/hover';
  import { t } from '#lib/i18n';
  import { uniqueBy } from '#lib/detail/safe';

  /** null = loading */
  export let items: Item[] | null;
  /** modal: titles open inside the dialog (no extra history entry); page: normal links */
  export let variant: 'modal' | 'page' = 'page';

  /** the same title twice (Jellyfin "similar" can repeat one) would be a duplicate key of the keyed list below */
  $: list = items === null ? null : uniqueBy(items, (i) => i.id);
  let failId = '';
  const href = (i: Item) => (i.type === 'Episode' && i.seriesId ? `/item/${i.seriesId}` : `/item/${i.id}`);
  function go(e: MouseEvent, i: Item) {
    if (variant === 'modal') {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      swapModal(href(i));
    } else openModal(e, href(i)); // page: shallow-routed popup like the cards
  }
  async function add(i: Item) { if (!(await toggleList(i.id, $listIds.has(i.id)))) { failId = i.id; setTimeout(() => (failId = ''), 4000); } }
</script>

{#if list === null || list.length}
  <section class="more" aria-labelledby="more-h" aria-busy={list === null}>
    <h2 id="more-h">{$t('detail.more.title')}</h2>
    <ul class="grid3" class:modal={variant === 'modal'}>
      {#if list === null}
        {#each Array(6) as _}<li><div class="skeleton sk"></div></li>{/each}
      {:else}
        {#each list as i (i.id)}
          {@const inList = $listIds.has(i.id)}
          {@const len = lengthLabel(i)}
          <li class="mc">
            <a class="im" href={href(i)} tabindex="-1" aria-hidden="true" on:click={(e) => go(e, i)}>
              {#if i.backdrop}<img loading="lazy" decoding="async" src={backdrop(i.id, 520)} srcset={srcset('Backdrop', i.id, [320, 520, 780])} sizes="(min-width: 900px) 260px, 45vw" alt="" />
              {:else if i.image}<img class="contain" loading="lazy" decoding="async" src={img(i.id, 320)} alt="" />{/if}
              {#if len}<span class="dur">{len}</span>{/if}
            </a>
            <div class="bd">
              <div class="row1">
                <span class="meta">{#if i.rating}<span class="age">{i.rating}</span>{/if}{#if i.year}<span>{i.year}</span>{/if}</span>
                <button type="button" class="add" aria-pressed={inList} aria-label={inList ? $t('detail.more.remove', { name: i.name }) : $t('detail.more.add', { name: i.name })} on:click={() => add(i)}><Icon name={inList ? 'check' : 'plus'} size={18} /></button>
              </div>
              <h3 class="nm"><a href={href(i)} on:click={(e) => go(e, i)}>{i.name}</a></h3>
              {#if failId === i.id}<p class="err small" role="status">{$t('detail.more.saveFailed')}</p>{/if}
              {#if i.overview}<p class="ov">{i.overview}</p>{/if}
            </div>
          </li>
        {/each}
      {/if}
    </ul>
  </section>
{/if}

<style>
  .more { margin-top: 2.4rem; }
  h2 { font-size: 1.4rem; margin: 0 0 .8rem; }
  .grid3 { list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .grid3.modal { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (max-width: 899px) { .grid3, .grid3.modal { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 340px) { .grid3, .grid3.modal { grid-template-columns: minmax(0, 1fr); } }
  .sk { aspect-ratio: 16 / 12; }
  .mc { background: #2a323b; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }
  .im { position: relative; display: block; aspect-ratio: 16 / 9; background: #1c2228; }
  .im img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .im img.contain { object-fit: contain; }
  .dur { position: absolute; right: .5rem; top: .5rem; background: rgba(0, 0, 0, .65); padding: .05rem .45rem; border-radius: 3px; font-size: .75rem; font-weight: 600; }
  .bd { padding: .7rem .8rem .9rem; display: flex; flex-direction: column; gap: .3rem; flex: 1; }
  .row1 { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
  .meta { display: flex; gap: .6rem; align-items: center; font-size: .82rem; color: #d2d2d2; }
  .age { border: 1px solid rgba(255, 255, 255, .45); padding: 0 .35rem; line-height: 1.35; }
  .add { width: 44px; min-height: 44px; height: 44px; margin: -6px -8px -6px 0; padding: 0; border-radius: 50%; background: transparent; border: 0; color: #fff; flex: none; }
  .add:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
  .add[aria-pressed='true'] { color: var(--ok); }
  .nm { margin: 0; font-size: 1rem; }
  .nm a:hover { text-decoration: underline; }
  .ov { margin: .1rem 0 0; font-size: .85rem; color: #bdbdbd; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  @media (pointer: coarse) { .nm a { display: inline-flex; align-items: center; min-height: 44px; } }
  .small { font-size: .8rem; margin: 0; }
</style>
