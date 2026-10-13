<script context="module" lang="ts">
  let seq = 0;
</script>

<script lang="ts">
  import { api, ApiError, img } from '#lib/api';
  import { swapModal } from '#lib/modal';
  import Icon from '#lib/Icon.svelte';
  import { fmtDate, t, tr } from '#lib/i18n';
  import { collectionView, type AboutCollection, type AboutPart } from '#lib/detail/about';

  export let collection: AboutCollection;
  export let canRequest = false;
  /** modal: titles open inside the dialog (no extra history entry); page: normal links */
  export let variant: 'modal' | 'page' = 'page';

  const hid = 'col-h-' + (++seq);
  $: v = collectionView(collection);
  let sent = new Set<number>(), busy = 0, msg = '';
  const href = (p: AboutPart) => `/item/${p.id}`;
  function go(e: MouseEvent, p: AboutPart) {
    if (variant !== 'modal' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    swapModal(href(p));
  }
  async function request(p: AboutPart) {
    if (busy || p.tmdbId === undefined || sent.has(p.tmdbId)) return;
    busy = p.tmdbId; msg = '';
    try {
      await api('/api/requests', { method: 'POST', body: { mediaType: 'movie', tmdbId: p.tmdbId } });
      sent.add(p.tmdbId); sent = sent;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && e.body?.error === 'request_limit') {
        const d = e.body.resetsAt ? fmtDate(e.body.resetsAt, { dateStyle: 'medium' }) : '';
        msg = d ? tr('home.search.limitUntil', { date: d }) : tr('home.search.limit');
      } else if (e instanceof ApiError && e.status === 409) { sent.add(p.tmdbId); sent = sent; msg = tr('home.search.already'); }
      else msg = tr('home.search.wishFailed');
    }
    busy = 0;
  }
</script>

{#if collection.parts.length}
  <section class="col" aria-labelledby={hid}>
    <div class="hd">
      <h2 id={hid}>{v.index > 0 ? $t('detail.collection.title', { i: v.index, n: v.total, name: collection.name }) : $t('detail.collection.titleAll', { n: v.total, name: collection.name })}</h2>
      {#if v.next}<a class="nx" href={href(v.next)} on:click={(e) => go(e, v.next!)}>{$t('detail.collection.next', { n: v.index + 1 })}</a>{/if}
    </div>
    <ul class="parts">
      {#each collection.parts as p, i (p.id ?? 't' + p.tmdbId + ':' + i)}
        <li class="part" class:missing={!p.inLibrary}>
          {#if p.inLibrary && p.id}
            <a class="poster" class:cur={p.current} href={href(p)} aria-label={p.played ? `${p.name}, ${$t('detail.collection.watched')}` : p.name} aria-current={p.current ? 'true' : undefined} on:click={(e) => go(e, p)}>
              {#if p.image}<img loading="lazy" decoding="async" src={img(p.id, 240)} alt="" />{/if}
              {#if p.played}<span class="tick" aria-hidden="true"><Icon name="check" size={16} /></span>{/if}
            </a>
          {:else}
            <div class="poster">{#if p.poster}<img loading="lazy" decoding="async" src={p.poster} alt="" />{/if}</div>
          {/if}
          <span class="nm">{p.name}</span>{#if p.year}<span class="yr">{p.year}</span>{/if}
          {#if !p.inLibrary}
            <span class="yr">{$t('detail.collection.missing')}</span>
            {#if canRequest && p.tmdbId !== undefined}
              {@const done = sent.has(p.tmdbId)}
              <button type="button" class="rq" aria-label={`${done ? $t('detail.collection.requested') : $t('detail.collection.request')}: ${p.name}`} aria-disabled={done || busy === p.tmdbId ? 'true' : undefined} on:click={() => request(p)}>{done ? $t('detail.collection.requested') : $t('detail.collection.request')}</button>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
    <div role="status">{#if msg}<p class="err small">{msg}</p>{/if}</div>
  </section>
{/if}

<style>
  .col { margin: 1.4rem 0 0; }
  .hd { display: flex; align-items: baseline; flex-wrap: wrap; gap: .4rem 1.2rem; margin: 0 0 .7rem; }
  h2 { font-size: 1.3rem; margin: 0; }
  .nx { color: #fff; text-decoration: underline; display: inline-flex; align-items: center; min-height: 44px; }
  .parts { list-style: none; margin: 0; padding: .3rem .2rem .5rem; display: flex; gap: .9rem; overflow-x: auto; scrollbar-width: thin; }
  .part { flex: none; width: 140px; display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
  .poster { position: relative; display: block; aspect-ratio: 2 / 3; background: #1c2228; border-radius: 6px; overflow: hidden; }
  .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .poster.cur { outline: 3px solid #fff; outline-offset: 2px; }
  .missing img { opacity: .5; filter: grayscale(1); }
  .tick { position: absolute; right: .35rem; top: .35rem; width: 24px; height: 24px; border-radius: 50%; background: rgba(0, 0, 0, .7); color: var(--ok); display: grid; place-items: center; }
  .nm { font-weight: 600; overflow-wrap: anywhere; }
  .yr { color: #bdbdbd; font-size: .8rem; }
  .rq { min-height: 44px; margin-top: .2rem; }
  .rq[aria-disabled='true'] { opacity: .6; cursor: default; }
  .small { font-size: .85rem; margin: .4rem 0 0; }
  @media (max-width: 899px) { .part { width: 96px; font-size: .8rem; } .parts { gap: .7rem; } }
</style>
