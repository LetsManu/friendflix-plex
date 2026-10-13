<script lang="ts">
  /**
   * Admin → Bald weg: titles with a removal date ("Nur noch N Tage"). Setting a date deletes nothing on the media server.
   * Form on top (add a title via search, or edit a row), DataTable below (cards on the phone); clearing has Undo.
   */
  import { onMount, tick } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { fmtDate, t, tr } from '#lib/i18n';
  import { errorText, runAction } from '#lib/ui/action';
  import { confirm } from '#lib/ui/confirm';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Field from '#lib/ui/Field.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';

  interface Row { itemId: string; name: string | null; type: string | null; year: number | null; leavesAt: string; days: number; note: string | null; setBy: string | null }
  interface Hit { id: string; name: string; type: string; year?: number }

  let rows: Row[] | null = null, error: string | null = null, seq = 0;
  /** form: null = only the search shows; else the title being added or edited */
  let target: { id: string; name: string; editing: boolean } | null = null;
  let date = '', note = '', dateErr = '', saving = false;
  let q = '', hits: Hit[] = [], searching = false, searchSeq = 0, searchT: ReturnType<typeof setTimeout>;
  let formEl: HTMLElement | undefined;

  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const local = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, m! - 1, d); };
  const today = () => iso(new Date());
  const lastDay = () => { const d = new Date(); d.setDate(d.getDate() + 730); return iso(d); };
  const daysUntil = (s: string) => Math.round((local(s).getTime() - local(today()).getTime()) / 864e5);
  const title = (r: Pick<Row, 'name'>) => r.name ?? tr('adminContent.leaving.unknownTitle');
  const tone = (days: number): Tone => (days <= 1 ? 'err' : days <= 7 ? 'warn' : 'info');
  const left = (days: number) => (days <= 0 ? tr('fresh.leaving.today') : tr('fresh.leaving.days', { n: days }));
  const byDate = (list: Row[]) => [...list].sort((a, b) => a.leavesAt.localeCompare(b.leavesAt) || title(a).localeCompare(title(b)));

  async function load(quiet = false) {
    const my = ++seq;
    if (!quiet) error = null;
    try {
      const r = await api<{ items: Row[] }>('/api/admin/leaving');
      if (my === seq) { rows = r.items; error = null; }
    } catch (e) { if (my === seq && !quiet) { rows = rows ?? []; error = errorText(e); } }
  }
  onMount(() => { void load(); return () => clearTimeout(searchT); });

  function search() {
    clearTimeout(searchT);
    const term = q.trim();
    if (term.length < 2) { hits = []; searching = false; return; }
    searching = true;
    const my = ++searchSeq;
    searchT = setTimeout(async () => {
      try {
        const r = await api<{ items: Hit[] }>(`/api/library/items?${new URLSearchParams({ q: term, types: 'Movie,Series', limit: '8' })}`);
        if (my === searchSeq) hits = r.items;
      } catch { if (my === searchSeq) hits = []; }
      if (my === searchSeq) searching = false;
    }, 250);
  }

  async function open(id: string, name: string, existing?: Row) {
    target = { id, name, editing: Boolean(existing) };
    date = existing?.leavesAt ?? ''; note = existing?.note ?? ''; dateErr = '';
    hits = []; q = '';
    await tick();
    formEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    document.getElementById('lv-date')?.focus({ preventScroll: true });
  }
  async function pick(h: Hit) {
    const had = rows?.find((r) => r.itemId === h.id);
    // the title already has a date: say so instead of silently replacing it
    if (had && !(await confirm({ title: tr('adminContent.leaving.replaceTitle', { name: h.name, date: fmtDate(local(had.leavesAt)) }), confirmLabel: tr('adminContent.leaving.replace') }))) return;
    await open(h.id, h.name, had);
  }
  function close() { target = null; date = ''; note = ''; dateErr = ''; }

  const put = (id: string, leavesAt: string, n: string | null) => api(`/api/admin/leaving/${id}`, { method: 'PUT', body: { leavesAt, note: n } });
  const del = (id: string) => api(`/api/admin/leaving/${id}`, { method: 'DELETE' });
  const saveError = (e: unknown) => {
    const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
    return code === 'date_out_of_range' ? tr('fresh.admin.dateRange') : code === 'not_a_title' ? tr('adminContent.leaving.notATitle') : errorText(e);
  };

  async function save() {
    if (!target || saving) return;
    dateErr = !date ? tr('adminContent.leaving.dateRequired') : date < today() || date > lastDay() ? tr('fresh.admin.dateRange') : '';
    if (dateErr) { document.getElementById('lv-date')?.focus(); return; }
    const { id, name } = target;
    const prev = rows?.find((r) => r.itemId === id);
    const next: Row = { itemId: id, name, type: prev?.type ?? null, year: prev?.year ?? null, leavesAt: date, days: daysUntil(date), note: note.trim() || null, setBy: prev?.setBy ?? null };
    saving = true;
    const res = await runAction({
      key: `leave:${id}`,
      apply: () => {
        const before = rows;
        rows = byDate([...(rows ?? []).filter((r) => r.itemId !== id), next]);
        return () => { rows = before; };
      },
      run: () => put(id, next.leavesAt, next.note),
      success: tr('adminContent.leaving.savedName', { name }),
      // Undo puts the previous date back, or removes a date that did not exist before
      undo: { run: () => (prev ? put(id, prev.leavesAt, prev.note) : del(id)).then(() => load(true)) },
      error: saveError,
    });
    saving = false;
    if (res.ok) { close(); void load(true); }
  }

  function clear(r: Row) {
    void runAction({
      key: `leave:${r.itemId}`,
      apply: () => { const before = rows; rows = (rows ?? []).filter((x) => x.itemId !== r.itemId); return () => { rows = before; }; },
      run: () => del(r.itemId),
      success: tr('adminContent.leaving.clearedName', { name: title(r) }),
      undo: { run: () => put(r.itemId, r.leavesAt, r.note).then(() => load(true)) },
    }).then((res) => { if (res.ok && target?.id === r.itemId) close(); });
  }

  $: columns = [
    { key: 'name', label: $t('fresh.admin.colTitle'), value: (r) => title(r), primary: true },
    { key: 'date', label: $t('fresh.admin.date'), value: (r) => r.leavesAt, filter: false },
    { key: 'left', label: $t('adminContent.leaving.left'), value: (r) => r.days, filter: false, hideOnCard: true },
    { key: 'note', label: $t('fresh.admin.note'), value: (r) => r.note ?? '' },
    { key: 'setBy', label: $t('fresh.admin.colSetBy'), value: (r) => r.setBy ?? '' },
  ] as Column<Row>[];
  const actions = (r: Row) => [
    { id: 'edit', label: tr('adminContent.leaving.edit'), icon: 'calendar', run: () => void open(r.itemId, title(r), r) },
    { id: 'clear', label: tr('fresh.admin.clear'), icon: 'x', danger: true, run: () => clear(r) },
  ];
  let sort: { key: string; dir: 'asc' | 'desc' } | null = { key: 'date', dir: 'asc' };
