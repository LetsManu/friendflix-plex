<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import { api, backdrop, img, srcset, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { cardTag } from '#lib/badges';
  import { badges, wantBadge } from '#lib/fresh';
  import { isSpoiler } from '#lib/spoiler';
  import { listIds, prefs, toggleList } from '#lib/stores';
  import { dialogKeys } from '#lib/actions';
  import { openPreview } from '#lib/previewSheet';
  import { itemPath, playPath } from '#lib/mobile';
  import { t, tr } from '#lib/i18n';

  /** Phone card: 2:3 poster (tap opens the preview sheet) or, with `landscape`, a 16:9 "Weiterschauen" card with ⓘ and ⋯ bar. */
  export let item: Item;
  export let landscape = false;
  /** eager + high priority image (first visible row of the home page) */
  export let priority = false;
  /** shows "Aus Weiterschauen entfernen" in the ⋯ sheet; emits `remove` */
  export let removable = false;
  const dispatch = createEventDispatcher<{ remove: Item }>();

  const POSTER_WIDTHS = [200, 320, 480] as const;
  $: posterId = item.type === 'Episode' && item.seriesId ? item.seriesId : item.id;
  $: hasPoster = item.type === 'Episode' ? Boolean(item.seriesId) : item.image;
  $: wideKind = (item.backdrop ? 'Backdrop' : 'Primary') as 'Backdrop' | 'Primary';
  $: src = landscape ? (item.backdrop ? backdrop(item.id, 480) : item.image ? img(item.id, 480) : '') : hasPoster ? img(posterId, 320) : '';
  $: srcs = !src ? '' : landscape ? srcset(wideKind, item.id, [320, 480, 780]) : srcset('Primary', posterId, POSTER_WIDTHS);
  $: badgeId = item.type === 'Episode' ? item.seriesId : item.id;
  $: wantBadge(badgeId);
  $: tag = cardTag(badgeId ? $badges[badgeId] : undefined, item, Date.now());
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} · S${item.parentIndexNumber ?? '?'}:E${item.indexNumber ?? '?'}` : '';
  $: label = item.name + (sub ? ', ' + sub : '');
  $: inList = $listIds.has(item.seriesId ?? item.id);
  let fav = item.favorite;
  $: fav = item.favorite;

  function open(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new-tab clicks keep the plain link
    e.preventDefault();
    openPreview(item, e.currentTarget as HTMLElement);
  }

  // ---- ⋯ actions (landscape cards) ----
  let acts = false, actsEl: HTMLDivElement, moreBtn: HTMLButtonElement, note = '';
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  async function openActs() { acts = true; await tick(); actsEl?.querySelector<HTMLElement>('a[href],button')?.focus(); }
  function closeActs(refocus = true) { acts = false; if (refocus) moreBtn?.focus(); }
  async function toggleFav() {
    const want = !fav; fav = want;
    try { await api(`/api/items/${item.id}/favorite`, { method: want ? 'POST' : 'DELETE' }); } catch { fav = !want; }
  }
</script>

<article class="pc" class:landscape>
  <a class="thumb" href={landscape ? playPath(item) : itemPath(item)} aria-label={landscape ? $t('home.card.playName', { name: label }) : $t('home.card.openPreview', { name: label })} aria-haspopup={landscape ? undefined : 'dialog'} on:click={landscape ? undefined : open}>
    {#if src}
      <img class:spoil={isSpoiler(item, $prefs)} loading={priority ? 'eager' : 'lazy'} fetchpriority={priority ? 'high' : undefined} decoding="async" {src} srcset={srcs} sizes={landscape ? '45vw' : '32vw'} alt="" width={landscape ? 320 : 200} height={landscape ? 180 : 300} />
    {:else}<span class="noimg">{item.name}</span>{/if}
    {#if tag}<span class="newep" class:leave={tag.kind === 'leaving'}>{$t(tag.key, { n: tag.kind === 'leaving' ? tag.n : 0 })}</span>{/if}
    {#if landscape}<span class="playi" aria-hidden="true"><Icon name="play" size={20} /></span>{/if}
    {#if pct}<span class="progress"><i style="width:{pct}%"></i></span>{/if}
  </a>
  {#if landscape}
    <div class="pbar">
      <span class="t"><b>{item.type === 'Episode' ? item.seriesName ?? item.name : item.name}</b>{#if sub}<small>S{item.parentIndexNumber ?? '?'}:E{item.indexNumber ?? '?'}</small>{/if}</span>
      <button type="button" class="ib" aria-label={$t('home.card.detailsFor', { name: item.name })} aria-haspopup="dialog" on:click={(e) => openPreview(item, e.currentTarget)}><Icon name="info" size={22} /></button>
      <button type="button" class="ib" bind:this={moreBtn} aria-label={$t('home.card.actionsFor', { name: item.name })} aria-haspopup="dialog" aria-expanded={acts} on:click={openActs}><span aria-hidden="true" class="dots">⋯</span></button>
    </div>
  {/if}
</article>

{#if acts}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" use:portal on:click={() => closeActs()} role="presentation"></div>
  <div class="sheet" tabindex="-1" use:portal use:dialogKeys={{ close: () => closeActs() }} bind:this={actsEl} role="dialog" aria-modal="true" aria-label={$t('home.card.actionsFor', { name: item.name })}>
    <p class="st">{item.name}</p>
    <a class="act" href={playPath(item)} on:click={() => closeActs(false)}><Icon name="play" size={20} />{$t('home.card.play')}</a>
    <a class="act" href={itemPath(item)} on:click={() => closeActs(false)}><Icon name="info" size={20} />{$t('home.card.detailsMore')}</a>
    <button type="button" class="act" on:click={async () => { const ok = await toggleList(item.seriesId ?? item.id, inList); if (!ok) note = tr('home.card.saveFailed'); else closeActs(); }}><Icon name={inList ? 'check' : 'plus'} size={20} />{inList ? $t('home.card.removeFromList') : $t('home.card.addToList')}</button>
    <button type="button" class="act" aria-pressed={fav} on:click={() => { void toggleFav(); closeActs(); }}><Icon name="heart" size={20} fill={fav} />{fav ? $t('home.card.favRemove') : $t('home.card.favAdd')}</button>
    {#if removable}<button type="button" class="act" on:click={() => { dispatch('remove', item); closeActs(false); }}><Icon name="x" size={20} />{$t('home.card.removeResume')}</button>{/if}
    {#if note}<p class="err pad" role="status">{note}</p>{/if}
    <button type="button" class="act cancel" on:click={() => closeActs()}>{$t('common.close')}</button>
  </div>
{/if}

<style>
  .pc { position: relative; width: 100%; }
  .thumb { position: relative; display: block; overflow: hidden; border-radius: 4px; background: #1c2228; aspect-ratio: 2 / 3; -webkit-tap-highlight-color: transparent; }
  .landscape .thumb { aspect-ratio: 16 / 9; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb:active { opacity: .85; }
  .spoil { filter: blur(14px) saturate(.7); transform: scale(1.1); }
  .noimg { position: absolute; inset: 0; display: grid; place-items: center; padding: .5rem; text-align: center; font-weight: 700; font-size: .85rem; background: linear-gradient(160deg, #252c34, #161b21); overflow: hidden; }
  .newep { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); background: var(--acc-fill); color: #fff; font-size: .62rem; font-weight: 700; padding: .1rem .45rem; border-radius: 3px; white-space: nowrap; }
  .newep.leave { background: #b3261e; }
  .landscape .newep { left: 6px; transform: none; bottom: 10px; }
  .playi { position: absolute; left: 50%; top: 50%; width: 38px; height: 38px; margin: -19px 0 0 -19px; border-radius: 50%; border: 2px solid rgba(255,255,255,.85); background: rgba(0,0,0,.5); display: grid; place-items: center; padding-left: 2px; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.3); }
  .progress i { display: block; height: 100%; background: var(--acc); }
  .pbar { display: flex; align-items: center; gap: 0; background: #1b2127; border-radius: 0 0 4px 4px; margin-top: -2px; padding-left: .5rem; }
  .t { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; font-size: .78rem; }
  .t b, .t small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t small { color: var(--mut); font-size: .7rem; }
  .ib { flex: none; width: 44px; min-height: 44px; padding: 0; background: transparent; color: #fff; border-radius: 50%; }
  .ib:hover:not(:disabled) { background: rgba(255,255,255,.1); }
  .dots { font-size: 1.5rem; line-height: 1; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 84; }
  .sheet { outline: none; position: fixed; z-index: 85; left: 0; right: 0; bottom: 0; max-width: 560px; margin: 0 auto; background: var(--surface); border-radius: 14px 14px 0 0; padding: .6rem .6rem calc(.6rem + env(safe-area-inset-bottom)); box-shadow: 0 -10px 40px rgba(0,0,0,.7); display: flex; flex-direction: column; gap: .1rem; }
  .st { margin: .2rem 1rem .5rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act { display: flex; gap: .8rem; align-items: center; min-height: 48px; padding: 0 1rem; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; font-weight: 500; text-align: left; width: 100%; }
  .act:hover, .act:focus-visible { background: rgba(255,255,255,.08); }
  .cancel { justify-content: center; margin-top: .3rem; border-top: 1px solid #242b33; border-radius: 0 0 8px 8px; color: var(--mut); }
  .pad { margin: .3rem 1rem; }
</style>
