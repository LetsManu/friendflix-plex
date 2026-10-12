<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, img, type Item } from '#lib/api';
  import { hubGradient } from '#lib/hubs';
  import { t, tr, type TKey } from '#lib/i18n';

  type Source = 'studio' | 'collection' | 'tag' | 'genre';
  interface AdminHub { id: string; name: string; source: Source; sourceValue: string; accent?: string; imageUrl?: string; imageItemId?: string; enabled: boolean }
  interface Suggestion { name: string; count: number; source: Source; sourceValue: string; used: boolean }
  const SOURCES: Source[] = ['genre', 'studio', 'collection', 'tag'];

  let hubs: AdminHub[] | null = null, max = 8, failed = false, msg = '', err = '', busy = '';
  let suggestions: Suggestion[] | null = null;
  /** form state: editing = id of the hub being edited, '' = a new one, null = closed */
  let editing: string | null = null;
  let name = '', source: Source = 'genre', value = '', accentOn = false, accent = '#e50f2a', enabled = true, imageId = '', imageName = '';
  let q = '', results: Item[] = [], searchSeq = 0, searchT: ReturnType<typeof setTimeout>;

  async function load() {
    try { const r = await api('/api/admin/hubs'); hubs = r.hubs; max = r.max; failed = false; } catch { hubs = []; failed = true; }
  }
  async function loadSuggestions() {
    try { suggestions = (await api('/api/admin/hubs/suggestions')).suggestions; } catch { suggestions = []; }
  }
  onMount(() => { void load(); void loadSuggestions(); });

  $: collections = (suggestions ?? []).filter((s) => s.source === 'collection');
  $: ideas = (suggestions ?? []).slice(0, 60);
  $: if (source === 'collection' && !value && collections.length === 1) value = collections[0]!.sourceValue;

  function open(h?: AdminHub, s?: Suggestion) {
    msg = ''; err = '';
    editing = h?.id ?? '';
    name = h?.name ?? s?.name ?? ''; source = h?.source ?? s?.source ?? 'genre'; value = h?.sourceValue ?? s?.sourceValue ?? '';
    accentOn = Boolean(h?.accent); accent = h?.accent ?? '#e50f2a'; enabled = h?.enabled ?? true;
    imageId = h?.imageItemId ?? ''; imageName = ''; q = ''; results = [];
    if (s?.source === 'collection') imageId = '';
  }
  const close = () => { editing = null; };

  function search() {
    clearTimeout(searchT);
    const term = q.trim();
    if (term.length < 2) { results = []; return; }
    const my = ++searchSeq;
    searchT = setTimeout(async () => {
      try { const r = await api(`/api/library/items?${new URLSearchParams({ q: term, types: 'Movie,Series,BoxSet', limit: '6' })}`); if (my === searchSeq) results = r.items; } catch { if (my === searchSeq) results = []; }
    }, 250);
  }
  const pick = (i: Item) => { imageId = i.id; imageName = i.name; q = ''; results = []; };

  const errText = (e: unknown) => e instanceof ApiError && e.status === 409 ? tr('hubs.admin.tooMany', { max }) : e instanceof ApiError && e.body?.error === 'bad_source' ? tr('hubs.admin.badSource') : tr('common.failed');
  async function save() {
    if (busy) return;
    busy = 'save'; err = ''; msg = '';
    const body = { name, source, sourceValue: value, accent: accentOn ? accent : null, imageItemId: imageId || null, enabled };
    try {
      if (editing) await api(`/api/admin/hubs/${editing}`, { method: 'PUT', body }); else await api('/api/admin/hubs', { method: 'POST', body });
      msg = tr('hubs.admin.saved', { name }); editing = null;
      await Promise.all([load(), loadSuggestions()]);
    } catch (e) { err = errText(e); }
    busy = '';
  }
  async function remove(h: AdminHub) {
    if (busy || !confirm(tr('hubs.admin.confirmRemove', { name: h.name }))) return;
    busy = h.id; err = ''; msg = '';
    try { await api(`/api/admin/hubs/${h.id}`, { method: 'DELETE' }); msg = tr('hubs.admin.removed', { name: h.name }); await Promise.all([load(), loadSuggestions()]); } catch (e) { err = errText(e); }
    busy = '';
  }
  async function move(i: number, d: -1 | 1) {
    if (busy || !hubs) return;
    const list = [...hubs]; const [h] = list.splice(i, 1); list.splice(i + d, 0, h!);
    busy = 'order'; err = ''; msg = '';
    try { await api('/api/admin/hubs/order', { method: 'PUT', body: { ids: list.map((x) => x.id) } }); hubs = list; } catch (e) { err = errText(e); }
    busy = '';
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('hubs.admin.pageTitle') })}</title></svelte:head>
<h2>{$t('hubs.admin.title')}</h2>
<p class="muted">{$t('hubs.admin.intro', { max, count: hubs?.length ?? 0 })}</p>
<div role="status" aria-live="polite" class="msg">{#if msg}<span class="ok">{msg}</span>{/if}</div>
{#if err}<p class="err" role="alert">{err}</p>{/if}

{#if hubs === null}<p class="muted">{$t('hubs.admin.loading')}</p>
{:else if failed}<p class="err" role="alert">{$t('hubs.admin.loadFailed')} <button type="button" class="sec" on:click={load}>{$t('admin.tryAgain')}</button></p>
{:else}
  {#if !hubs.length}<p class="muted">{$t('hubs.admin.empty')}</p>{/if}
  <ul class="ls">
    {#each hubs as h, i (h.id)}
      <li class="panel">
        <span class="sw" style="background-image:{hubGradient(h)}" aria-hidden="true">{#if h.imageUrl}<img src={h.imageUrl} alt="" loading="lazy" />{/if}</span>
        <div class="info"><b>{h.name}</b> <span class="badge">{$t(`hubs.admin.sources.${h.source}` as TKey)}</span>{#if !h.enabled} <span class="badge">{$t('hubs.admin.hidden')}</span>{/if}<br /><span class="muted small">{h.source === 'collection' ? $t('hubs.admin.collection') : h.sourceValue}</span></div>
        <div class="acts">
          <button type="button" class="sec" disabled={i === 0 || Boolean(busy)} aria-label={$t('hubs.admin.up', { name: h.name })} on:click={() => move(i, -1)}>↑</button>
          <button type="button" class="sec" disabled={i === hubs.length - 1 || Boolean(busy)} aria-label={$t('hubs.admin.down', { name: h.name })} on:click={() => move(i, 1)}>↓</button>
          <button type="button" class="sec" on:click={() => open(h)}>{$t('hubs.admin.edit')}<span class="sr-only">: {h.name}</span></button>
          <button type="button" class="sec" disabled={busy === h.id} aria-label={$t('hubs.admin.removeName', { name: h.name })} on:click={() => remove(h)}>{$t('hubs.admin.remove')}</button>
        </div>
      </li>
    {/each}
  </ul>
  {#if editing === null}
    <p><button type="button" disabled={hubs.length >= max} on:click={() => open()}>{$t('hubs.admin.add')}</button></p>
  {:else}
    <form class="panel form" on:submit|preventDefault={save}>
      <h3>{editing ? $t('hubs.admin.editTitle') : $t('hubs.admin.newTitle')}</h3>
      <label>{$t('hubs.admin.name')}<input bind:value={name} required maxlength="40" /></label>
      <label>{$t('hubs.admin.source')}
        <select bind:value={source} on:change={() => (value = '')}>{#each SOURCES as s}<option value={s}>{$t(`hubs.admin.sources.${s}` as TKey)}</option>{/each}</select>
      </label>
      {#if source === 'collection'}
        <label>{$t('hubs.admin.collection')}
          <select bind:value required><option value="" disabled>{$t('hubs.admin.collectionPick')}</option>{#each collections as c (c.sourceValue)}<option value={c.sourceValue}>{c.name}</option>{/each}</select>
        </label>
      {:else}
        <label>{$t('hubs.admin.value')}<input bind:value required maxlength="120" list="hub-values" /></label>
        <datalist id="hub-values">{#each (suggestions ?? []).filter((s) => s.source === source) as s}<option value={s.sourceValue}></option>{/each}</datalist>
        <p class="muted small">{$t('hubs.admin.valueHint')}</p>
      {/if}
      <div class="row">
        <label class="chk"><input type="checkbox" bind:checked={accentOn} />{$t('hubs.admin.accent')}</label>
        {#if accentOn}<input type="color" bind:value={accent} aria-label={$t('hubs.admin.accent')} />{:else}<span class="muted small">{$t('hubs.admin.accentAuto')}</span>{/if}
      </div>
      <div class="img">
        <label>{$t('hubs.admin.image')}<input type="search" bind:value={q} on:input={search} placeholder={$t('hubs.admin.imageSearch')} autocomplete="off" /></label>
        {#if results.length}
          <ul class="res">{#each results as r (r.id)}<li><button type="button" class="sec" on:click={() => pick(r)}>{#if r.image}<img src={img(r.id, 80)} alt="" />{/if}{r.name}</button></li>{/each}</ul>
        {/if}
        <p class="muted small">
          {#if imageId}{imageName ? $t('hubs.admin.imagePicked', { name: imageName }) : $t('hubs.admin.imagePicked', { name: imageId })} <button type="button" class="sec" on:click={() => (imageId = '')}>{$t('hubs.admin.imageClear')}</button>
          {:else}{$t('hubs.admin.imageNone')}{/if}
        </p>
      </div>
      <label class="chk"><input type="checkbox" bind:checked={enabled} />{$t('hubs.admin.enabled')}</label>
      <div class="row"><button type="submit" disabled={Boolean(busy)}>{$t('hubs.admin.save')}</button><button type="button" class="sec" on:click={close}>{$t('hubs.admin.cancel')}</button></div>
    </form>
  {/if}

  <h3>{$t('hubs.admin.suggestions')}</h3>
  {#if suggestions === null}<p class="muted">{$t('hubs.admin.suggestionsLoading')}</p>
  {:else if !ideas.length}<p class="muted">{$t('hubs.admin.suggestionsEmpty')}</p>
  {:else}
    <ul class="chips">
      {#each ideas as s (s.source + s.sourceValue)}
        <li><button type="button" class="sec chip" disabled={s.used || hubs.length >= max} aria-label={s.used ? `${s.name} (${$t('hubs.admin.used')})` : $t('hubs.admin.use', { name: s.name })} on:click={() => open(undefined, s)}>{s.name}<span class="badge">{$t(`hubs.admin.sources.${s.source}` as TKey)}</span>{#if s.used}<span aria-hidden="true">✓</span>{/if}</button></li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .msg { min-height: 1.4em; }
  .small { font-size: .85rem; margin: 0; }
  .ls, .chips, .res { list-style: none; padding: 0; margin: 0; }
  .ls { display: grid; gap: .6rem; margin-bottom: 1rem; }
  .ls li { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
  .sw { position: relative; flex: none; width: 96px; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background-size: cover; }
  .sw img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .info { flex: 1; min-width: 10rem; overflow-wrap: anywhere; }
  .acts { display: flex; gap: .4rem; flex-wrap: wrap; }
  .acts button { min-height: 44px; min-width: 44px; }
  .form { display: grid; gap: .8rem; max-width: 560px; }
  .form h3 { margin: 0; }
  .form label { display: grid; gap: .3rem; }
  .form label.chk { display: flex; align-items: center; gap: .5rem; }
  .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  input[type='color'] { padding: 0; width: 56px; cursor: pointer; }
  .res { display: grid; gap: .3rem; }
  .res button { width: 100%; justify-content: flex-start; text-align: left; }
  .res img { width: 40px; height: 24px; object-fit: cover; border-radius: 3px; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; }
  .chip { border-radius: 99px; }
  .chip :global(.badge) { background: rgba(0, 0, 0, .35); }
</style>
