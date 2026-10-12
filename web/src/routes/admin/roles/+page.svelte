<script lang="ts">
  /** Admin: roles – one card per role (requests / playback / downloads), only changed fields are saved, unsaved-changes guard. */
  import { onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { roleName } from '#lib/roles';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';

  interface Form { perMonth: number | null; unlimited: boolean; transcoding: boolean; maxHeight: string; download: boolean; maxDownloads: number | null; dlHeight: string; days: number | null }
  interface Card { role: string; label: string; builtinLabel: boolean; isDefault: boolean; form: Form; base: Form }
  interface Limit { role: string; label: string; builtinLabel?: boolean; requestsPerMonth: number | null; isDefault: boolean; transcoding: boolean; maxHeight: number | null; download?: boolean; maxDownloads?: number | null; downloadMaxHeight?: number | null; downloadDays?: number | null }

  const HEIGHTS = [720, 1080, 1440, 2160];
  const DL_HEIGHTS = [480, 720, 1080];
  const LIKE_PLAYBACK = 2160; // no extra cap for downloads
  let cards: Card[] | null = null, error: string | null = null;

  const toForm = (l: Limit): Form => ({
    perMonth: l.requestsPerMonth ?? 2, unlimited: l.requestsPerMonth === null, transcoding: l.transcoding, maxHeight: l.maxHeight ? String(l.maxHeight) : '',
    download: Boolean(l.download), maxDownloads: l.maxDownloads ?? 0, dlHeight: l.downloadMaxHeight && DL_HEIGHTS.includes(l.downloadMaxHeight) ? String(l.downloadMaxHeight) : '', days: l.downloadDays ?? 30,
  });
  async function load() {
    error = null;
    try {
      const r = await api<{ limits: Limit[] }>('/api/admin/roles');
      cards = r.limits.map((l) => ({ role: l.role, label: l.label, builtinLabel: Boolean(l.builtinLabel), isDefault: l.isDefault, form: toForm(l), base: toForm(l) }));
    } catch { error = tr('adminPeople.loadFailed'); }
  }
  onMount(load);

  const int = (v: number | null) => Math.round(Number(v));
  const inRange = (v: number | null, lo: number, hi: number) => v !== null && v !== undefined && Number.isFinite(Number(v)) && int(v) >= lo && int(v) <= hi && String(v) !== '';
  function errorsOf(f: Form): { perMonth?: string; downloads?: string; days?: string } {
    const e: { perMonth?: string; downloads?: string; days?: string } = {};
    if (!f.unlimited && !inRange(f.perMonth, 0, 100)) e.perMonth = tr('adminPeople.roles.errPerMonth');
    if (f.download && !inRange(f.maxDownloads, 0, 200)) e.downloads = tr('adminPeople.roles.errDownloads');
    if (f.download && !inRange(f.days, 1, 90)) e.days = tr('adminPeople.roles.errDays');
    return e;
  }
  /** only the fields that differ from the loaded state (so untouched settings keep their default/override status) */
  function diff(c: Card): Record<string, unknown> {
    const f = c.form, b = c.base, body: Record<string, unknown> = {};
    if (f.unlimited !== b.unlimited || (!f.unlimited && int(f.perMonth) !== int(b.perMonth))) body.requestsPerMonth = f.unlimited ? null : int(f.perMonth);
    if (f.transcoding !== b.transcoding) body.transcoding = f.transcoding;
    if (f.maxHeight !== b.maxHeight) body.maxHeight = f.maxHeight ? Number(f.maxHeight) : null;
    if (f.download !== b.download) body.download = f.download;
    if (f.download && int(f.maxDownloads) !== int(b.maxDownloads)) body.maxDownloads = int(f.maxDownloads);
    if (f.dlHeight !== b.dlHeight) body.downloadMaxHeight = f.dlHeight ? Number(f.dlHeight) : LIKE_PLAYBACK;
    if (f.download && int(f.days) !== int(b.days)) body.downloadDays = int(f.days);
    return body;
  }
  const dirty = (c: Card): boolean => Object.keys(diff(c)).length > 0;
  $: dirtyCount = (cards ?? []).filter(dirty).length;

  async function save(c: Card) {
    if (Object.keys(errorsOf(c.form)).length) { cards = cards; return; }
    const body = diff(c);
    if (!Object.keys(body).length) return;
    const snapshot = { ...c.form };
    const res = await runAction({
      key: `role:${c.role}`,
      run: () => api(`/api/admin/roles/${encodeURIComponent(c.role)}`, { method: 'PUT', body }),
      success: tr('adminPeople.roles.saved', { name: name(c) }),
      error: (e) => (e instanceof ApiError && e.status === 502 ? tr('adminPeople.roles.partial', { name: name(c) }) : errorText(e)),
    });
    // 502 = saved, but not every Jellyfin account took the new policy: the settings are stored either way
    if (res.ok || (res.error instanceof ApiError && res.error.status === 502)) {
      c.base = snapshot;
      if ('requestsPerMonth' in body) c.isDefault = false;
      cards = cards;
    }
  }
  function discard(c: Card) { c.form = { ...c.base }; cards = cards; }
  const name = (c: Card): string => roleName(c.role, c);

  let leaving = false;
  beforeNavigate((nav) => {
    if (leaving || !dirtyCount) return;
    nav.cancel(); // unload: the browser asks itself
    if (nav.willUnload || !nav.to) return;
    const to = nav.to.url;
    void confirm({ title: tr('adminPeople.roles.leaveTitle'), body: tr('adminPeople.roles.leaveBody', { n: dirtyCount }), danger: true, confirmLabel: tr('adminPeople.roles.leaveConfirm') })
      .then((ok) => { if (ok) { leaving = true; void goto(to); } });
  });

  $: heightOptions = [...HEIGHTS.map((h) => ({ value: String(h), label: `${h}p` })), { value: '', label: $t('adminPeople.roles.heightUnlimited') }];
  $: dlOptions = [...DL_HEIGHTS.map((h) => ({ value: String(h), label: `${h}p` })), { value: '', label: $t('adminPeople.roles.likePlayback') }];
</script>

<p class="intro">{$t('adminPeople.roles.intro')}</p>

{#if error}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{error}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if cards === null}
  <div class="grid" aria-busy="true">
    {#each [0, 1, 2] as i (i)}
      <div class="card" aria-hidden="true"><Skeleton w="40%" h="1.2rem" /><Skeleton lines={5} /></div>
    {/each}
  </div>
{:else if !cards.length}
  <div class="state"><p>{$t('adminPeople.roles.empty')}</p></div>
{:else}
  <div class="grid">
    {#each cards as c (c.role)}
      {@const errs = errorsOf(c.form)}
      {@const isDirty = dirty(c)}
      {@const busy = $busyKeys.has(`role:${c.role}`)}
      <form class="card" class:dirty={isDirty} aria-labelledby="role-{c.role}" on:submit|preventDefault={() => save(c)}>
        <header>
          <h2 id="role-{c.role}">{name(c)}</h2>
          {#if isDirty}<StatusPill tone="warn" label={$t('adminPeople.roles.unsaved')} icon="clock" />{/if}
        </header>

        <section aria-labelledby="g-{c.role}-req">
          <h3 id="g-{c.role}-req">{$t('adminPeople.roles.requests')}</h3>
          <Toggle label={$t('adminPeople.roles.unlimited')} bind:checked={c.form.unlimited} on:change={() => (cards = cards)} />
          {#if !c.form.unlimited}
            <Field label={$t('adminPeople.roles.perMonth')} type="number" min={0} max={100} step={1} width="8rem" bind:value={c.form.perMonth} error={errs.perMonth ?? ''}
              hint={c.isDefault ? `${$t('adminPeople.roles.default')} · ${$t('adminPeople.roles.perMonthHint')}` : $t('adminPeople.roles.perMonthHint')} />
          {/if}
        </section>

        <section aria-labelledby="g-{c.role}-pb">
          <h3 id="g-{c.role}-pb">{$t('adminPeople.roles.playback')}</h3>
          <Toggle label={$t('adminPeople.roles.transcoding')} hint={$t('adminPeople.roles.transcodingHint')} bind:checked={c.form.transcoding} on:change={() => (cards = cards)} />
          <Select label={$t('adminPeople.roles.maxHeight')} options={heightOptions} bind:value={c.form.maxHeight} hint={$t('adminPeople.roles.heightHint')} />
        </section>

        <section aria-labelledby="g-{c.role}-dl">
          <h3 id="g-{c.role}-dl">{$t('adminPeople.roles.downloads')}</h3>
          <Toggle label={$t('adminPeople.roles.allowDownloads')} hint={$t('adminPeople.roles.allowDownloadsHint')} bind:checked={c.form.download} on:change={() => (cards = cards)} />
          {#if c.form.download}
            <div class="two">
              <Field label={$t('adminPeople.roles.maxDownloads')} type="number" min={0} max={200} step={1} bind:value={c.form.maxDownloads} error={errs.downloads ?? ''} />
              <Field label={$t('adminPeople.roles.validity')} type="number" min={1} max={90} step={1} bind:value={c.form.days} error={errs.days ?? ''} hint={$t('adminPeople.roles.validityHint')} />
            </div>
            <Select label={$t('adminPeople.roles.downloadQuality')} options={dlOptions} bind:value={c.form.dlHeight} />
          {/if}
        </section>

        <footer>
          <Button variant="ghost" disabled={!isDirty || busy} on:click={() => discard(c)}>{$t('adminPeople.roles.discard')}</Button>
          <Button type="submit" pending={busy} disabled={!isDirty}>{$t('adminPeople.roles.save')}</Button>
        </footer>
      </form>
    {/each}
  </div>
{/if}

<style>
  .intro { color: var(--mut); margin: 0 0 1rem; max-width: 60ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 1rem; align-items: start; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 1rem; min-width: 0; transition: border-color var(--t-fast); }
  .card.dirty { border-color: var(--warn); }
  header { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 1.15rem; }
  section { border-top: 1px solid var(--line); padding: .8rem 0 0; display: flex; flex-direction: column; gap: .8rem; min-width: 0; }
  h3 { margin: 0; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--mut); }
  .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: .8rem; }
  footer { display: flex; justify-content: flex-end; gap: .6rem; flex-wrap: wrap; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--mut); }
  .state p { margin: 0; }
  .state[role='alert'] { color: var(--fg); }
  .state[role='alert'] :global(svg) { color: var(--err); }
</style>
