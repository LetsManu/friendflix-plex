<script lang="ts">
  import { t, tr, fmtDate, fmtTime } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api, img, backdrop, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { dialogKeys } from '#lib/actions';
  import { removeFromHistory, restoreRemoved } from '#lib/historyOps';

  let items: Item[] | null = null;
  let asking: Item | null = null, error = '', opener: HTMLElement | null = null;
  onMount(() => { api('/api/history?limit=200').then((r) => (items = r.items)).catch(() => (items = [])); });

  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function label(iso?: string) {
    if (!iso) return tr('social.history.earlier');
    const d = new Date(iso), diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
    if (diff <= 0) return tr('social.history.today');
    if (diff === 1) return tr('social.history.yesterday');
    return fmtDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  $: groups = (items ?? []).reduce<Array<{ label: string; items: Item[] }>>((acc, i) => {
    const l = label(i.lastPlayedDate), g = acc[acc.length - 1];
    if (g && g.label === l) g.items.push(i); else acc.push({ label: l, items: [i] });
    return acc;
  }, []);
  const sub = (i: Item) => (i.type === 'Episode' ? `${i.seriesName ?? ''} · ${tr('social.episodeCode', { s: i.parentIndexNumber ?? '?', e: i.indexNumber ?? '?' })}` : i.year ? String(i.year) : '');
  const time = (iso?: string) => fmtTime(iso);

  async function remove(i: Item, scope: 'item' | 'series') {
    closeAsk(false); error = '';
    const before = items ?? [], { kept, removed } = removeFromHistory(before, i, scope);
    items = kept;
    try { await api(`/api/history/${i.id}?scope=${scope}`, { method: 'DELETE' }); }
    catch { items = restoreRemoved(items ?? [], removed, before); error = tr('social.history.removeFailed'); } // only this removal is undone, concurrent ones stay
  }
  function ask(i: Item, e: Event) { if (i.type === 'Episode' && i.seriesId) { opener = e.currentTarget as HTMLElement; asking = i; } else void remove(i, 'item'); }
  /** closes the dialog; focus goes back to the button that opened it (it may be gone after a removal) */
  function closeAsk(restore = true) {
    asking = null;
    if (restore) opener?.focus();
    opener = null;
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('social.history.title') })}</title></svelte:head>
<h1>{$t('social.history.title')}</h1>
{#if error}<p class="err" role="alert">{error}</p>{/if}
{#if items === null}<div class="skeleton" style="height:12rem"></div>
{:else if !items.length}<p class="muted">{$t('social.history.empty')}</p>
{:else}
  {#each groups as g (g.label)}
    <section>
      <h2>{g.label}</h2>
      <ul>
        {#each g.items as i (i.id)}
          <li>
            <a class="thumb" href={i.type === 'Episode' ? `/watch/${i.id}` : `/item/${i.id}`} aria-label={i.name}>
              {#if i.backdrop}<img loading="lazy" src={backdrop(i.id, 320)} alt="" />{:else if i.image}<img loading="lazy" src={img(i.id, 320)} alt="" />{/if}
            </a>
            <div class="txt">
              <strong>{i.name}</strong>
              <span class="muted">{sub(i)}</span>
              <span class="muted">{time(i.lastPlayedDate)}{i.positionTicks && !i.played ? ' · ' + $t('social.history.started') : ''}</span>
            </div>
            <button class="rm" aria-label={$t('social.history.remove')} title={$t('social.history.remove')} on:click={(e) => ask(i, e)}><Icon name="x" size={18} /></button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

{#if asking}
  {@const a = asking}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="dlg" on:click|self={() => closeAsk()}>
    <div class="box" role="dialog" aria-modal="true" aria-labelledby="ask-t" use:dialogKeys={{ close: closeAsk, focusFirst: true }}>
      <p id="ask-t">{$t('social.history.confirm', { name: a.name })}</p>
      <div class="btns">
        <button on:click={() => remove(a, 'item')}>{$t('social.history.onlyEpisode')}</button>
        <button on:click={() => remove(a, 'series')}>{$t('social.history.wholeSeries')}</button>
        <button class="ghost" on:click={() => closeAsk()}>{$t('common.cancel')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  h2 { font-size: 1.05rem; margin: 1.6rem 0 .5rem; color: var(--mut); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  li { display: flex; align-items: center; gap: .8rem; background: var(--surface); border-radius: var(--radius); padding: .4rem .6rem .4rem .4rem; }
  .thumb { flex: 0 0 8rem; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; background: #222; display: block; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .txt { flex: 1; min-width: 0; display: grid; gap: .1rem; }
  .txt strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rm { width: 44px; height: 44px; min-height: 44px; flex: none; padding: 0; border-radius: 50%; display: grid; place-items: center; background: transparent; border: 1.5px solid rgba(255,255,255,.4); color: #fff; }
  .err { color: var(--err, #e5484d); }
  .dlg { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: grid; place-items: center; z-index: 100; padding: 1rem; }
  .box { background: var(--surface); border-radius: var(--radius); padding: 1.2rem; max-width: 26rem; width: 100%; }
  .btns { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }
  @media (max-width: 520px) { .thumb { flex-basis: 6rem; } }
</style>