</script>

<p class="intro muted">{$t('fresh.admin.intro')}</p>

<section class="form" bind:this={formEl} aria-labelledby="lv-form-title">
  <h2 id="lv-form-title">{target?.editing ? $t('adminContent.leaving.editTitle', { name: target.name }) : $t('fresh.admin.addTitle')}</h2>
  {#if target}
    <form on:submit|preventDefault={save} novalidate>
      {#if !target.editing}<p class="picked">{$t('adminContent.leaving.picked', { name: target.name })}</p>{/if}
      <div class="fields">
        <Field id="lv-date" type="date" label={$t('fresh.admin.date')} bind:value={date} min={today()} max={lastDay()} required error={dateErr} />
        <Field label={$t('fresh.admin.note')} bind:value={note} maxlength={200} placeholder={$t('fresh.admin.notePlaceholder')} />
      </div>
      <p class="hint muted">{$t('fresh.admin.hint')}</p>
      <div class="btns">
        <Button type="submit" icon="check" pending={saving}>{$t('fresh.admin.save')}</Button>
        <Button variant="ghost" disabled={saving} on:click={close}>{$t('adminContent.leaving.cancel')}</Button>
      </div>
    </form>
  {:else}
    <Field label={$t('fresh.admin.search')} hint={$t('adminContent.leaving.searchHint')} let:id let:describedby>
      <input {id} type="search" bind:value={q} on:input={search} placeholder={$t('fresh.admin.searchPlaceholder')} autocomplete="off" aria-describedby={describedby} aria-controls="lv-hits" />
    </Field>
    <div id="lv-hits" class="hits-wrap">
      {#if hits.length}
        <ul class="hits" aria-label={$t('fresh.admin.results')}>
          {#each hits as h (h.id)}
            {@const had = rows?.find((r) => r.itemId === h.id)}
            <li><button type="button" class="sec hit" on:click={() => pick(h)}>
              <span class="hn">{h.name}{#if h.year} <span class="muted">({h.year})</span>{/if}</span>
              {#if had}<StatusPill tone="warn" icon="calendar" label={fmtDate(local(had.leavesAt))} />{/if}
            </button></li>
          {/each}
        </ul>
      {:else if q.trim().length >= 2}
        <p class="muted small" role="status">{searching ? $t('adminContent.leaving.searching') : $t('fresh.admin.noHits')}</p>
      {/if}
    </div>
  {/if}
</section>

<DataTable caption={$t('fresh.admin.title')} {rows} {columns} key={(r) => r.itemId} {error} {actions} rowLabel={title}
  busyKey={(r) => `leave:${r.itemId}`} filterable filterPlaceholder={$t('adminContent.leaving.filter')} emptyText={$t('fresh.admin.empty')}
  bind:sort on:retry={() => load()}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      <a class="nm" href="/item/{row.itemId}">{title(row)}</a>{#if row.year}<span class="muted yr">({row.year})</span>{/if}
    {:else if col.key === 'date'}
      <span class="dt">{fmtDate(local(row.leavesAt))}<span class="on-card"><StatusPill tone={tone(row.days)} label={left(row.days)} /></span></span>
    {:else if col.key === 'left'}
      <StatusPill tone={tone(row.days)} label={left(row.days)} />
    {:else if col.key === 'note'}
      {#if row.note}{row.note}{:else}<span class="muted">–</span><span class="sr-only">{$t('adminContent.leaving.noNote')}</span>{/if}
    {:else}{col.value?.(row) ?? ''}{/if}
  </svelte:fragment>
</DataTable>

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .form { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; margin-bottom: 1.2rem; max-width: 760px; scroll-margin-top: calc(var(--nav-total) + 1rem); }
  .form h2 { margin: 0 0 .8rem; font-size: 1.1rem; overflow-wrap: anywhere; }
  .fields { display: grid; gap: .9rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); }
  .picked { margin: 0 0 .8rem; font-weight: 600; overflow-wrap: anywhere; }
  .hint { font-size: .85rem; margin: .7rem 0 0; }
  .btns { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: 1rem; }
  .hits-wrap:not(:empty) { margin-top: .6rem; }
  .hits { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; }
  .hit { width: 100%; justify-content: space-between; text-align: left; gap: .6rem; }
  .hn { min-width: 0; overflow-wrap: anywhere; }
  .small { font-size: .88rem; margin: 0; }
  .nm { color: var(--fg); text-decoration: underline; text-decoration-color: rgba(255,255,255,.3); text-underline-offset: 3px; }
  .nm:hover { text-decoration-color: currentColor; }
  .yr { font-weight: 400; margin-left: .35em; }
  .dt { display: inline-flex; align-items: center; gap: .5rem; flex-wrap: wrap; justify-content: flex-end; }
  .on-card { display: none; }
  @media (max-width: 720px) { .on-card { display: inline-flex; } }
</style>
