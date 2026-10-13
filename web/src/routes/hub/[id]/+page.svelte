<script lang="ts">
  import { pageStore } from '#lib/page';
  import { api, ApiError, backdrop, srcset, HERO_WIDTHS, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import Row from '#lib/Row.svelte';
  import { hubGlow, hubGradient, type Hub } from '#lib/hubs';
  import { t } from '#lib/i18n';

  interface HubRowData { key: 'new' | 'popular' | 'movies' | 'series'; items: Item[] }
  interface HubData { hub: Hub; total: number; featured?: Item; rows: HubRowData[] }
  const page = pageStore();
  const PAGE = 40;
  $: id = $page.params.id!;
  let data: HubData | null = null, missing = false, failed = false, seq = 0;
  let az: Item[] = [], azTotal = 0, azType: 'Movie,Series' | 'Movie' | 'Series' = 'Movie,Series', azBusy = false, azFailed = false, azSeq = 0;

  async function load(want: string) {
    const my = ++seq;
    data = null; missing = false; failed = false; az = []; azTotal = 0; azType = 'Movie,Series'; azFailed = false;
    try {
      const r = await api<HubData>(`/api/hubs/${want}`);
      if (my !== seq) return;
      data = r;
      void more(true);
    } catch (e) {
      if (my !== seq) return;
      if (e instanceof ApiError && e.status === 404) missing = true; else failed = true;
    }
  }
  $: if (id) void load(id);

  async function more(reset = false) {
    if (azBusy && !reset) return;
    const my = reset ? ++azSeq : azSeq;
    azBusy = true; azFailed = false;
    if (reset) { az = []; azTotal = 0; }
    try {
      const r = await api(`/api/hubs/${id}/items?${new URLSearchParams({ start: String(reset ? 0 : az.length), limit: String(PAGE), types: azType })}`);
      if (my !== azSeq) return;
      az = reset ? r.items : [...az, ...r.items]; azTotal = r.total;
    } catch { if (my === azSeq) azFailed = true; }
    if (my === azSeq) azBusy = false;
  }
  function setType(v: typeof azType) { azType = v; void more(true); }

  const rowTitle = (r: HubRowData, name: string) => r.key === 'new' ? $t('hubs.page.new', { name }) : r.key === 'popular' ? $t('hubs.page.popular', { name }) : r.key === 'movies' ? $t('hubs.page.movies') : $t('hubs.page.series');
  let heroOk = true;
  $: feat = data?.featured;
  $: if (feat) heroOk = true;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: data?.hub.name ?? $t('hubs.strip.label') })}</title></svelte:head>

{#if data}
  <header class="head" style="--hb:{hubGradient(data.hub)};--glow:{hubGlow(data.hub)}">
    {#if feat?.backdrop && heroOk}<img class="bd" src={backdrop(feat.id, 1600)} srcset={srcset('Backdrop', feat.id, HERO_WIDTHS)} sizes="100vw" alt="" decoding="async" on:error={() => (heroOk = false)} />{/if}
    <div class="fade" aria-hidden="true"></div>
    <div class="cap">
      <h1>{data.hub.name}</h1>
      <p class="muted">{$t('hubs.page.count', { n: data.total })}</p>
    </div>
  </header>
  <div class="rows">
    {#each data.rows as r (r.key)}<Row title={rowTitle(r, data.hub.name)} items={r.items} />{/each}
    <section class="az" aria-labelledby="az-h">
      <div class="azh">
        <h2 id="az-h">{$t('hubs.page.az')}</h2>
        <div class="seg" role="group" aria-label={$t('hubs.page.filter')}>
          {#each [['Movie,Series', 'hubs.page.all'], ['Movie', 'hubs.page.movies'], ['Series', 'hubs.page.series']] as [v, k]}
            <button type="button" class="sec" aria-pressed={azType === v} on:click={() => setType(v as typeof azType)}>{$t(k as 'hubs.page.all')}</button>
          {/each}
        </div>
      </div>
      <div class="tiles">{#each az as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
      {#if azBusy}<p class="muted" role="status">{$t('hubs.page.loading')}</p>{/if}
      {#if azFailed}<p class="err" role="alert">{$t('hubs.page.loadFailed')} <button type="button" class="sec" on:click={() => more(!az.length)}>{$t('hubs.page.retry')}</button></p>{/if}
      {#if !azBusy && !azFailed && az.length < azTotal}<p><button type="button" class="sec" on:click={() => more()}>{$t('hubs.page.more')}</button></p>{/if}
    </section>
  </div>
{:else if missing}
  <div class="page"><p class="muted">{$t('hubs.page.missing')}</p><p><a class="btn" href="/">{$t('hubs.page.home')}</a></p></div>
{:else if failed}
  <div class="page"><p class="err" role="alert">{$t('hubs.page.loadFailed')} <button type="button" class="sec" on:click={() => load(id)}>{$t('hubs.page.retry')}</button></p></div>
{:else}
  <div class="head sk" aria-busy="true"><div class="skeleton fill"></div></div>
  <p class="sr-only" role="status">{$t('hubs.page.loading')}</p>
{/if}

<style>
  .head { position: relative; overflow: hidden; background-image: var(--hb); min-height: clamp(220px, 34vw, 440px); display: flex; align-items: flex-end; }
  .head.sk { background: none; }
  .fill { position: absolute; inset: 0; border-radius: 0; }
  .bd { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; }
  .fade { position: absolute; inset: 0; background: linear-gradient(to top, var(--bg) 2%, rgba(0, 0, 0, 0) 60%), linear-gradient(77deg, rgba(0, 0, 0, .55), transparent 60%); box-shadow: inset 0 -90px 90px -60px var(--glow); pointer-events: none; }
  .cap { position: relative; z-index: 1; padding: calc(var(--nav-total) + 1.5rem) var(--pad-x) 1.6rem; }
  h1 { margin: 0; font-size: clamp(1.9rem, 4.6vw, 3.6rem); font-weight: 800; letter-spacing: -.02em; line-height: 1.05; text-shadow: 0 2px 14px rgba(0, 0, 0, .7); }
  .cap p { margin: .3rem 0 0; text-shadow: 0 1px 8px #000; }
  .rows { position: relative; z-index: 2; padding-bottom: 5rem; }
  .az { padding: 2.2rem var(--pad-x) 0; }
  .azh { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
  .azh h2 { margin: 0; font-size: clamp(1.05rem, .55vw + .8rem, 1.45rem); }
  .seg { display: flex; gap: .4rem; flex-wrap: wrap; }
  .seg button { border-radius: 99px; padding: .4rem 1rem; }
  .seg button[aria-pressed='true'] { background: #fff; color: #000; }
  .az .tiles { padding-bottom: 1.5rem; }
</style>
