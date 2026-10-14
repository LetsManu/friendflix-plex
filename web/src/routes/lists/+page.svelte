<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { img } from '#lib/api';
  import { autofocus } from '#lib/actions';
  import { api } from '#lib/api';
  import { COVER_COLORS, coverGradient, createList, loadLists, loadManagedThemed, moveItem, orderThemed, pinThemed, type ListSummary, type ManagedThemed } from '#lib/lists';
  import { t, tr, type TKey } from '#lib/i18n';
  let themed = false, emoji = '', color = '', managed: ManagedThemed[] = [], maxPinned = 5, manageMsg = '', manageBusy = false;
  let lists: ListSummary[] | null = null, creating = false, name = '', err = '', busy = false, loadFailed = false, newBtn: HTMLButtonElement | undefined;
  async function load() {
    loadFailed = false;
    try { lists = await loadLists(); } catch { lists = null; loadFailed = true; }
  }
  onMount(() => {
    void load();
    // admins (main profile) also manage which themed lists sit on the home page
    api('/api/me').then((r) => { if (r.isAdmin && r.profile?.isOwner) void loadManage(); }).catch(() => undefined);
  });
  async function loadManage() { try { const r = await loadManagedThemed(); managed = r.lists; maxPinned = r.max; } catch { managed = []; } }
  async function pin(l: ManagedThemed) {
    if (manageBusy) return;
    manageBusy = true; manageMsg = '';
    try { await pinThemed(l.id, !l.pinned); } catch (e: any) { manageMsg = e?.body?.error === 'too_many_featured' ? tr('mine.themed.tooManyPinned') : tr('common.failed'); }
    await loadManage(); manageBusy = false;
  }
  async function move(i: number, d: number) {
    if (manageBusy) return;
    const pinned = managed.filter((m) => m.pinned);
    if (i + d < 0 || i + d >= pinned.length) return;
    manageBusy = true; manageMsg = '';
    const next = moveItem(pinned, i, i + d);
    managed = [...next, ...managed.filter((m) => !m.pinned)];
    try { await orderThemed(next.map((m) => m.id)); } catch { manageMsg = tr('common.failed'); }
    await loadManage(); manageBusy = false;
  }
  async function cancel() { creating = false; name = ''; themed = false; emoji = ''; color = ''; err = ''; await tick(); newBtn?.focus(); }
  async function create() {
    if (!name.trim() || busy) return;
    busy = true; err = '';
    try { const { id } = await createList(name.trim(), undefined, themed ? { themed: true, emoji: emoji.trim() || undefined, coverColor: color || undefined } : undefined); await goto(`/lists/${id}`); }
    catch (e: any) { err = e?.body?.error === 'too_many_lists' ? tr('social.lists.tooMany') : tr('common.failed'); }
    busy = false;
  }
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('social.lists.title') })}</title></svelte:head>
<div class="head"><h1>{$t('social.lists.title')}</h1>
  {#if creating}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form on:submit|preventDefault={create} on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void cancel(); } }}>
      <input type="text" maxlength="60" placeholder={$t('social.lists.name')} aria-label={$t('social.lists.name')} bind:value={name} use:autofocus />
      <label class="themedchk"><input type="checkbox" bind:checked={themed} />{$t('mine.themed.mark')}</label>
      {#if themed}
        <input type="text" class="emo-in" maxlength="8" aria-label={$t('mine.themed.emoji')} placeholder={$t('mine.themed.emojiPlaceholder')} bind:value={emoji} />
        <div class="swatches" role="radiogroup" aria-label={$t('mine.themed.color')}>
          {#each COVER_COLORS as c (c)}<button type="button" class="sw" class:on={color === c} role="radio" aria-checked={color === c} aria-label={c} style:background={c} on:click={() => (color = color === c ? '' : c)}></button>{/each}
        </div>
      {/if}
      <button type="submit" disabled={busy || !name.trim()}>{$t('social.lists.create')}</button>
      <button type="button" class="sec" on:click={cancel}>{$t('common.cancel')}</button>
    </form>
  {:else}<button bind:this={newBtn} on:click={() => { err = ''; creating = true; }}>{$t('social.lists.newList')}</button>{/if}
</div>
{#if err}<p class="err" role="alert">{err}</p>{/if}
<p class="muted">{$t('social.lists.intro')}</p>
{#if loadFailed}<div class="state" role="alert"><p class="err">{$t('social.lists.loadFailed')}</p><button type="button" on:click={load}>{$t('social.tryAgain')}</button></div>
{:else if lists === null}<div class="grid">{#each Array(4) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if !lists.length}<p class="muted">{$t('social.lists.empty')}</p>
{:else}
  <div class="grid">
    {#each lists as l (l.id)}
      <a class="list" href="/lists/{l.id}">
        <div class="mosaic" aria-hidden="true">
          {#each [0, 1, 2, 3] as n}
            {#if l.coverIds[n]}<img src={img(l.coverIds[n], 200)} alt="" loading="lazy" />{:else}<span></span>{/if}
          {/each}
          {#if l.themed}<span class="tcover" style:background={coverGradient(l.coverColor)}>{l.emoji ?? ''}</span>{/if}
        </div>
        <div class="info">
          <strong>{#if l.emoji}<span aria-hidden="true">{l.emoji} </span>{/if}{l.name}</strong>
          {#if l.themed}<span class="badge">{$t('mine.themed.eyebrow')}</span>{/if}
          <span class="badge">{$t(`social.lists.roles.${l.role}` as TKey)}</span>
          <div class="muted">{$t('social.lists.itemCount', { n: l.itemCount })} · {$t('social.lists.memberCount', { n: l.memberCount })}{l.role !== 'owner' ? ' · ' + $t('social.by', { name: l.owner.name }) : ''}</div>
        </div>
      </a>
    {/each}
  </div>
{/if}

{#if managed.length}
  <section class="manage" aria-labelledby="mgh">
    <h2 id="mgh">{$t('mine.themed.manageTitle')}</h2>
    <p class="muted">{$t('mine.themed.manageHint', { max: maxPinned })}</p>
    <p role="status" aria-live="polite" class="err">{manageMsg}</p>
    <ul>
      {#each managed as m, i (m.id)}
        <li class="panel">
          <a href="/lists/{m.id}"><b>{m.emoji ?? ''} {m.name}</b></a>
          <span class="muted">{$t('admin.lists.meta', { name: m.owner.name, n: m.itemCount })}</span>
          <span class="acts">
            {#if m.pinned}
              <button type="button" class="sec" disabled={manageBusy || i === 0} aria-label={$t('mine.themed.moveUp', { name: m.name })} on:click={() => move(i, -1)}>↑</button>
              <button type="button" class="sec" disabled={manageBusy || !managed[i + 1]?.pinned} aria-label={$t('mine.themed.moveDown', { name: m.name })} on:click={() => move(i, 1)}>↓</button>
            {/if}
            <button type="button" class:sec={!m.pinned} aria-pressed={m.pinned} disabled={manageBusy} on:click={() => pin(m)}>{m.pinned ? $t('mine.themed.unpin') : $t('mine.themed.pin')}<span class="sr-only">: {m.name}</span></button>
          </span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .head { display: flex; gap: 1rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; margin-top: 1rem; }
  .list { display: block; background: var(--surface); border-radius: var(--radius); overflow: hidden; color: inherit; text-decoration: none; }
  .list:hover, .list:focus-visible { outline: 2px solid var(--acc); }
  .mosaic { display: grid; grid-template-columns: 1fr 1fr; aspect-ratio: 16 / 9; background: #151a20; }
  .mosaic img, .mosaic span { width: 100%; height: 100%; object-fit: cover; display: block; background: #20262d; }
  .info { padding: .7rem .8rem .9rem; }
  .badge { margin-left: .4rem; font-size: .72rem; border: 1px solid rgba(255,255,255,.4); padding: 0 .4rem; border-radius: 3px; }
  .muted { color: var(--mut); font-size: .85rem; margin-top: .25rem; }
  .err { color: var(--err, #e5646e); }
  .themedchk { display: flex; align-items: center; gap: .5rem; flex-basis: 100%; }
  .emo-in { width: 5rem; text-align: center; font-size: 1.2rem; }
  .swatches { display: flex; gap: .45rem; flex-wrap: wrap; align-items: center; }
  .sw { width: 32px; height: 32px; min-height: 32px; padding: 0; border-radius: 50%; border: 2px solid transparent; }
  .sw.on { border-color: #fff; box-shadow: 0 0 0 2px var(--acc, #ff4f6d); }
  .mosaic { position: relative; }
  .mosaic .tcover { position: absolute; inset: auto 0 0 auto; width: auto; height: auto; padding: .15rem .55rem; border-radius: 8px 0 0 0; font-size: 1.3rem; line-height: 1.4; }
  .manage { margin-top: 2.5rem; max-width: 760px; } .manage h2 { margin: 0 0 .3rem; font-size: 1.15rem; }
  .manage ul { list-style: none; padding: 0; margin: .6rem 0 0; display: grid; gap: .6rem; }
  .manage li { display: flex; gap: .7rem; align-items: center; flex-wrap: wrap; } .manage li .acts { margin-left: auto; display: flex; gap: .4rem; }
  .manage button { min-height: 44px; }
  .state { padding: 1rem 0 2rem; }
</style>
