<script lang="ts">
  /** Admin → Marken: brand tiles under the home billboard. Cards with a live tile preview, up/down reorder (keyboard), form on top. */
  import { onMount, tick } from 'svelte';
  import { api, ApiError, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { hubGradient } from '#lib/hubs';
  import { t, tr, type TKey } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { confirm } from '#lib/ui/confirm';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';

  type Source = 'studio' | 'collection' | 'tag' | 'genre';
  interface AdminHub { id: string; name: string; source: Source; sourceValue: string; accent?: string | null; imageUrl?: string; imageItemId?: string | null; enabled: boolean }
  interface Suggestion { name: string; count: number; source: Source; sourceValue: string; used: boolean }
  const SOURCES: Source[] = ['genre', 'studio', 'collection', 'tag'];
  const sourceLabel = (s: Source) => $t(`hubs.admin.sources.${s}` as TKey);

  let hubs: AdminHub[] | null = null, max = 8, failed = false;
  let suggestions: Suggestion[] | null = null;
  /** form state: editing = id of the hub being edited, '' = a new one, null = closed */
  let editing: string | null = null;
  let name = '', source: Source = 'genre', value = '', accentOn = false, accent = '#ff4f6d', enabled = true, imageId = '', imageName = '';
  let q = '', results: Item[] = [], searchSeq = 0, searchT: ReturnType<typeof setTimeout>;
  let formEl: HTMLElement | undefined;

  async function load() {
    failed = false;
    try { const r = await api<{ hubs: AdminHub[]; max: number }>('/api/admin/hubs'); hubs = r.hubs; max = r.max; } catch { hubs = []; failed = true; }
  }
  async function loadSuggestions() {
    try { suggestions = (await api<{ suggestions: Suggestion[] }>('/api/admin/hubs/suggestions')).suggestions; } catch { suggestions = []; }
  }
  onMount(() => { void load(); void loadSuggestions(); return () => clearTimeout(searchT); });

  $: collections = (suggestions ?? []).filter((s) => s.source === 'collection');
  $: ideas = (suggestions ?? []).slice(0, 60);
  $: valueIdeas = (suggestions ?? []).filter((s) => s.source === source);
  $: if (source === 'collection' && !value && collections.length === 1) value = collections[0]!.sourceValue;
  $: full = (hubs?.length ?? 0) >= max;
  $: saving = $busyKeys.has('hub:save');
  $: previewImage = imageId ? img(imageId, 480) : '';

  async function open(h?: AdminHub, s?: Suggestion) {
    editing = h?.id ?? '';
    name = h?.name ?? s?.name ?? ''; source = h?.source ?? s?.source ?? 'genre'; value = h?.sourceValue ?? s?.sourceValue ?? '';
    accentOn = Boolean(h?.accent); accent = h?.accent ?? '#ff4f6d'; enabled = h?.enabled ?? true;
    imageId = h?.imageItemId ?? ''; imageName = ''; q = ''; results = [];
    if (s?.source === 'collection') imageId = '';
    await tick();
    formEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    document.getElementById('hub-name')?.focus({ preventScroll: true });
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

  const errText = (e: unknown) => e instanceof ApiError && e.status === 409 ? tr('hubs.admin.tooMany', { max })
    : e instanceof ApiError && e.body?.error === 'bad_source' ? tr('hubs.admin.badSource') : errorText(e);
  const bodyOf = (h: Pick<AdminHub, 'name' | 'source' | 'sourceValue' | 'accent' | 'imageItemId' | 'enabled'>) =>
    ({ name: h.name, source: h.source, sourceValue: h.sourceValue, accent: h.accent ?? null, imageItemId: h.imageItemId ?? null, enabled: h.enabled });

  async function save() {
    const body = { name: name.trim(), source, sourceValue: value, accent: accentOn ? accent : null, imageItemId: imageId || null, enabled };
    const id = editing;
    const res = await runAction({
      key: 'hub:save', error: errText,
      run: () => (id ? api(`/api/admin/hubs/${id}`, { method: 'PUT', body }) : api('/api/admin/hubs', { method: 'POST', body })),
      success: tr('hubs.admin.saved', { name: body.name }),
    });
    if (res.ok) { editing = null; await Promise.all([load(), loadSuggestions()]); }
  }

  async function remove(h: AdminHub) {
    if (!(await confirm({ title: tr('hubs.admin.confirmRemove', { name: h.name }), body: tr('adminContent.hubs.removeBody'), danger: true, confirmLabel: tr('hubs.admin.remove') }))) return;
    const res = await runAction({
      key: `hub:${h.id}`, error: errText,
      apply: () => { const prev = hubs; hubs = (hubs ?? []).filter((x) => x !== h); return () => { hubs = prev; }; },
      run: () => api(`/api/admin/hubs/${h.id}`, { method: 'DELETE' }),
      success: tr('hubs.admin.removed', { name: h.name }),
    });
    if (res.ok) { if (editing === h.id) editing = null; void loadSuggestions(); }
  }

  async function move(i: number, d: -1 | 1) {
    if (!hubs) return;
    const h = hubs[i]!;
    const list = [...hubs]; list.splice(i, 1); list.splice(i + d, 0, h);
    const res = await runAction({
      key: 'hub:order', error: errText,
      apply: () => { const prev = hubs; hubs = list; return () => { hubs = prev; }; },
      run: () => api('/api/admin/hubs/order', { method: 'PUT', body: { ids: list.map((x) => x.id) } }),
      success: tr('adminContent.hubs.moved', { name: h.name, pos: i + d + 1 }),
    });
    if (res.ok) {
      await tick(); // the moved row keeps its buttons: put the focus back (the button may be disabled now at the list end)
      const want = document.getElementById(`hub-${h.id}-${d < 0 ? 'up' : 'down'}`) as HTMLButtonElement | null;
      (want && !want.disabled ? want : document.getElementById(`hub-${h.id}-${d < 0 ? 'down' : 'up'}`))?.focus();
    }
  }

  function setEnabled(h: AdminHub, next: boolean) {
    const put = (v: boolean) => api(`/api/admin/hubs/${h.id}`, { method: 'PUT', body: bodyOf({ ...h, enabled: v }) });
    void runAction({
      key: `hub:${h.id}`, error: errText,
      apply: () => { const prev = h.enabled; h.enabled = next; hubs = hubs; return () => { h.enabled = prev; hubs = hubs; }; },
      run: () => put(next),
      success: next ? tr('adminContent.hubs.shown', { name: h.name }) : tr('adminContent.hubs.hiddenToast', { name: h.name }),
      undo: { run: () => put(!next) },
    });
  }
</script>

<div class="top">
  <p class="intro muted">{$t('hubs.admin.intro', { max, count: hubs?.length ?? 0 })}</p>
  <div class="cap">
    <Progress value={hubs?.length ?? 0} {max} label={$t('adminContent.hubs.slots', { count: hubs?.length ?? 0, max })} tone={full ? 'warn' : 'acc'} />
  </div>
  {#if editing === null}
    <Button icon="plus" disabled={hubs === null || failed || full} on:click={() => open()}>{$t('hubs.admin.add')}</Button>
    {#if full}<p class="muted small">{$t('hubs.admin.tooMany', { max })}</p>{/if}
  {/if}
</div>

{#if editing !== null}
  <section class="form" bind:this={formEl} aria-labelledby="hub-form-title">
    <form on:submit|preventDefault={save}>
      <h2 id="hub-form-title">{editing ? $t('hubs.admin.editTitle') : $t('hubs.admin.newTitle')}</h2>
      <div class="fgrid">
        <div class="fields">
          <Field id="hub-name" label={$t('hubs.admin.name')} bind:value={name} required maxlength={40} />
          <Select label={$t('hubs.admin.source')} bind:value={source} options={SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))} on:change={() => (value = '')} />
          {#if source === 'collection'}
            <Select label={$t('hubs.admin.collection')} bind:value options={[{ value: '', label: $t('hubs.admin.collectionPick'), disabled: true }, ...collections.map((c) => ({ value: c.sourceValue, label: c.name }))]} />
          {:else}
            <Field label={$t('hubs.admin.value')} required hint={$t('hubs.admin.valueHint')} let:id let:describedby>
              <input {id} bind:value required maxlength="120" list="hub-values" aria-describedby={describedby} autocomplete="off" />
            </Field>
            <datalist id="hub-values">{#each valueIdeas as s (s.sourceValue)}<option value={s.sourceValue}></option>{/each}</datalist>
          {/if}
          <div class="accent">
            <Toggle label={$t('hubs.admin.accent')} bind:checked={accentOn} hint={accentOn ? undefined : $t('hubs.admin.accentAuto')} />
            {#if accentOn}<input class="color" type="color" bind:value={accent} aria-label={$t('hubs.admin.accent')} />{/if}
          </div>
          <Field label={$t('hubs.admin.image')} hint={imageId ? '' : $t('hubs.admin.imageNone')} let:id let:describedby>
            <input {id} type="search" bind:value={q} on:input={search} placeholder={$t('hubs.admin.imageSearch')} autocomplete="off" aria-describedby={describedby} />
          </Field>
          {#if results.length}
            <ul class="res">{#each results as r (r.id)}<li><button type="button" class="sec" on:click={() => pick(r)}>{#if r.image}<img src={img(r.id, 80)} alt="" />{/if}<span>{r.name}</span></button></li>{/each}</ul>
          {/if}
          {#if imageId}
            <p class="picked small muted">{imageName ? $t('hubs.admin.imagePicked', { name: imageName }) : $t('adminContent.hubs.imageSet')} <Button size="sm" variant="ghost" on:click={() => (imageId = '')}>{$t('hubs.admin.imageClear')}</Button></p>
          {/if}
          <Toggle label={$t('hubs.admin.enabled')} bind:checked={enabled} />
        </div>
        <div class="prev">
          <p class="plabel muted small" id="hub-prev">{$t('adminContent.hubs.preview')}</p>
          <div class="tile" role="img" aria-label={name || $t('adminContent.hubs.previewEmpty')} style="background-image:{hubGradient({ name: name || ' ', accent: accentOn ? accent : undefined })}">
            {#if previewImage}<img src={previewImage} alt="" />{/if}
            <span class="tn">{name || $t('adminContent.hubs.previewEmpty')}</span>
          </div>
        </div>
      </div>
      <div class="btns">
        <Button type="submit" icon="check" pending={saving}>{$t('hubs.admin.save')}</Button>
        <Button variant="ghost" disabled={saving} on:click={close}>{$t('hubs.admin.cancel')}</Button>
      </div>
    </form>
  </section>
{/if}

<AdminCard title={$t('hubs.admin.title')}>
  {#if hubs === null}
    <ul class="ls" aria-hidden="true">{#each [0, 1, 2] as i (i)}<li class="row"><Skeleton w="96px" h="54px" radius="6px" /><div class="info"><Skeleton w="40%" h="1rem" /><Skeleton w="25%" h=".8rem" /></div></li>{/each}</ul>
    <p class="sr-only" role="status">{$t('hubs.admin.loading')}</p>
  {:else if failed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('hubs.admin.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !hubs.length}
    <div class="state"><Icon name="star" size={22} /><p>{$t('hubs.admin.empty')}</p></div>
  {:else}
    <ul class="ls">
      {#each hubs as h, i (h.id)}
        {@const busy = $busyKeys.has(`hub:${h.id}`) || $busyKeys.has('hub:order')}
        <li class="row" class:off={!h.enabled} aria-busy={busy ? 'true' : undefined}>
          <span class="sw" style="background-image:{hubGradient({ name: h.name, accent: h.accent ?? undefined })}" aria-hidden="true">{#if h.imageUrl}<img src={h.imageUrl} alt="" loading="lazy" />{/if}</span>
          <div class="info">
            <b>{h.name}</b>
            <span class="meta"><StatusPill tone="muted" icon="" label={sourceLabel(h.source)} />{#if !h.enabled}<StatusPill tone="warn" icon="x" label={$t('hubs.admin.hidden')} />{/if}</span>
            <span class="muted small">{h.source === 'collection' ? $t('hubs.admin.collection') : h.sourceValue}</span>
          </div>
          <div class="acts">
            <Toggle hideLabel label={$t('adminContent.hubs.showName', { name: h.name })} checked={h.enabled} pending={$busyKeys.has(`hub:${h.id}`)} on:change={(e) => setEnabled(h, e.detail)} />
            <span class="mv">
              <button type="button" id="hub-{h.id}-up" class="ghost ic" disabled={i === 0 || busy} aria-label={$t('hubs.admin.up', { name: h.name })} on:click={() => move(i, -1)}><Icon name="arrow-up" size={20} /></button>
              <button type="button" id="hub-{h.id}-down" class="ghost ic" disabled={i === hubs.length - 1 || busy} aria-label={$t('hubs.admin.down', { name: h.name })} on:click={() => move(i, 1)}><Icon name="arrow-down" size={20} /></button>
            </span>
            <Button variant="secondary" size="sm" icon="settings" disabled={busy} on:click={() => open(h)}>{$t('hubs.admin.edit')}<span class="sr-only">: {h.name}</span></Button>
            <Button variant="danger" size="sm" icon="x" disabled={busy} aria-label={$t('hubs.admin.removeName', { name: h.name })} on:click={() => remove(h)}>{$t('hubs.admin.remove')}</Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</AdminCard>

<AdminCard title={$t('hubs.admin.suggestions')}>
  {#if suggestions === null}<p class="muted">{$t('hubs.admin.suggestionsLoading')}</p>
  {:else if !ideas.length}<p class="muted">{$t('hubs.admin.suggestionsEmpty')}</p>
  {:else}
    <ul class="chips">
      {#each ideas as s (s.source + s.sourceValue)}
        <li><button type="button" class="ghost chip" disabled={s.used || full} aria-label={s.used ? `${s.name} (${$t('hubs.admin.used')})` : $t('hubs.admin.use', { name: s.name })} on:click={() => open(undefined, s)}>{s.name}<span class="tag">{sourceLabel(s.source)}</span>{#if s.used}<Icon name="check" size={14} />{/if}</button></li>
      {/each}
    </ul>
  {/if}
</AdminCard>

<style>
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem 1.5rem; margin-bottom: 1rem; }
  .intro { flex: 1 1 24rem; margin: 0; max-width: 70ch; }
  .cap { flex: 0 1 16rem; min-width: 10rem; }
  .small { font-size: .85rem; margin: 0; }
  .form { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; margin-bottom: 1rem; scroll-margin-top: calc(var(--nav-total) + 1rem); }
  .form h2 { margin: 0 0 .9rem; font-size: 1.1rem; }
  .fgrid { display: grid; gap: 1.2rem; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 900px) { .fgrid { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
  .fields { display: grid; gap: .9rem; min-width: 0; align-content: start; }
  .prev { order: -1; } @media (min-width: 900px) { .prev { order: 0; } }
  .plabel { margin: 0 0 .4rem; }
  .tile { position: relative; aspect-ratio: 16 / 9; width: 100%; max-width: 26rem; border-radius: 10px; overflow: hidden; background-size: cover; display: flex; align-items: flex-end; padding: .8rem 1rem; box-shadow: 0 6px 22px rgba(0,0,0,.45); }
  .tile img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .tile::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.7), transparent 60%); }
  .tn { position: relative; z-index: 1; font-weight: 800; font-size: 1.2rem; text-shadow: 0 1px 6px rgba(0,0,0,.6); overflow-wrap: anywhere; }
  .accent { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .color { padding: 0; width: 56px; cursor: pointer; }
  .res { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; }
  .res button { width: 100%; justify-content: flex-start; text-align: left; }
  .res img { width: 40px; height: 24px; object-fit: cover; border-radius: 3px; }
  .picked { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .btns { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: 1.1rem; }
  .ls { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
  .row { display: flex; align-items: center; gap: .8rem 1rem; flex-wrap: wrap; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.02); transition: opacity var(--t-fast); }
  .row.off .sw, .row.off .info { opacity: .6; }
  .row[aria-busy='true'] { opacity: .65; }
  .sw { position: relative; flex: none; width: 96px; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background-size: cover; }
  .sw img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .info { flex: 1 1 10rem; min-width: 0; display: flex; flex-direction: column; gap: .15rem; overflow-wrap: anywhere; }
  .meta { display: flex; gap: .4rem; flex-wrap: wrap; }
  .acts { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .mv { display: inline-flex; gap: .2rem; }
  .ic { width: 44px; padding: 0; border-radius: 50%; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.6rem 1rem; color: var(--mut); }
  .state p { margin: 0; }
  .state[role='alert'] { color: var(--fg); } .state[role='alert'] :global(svg) { color: var(--err); }
  .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
  .chip { border-radius: 99px; padding: .3rem .9rem; gap: .5rem; }
  .tag { font-size: .75rem; color: var(--mut); background: var(--tone-muted); border-radius: 99px; padding: 0 .5rem; }
  @media (max-width: 560px) { .row { padding: .6rem; } .acts { width: 100%; justify-content: space-between; } }
</style>
