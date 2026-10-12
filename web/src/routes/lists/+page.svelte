<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { img } from '#lib/api';
  import { autofocus } from '#lib/actions';
  import { createList, loadLists, type ListSummary } from '#lib/lists';
  import { t, tr, type TKey } from '#lib/i18n';
  let lists: ListSummary[] | null = null, creating = false, name = '', err = '', busy = false, loadFailed = false, newBtn: HTMLButtonElement | undefined;
  async function load() {
    loadFailed = false;
    try { lists = await loadLists(); } catch { lists = null; loadFailed = true; }
  }
  onMount(() => { void load(); });
  async function cancel() { creating = false; name = ''; err = ''; await tick(); newBtn?.focus(); }
  async function create() {
    if (!name.trim() || busy) return;
    busy = true; err = '';
    try { const { id } = await createList(name.trim()); await goto(`/lists/${id}`); }
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
        </div>
        <div class="info">
          <strong>{l.name}</strong>
          <span class="badge">{$t(`social.lists.roles.${l.role}` as TKey)}</span>
          <div class="muted">{$t('social.lists.itemCount', { n: l.itemCount })} · {$t('social.lists.memberCount', { n: l.memberCount })}{l.role !== 'owner' ? ' · ' + $t('social.by', { name: l.owner.name }) : ''}</div>
        </div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .head { display: flex; gap: 1rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; margin-top: 1rem; }
  .list { display: block; background: var(--surface); border-radius: var(--radius); overflow: hidden; color: inherit; text-decoration: none; }
  .list:hover, .list:focus-visible { outline: 2px solid var(--acc); }
  .mosaic { display: grid; grid-template-columns: 1fr 1fr; aspect-ratio: 16 / 9; background: #1a1a1a; }
  .mosaic img, .mosaic span { width: 100%; height: 100%; object-fit: cover; display: block; background: #262626; }
  .info { padding: .7rem .8rem .9rem; }
  .badge { margin-left: .4rem; font-size: .72rem; border: 1px solid rgba(255,255,255,.4); padding: 0 .4rem; border-radius: 3px; }
  .muted { color: var(--mut); font-size: .85rem; margin-top: .25rem; }
  .err { color: var(--err, #e5646e); }
  .state { padding: 1rem 0 2rem; }
</style>
