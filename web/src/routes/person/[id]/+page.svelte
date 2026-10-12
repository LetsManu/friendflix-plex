<script lang="ts">
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, ApiError, img, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { t, type TKey } from '#lib/i18n';

  interface Person { id: string; name: string; overview?: string; birthYear?: number; image: boolean }
  let person: Person | null = null, items: Item[] = [], status: 'loading' | 'ready' | 'notfound' | 'error' = 'loading', seq = 0;
  let type: 'all' | 'Movie' | 'Series' = 'all', more = false;

  $: if ($page.params.id) void load($page.params.id);
  async function load(id: string) {
    const my = ++seq;
    status = 'loading'; person = null; items = []; type = 'all'; more = false;
    try {
      const r = await api(`/api/people/${id}`);
      if (my !== seq) return;
      person = r.person; items = r.items; status = 'ready';
    } catch (e) {
      if (my !== seq) return;
      status = e instanceof ApiError && e.status === 404 ? 'notfound' : 'error';
    }
  }

  $: shown = type === 'all' ? items : items.filter((i) => i.type === type);
  $: nMovies = items.filter((i) => i.type === 'Movie').length;
  $: nSeries = items.filter((i) => i.type === 'Series').length;
  $: chips = [['all', 'detail.person.all', items.length], ['Movie', 'detail.person.movies', nMovies], ['Series', 'detail.person.series', nSeries]] as Array<['all' | 'Movie' | 'Series', TKey, number]>;
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
</script>

<svelte:head><title>{$t('common.pageTitle', { page: person?.name ?? $t('detail.person.pageTitle') })}</title></svelte:head>
<div class="wrap">
{#if status === 'loading'}
  <div class="head" aria-busy="true"><span class="sr-only" role="status">{$t('detail.person.loading')}</span><div class="skeleton av"></div><div class="info"><div class="skeleton" style="height:2rem;width:60%"></div><div class="skeleton" style="height:4rem;margin-top:1rem"></div></div></div>
  <div class="tiles">{#each Array(8) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if status === 'notfound'}
  <div class="empty"><h1>{$t('detail.person.notFound')}</h1><p class="muted">{$t('detail.person.notFoundText')}</p><a class="btn" href="/search">{$t('detail.person.toSearch')}</a></div>
{:else if status === 'error' || !person}
  <div class="empty" role="alert"><h1>{$t('detail.person.loadFailed')}</h1><button type="button" on:click={() => load($page.params.id ?? '')}>{$t('detail.person.retry')}</button></div>
{:else}
  <div class="head">
    <div class="av">{#if person.image}<img src={img(person.id, 300)} alt="" width="150" height="150" />{:else}<span aria-hidden="true">{initials(person.name)}</span>{/if}</div>
    <div class="info">
      <h1>{person.name}</h1>
      {#if person.birthYear}<p class="muted">{$t('detail.person.born', { year: String(person.birthYear) })}</p>{/if}
      {#if person.overview}
        <p id="bio" class="bio" class:clamp={!more}>{person.overview}</p>
        <button type="button" class="sec small" aria-expanded={more} aria-controls="bio" on:click={() => (more = !more)}>{more ? $t('detail.person.less') : $t('detail.person.more')}</button>
      {/if}
      <p><a class="btn sec" href="/browse/movies?person={person.id}">{$t('detail.person.browseMovies')}</a></p>
    </div>
  </div>
  <div class="flex chips" role="group" aria-label={$t('detail.person.type')}>
    {#each chips as [k, label, n]}<button type="button" class="chip" class:on={type === k} aria-pressed={type === k} on:click={() => (type = k)}>{$t(label)} <span class="muted">{n}</span></button>{/each}
  </div>
  {#if shown.length}
    <div class="tiles">{#each shown as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
  {:else}<p class="muted">{$t('detail.person.none')}</p>{/if}
{/if}
</div>

<style>
  .wrap { padding-bottom: 1rem; }
  .empty { text-align: center; padding: 4rem 0; }
  .head { display: flex; gap: 1.5rem; align-items: flex-start; margin-bottom: 1.5rem; }
  .av { flex: none; width: 150px; height: 150px; border-radius: 50%; overflow: hidden; background: var(--surface-2); display: grid; place-items: center; font-size: 3rem; font-weight: 700; color: var(--mut); }
  .av img { width: 100%; height: 100%; object-fit: cover; }
  .info { min-width: 0; flex: 1; max-width: 70ch; }
  .info h1 { margin-top: 0; }
  .bio { margin: 0 0 .5rem; white-space: pre-line; }
  .bio.clamp { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .small { padding: .3rem .9rem; font-size: .85rem; }
  .chips { margin-bottom: 1.5rem; }
  .chip { background: var(--surface-2); border-radius: 99px; padding: 0 1rem; font-weight: 500; }
  .chip:hover:not(:disabled) { background: #3a3a3a; }
  .chip.on { background: #fff; color: #000; } .chip.on .muted { color: #444; }
  @media (max-width: 560px) { .head { flex-direction: column; align-items: center; text-align: center; } .av { width: 120px; height: 120px; } }
</style>
