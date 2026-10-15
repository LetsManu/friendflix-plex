<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Admin → Datenquellen: optional TMDB/OMDb keys. The API only ever returns last4; a typed key lives in the input until saved, then it is cleared. */
  import { onMount } from 'svelte';
  import { isReauthError, startReauth } from '#lib/account/reauth';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { toast } from '#lib/ui/toast';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Field from '#lib/ui/Field.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';

  type Name = 'tmdb' | 'omdb';
  interface Source { name: Name; set: boolean; last4: string | null; from: 'db' | 'file' | null; invalid: boolean; usedToday?: number; budget?: number }
  type TestResult = { ok: true } | { ok: false; error: 'not_set' | 'invalid_key' | 'unreachable' | 'budget' };

  let sources: Source[] | null = null, loadFailed = false;
  let keys: Record<Name, string> = { tmdb: '', omdb: '' };

  async function load() {
    loadFailed = false;
    try { sources = (await api<{ sources: Source[] }>('/api/admin/sources')).sources; } catch { loadFailed = true; }
  }
  onMount(load);
  const replace = (s: Source) => { sources = (sources ?? []).map((x) => (x.name === s.name ? s : x)); };

  function saveError(e: unknown): string {
    if (e instanceof ApiError && e.status === 400) return tr('admin.sources.keyFormat');
    if (e instanceof ApiError && e.status === 409) return tr('admin.sources.fromFile');
    return tr('admin.sources.saveFailed');
  }
  /** replacing or removing a key needs a sign-in at most 10 minutes old: go through it and come back here (the typed key is not kept) */
  function failed(res: { ok: boolean; skipped?: boolean; error?: unknown }) {
    if (res.ok || res.skipped) return;
    if (isReauthError(res.error)) startReauth('/admin/sources');
    else toast.error(saveError(res.error));
  }
  async function save(s: Source) {
    const key = keys[s.name].trim();
    if (!key) return;
    const res = await runAction({
      key: `src:save:${s.name}`, run: () => api<Source>(`/api/admin/sources/${s.name}`, { method: 'PUT', body: { key } }),
      success: tr('admin.sources.saved'), error: false,
    });
    if (res.ok) { keys[s.name] = ''; if (res.value) replace(res.value); }
    failed(res);
  }
  async function remove(s: Source) {
    if (!(await confirm({ title: tr('admin.sources.removeConfirm', { name: label(s.name) }), body: tr('admin.sources.removeBody'), danger: true, confirmLabel: tr('admin.sources.remove') }))) return;
    const res = await runAction({
      key: `src:remove:${s.name}`, run: () => api<Source>(`/api/admin/sources/${s.name}`, { method: 'DELETE' }),
      success: tr('admin.sources.removed'), error: false,
    });
    if (res.ok && res.value) replace(res.value);
    failed(res);
  }
  function test(s: Source) {
    const key = keys[s.name].trim();
    void runAction({
      key: `src:test:${s.name}`, run: async () => {
        const r = await api<TestResult>(`/api/admin/sources/${s.name}/test`, { method: 'POST', body: key ? { key } : {} });
        if (!r.ok) throw new ApiError(200, r.error);
        return r;
      },
      success: tr('admin.sources.testOk'),
      error: (e) => {
        const code = e instanceof ApiError ? String(e.body) : '';
        return code === 'invalid_key' ? tr('admin.sources.invalidKey') : code === 'not_set' ? tr('admin.sources.notSet') : code === 'budget' ? tr('admin.sources.budget') : code === 'unreachable' ? tr('admin.sources.unreachable') : tr('admin.sources.testFailed');
      },
    });
  }
  const label = (n: Name) => tr(`admin.sources.${n}`);
</script>

<div class="wrap">
  <p class="intro muted">{$t('admin.sources.intro')} {$t('detail.about.tmdbNotice')}</p>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('admin.sources.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !sources}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="2rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {:else}
    {#each sources as s (s.name)}
      {@const file = s.from === 'file'}
      <AdminCard title={label(s.name)}>
        <div class="pills">
          {#if !s.set}<StatusPill tone="muted" label={$t('admin.sources.pillNotSet')} />
          {:else if s.invalid}<StatusPill tone="err" label={$t('admin.sources.pillInvalid')} />
          {:else if file}<StatusPill tone="info" label={$t('admin.sources.pillFile')} />
          {:else}<StatusPill tone="ok" label={$t('admin.sources.pillSet', { last4: s.last4 ?? '' })} />{/if}
          {#if s.name === 'omdb' && s.usedToday !== undefined}<span class="muted small">{$t('admin.sources.usage', { n: s.usedToday })}</span>{/if}
        </div>
        <form on:submit|preventDefault={() => save(s)}>
          <Field label={$t('admin.sources.keyLabel')} type="password" autocomplete="off" bind:value={keys[s.name]} disabled={file} hint={file ? $t('admin.sources.fromFile') : $t('admin.sources.keyHint')} minlength={8} maxlength={200} />
          <div class="btns">
            <Button type="submit" icon="check" pending={$busyKeys.has(`src:save:${s.name}`)} disabled={file || !keys[s.name].trim()}>{$t('admin.sources.save')}</Button>
            <Button variant="secondary" icon="activity" pending={$busyKeys.has(`src:test:${s.name}`)} disabled={!s.set && !keys[s.name].trim()} on:click={() => test(s)}>{$t('admin.sources.test')}</Button>
            <Button variant="ghost" icon="x" pending={$busyKeys.has(`src:remove:${s.name}`)} disabled={file || !s.set} on:click={() => remove(s)}>{$t('admin.sources.remove')}</Button>
          </div>
        </form>
      </AdminCard>
    {/each}
  {/if}
</div>

<style>
  .wrap { max-width: 640px; }
  .intro { margin: 0 0 1rem; }
  form { display: grid; gap: 1rem; }
  .pills { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .small { font-size: .85rem; }
  .btns { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .sk { display: grid; gap: 1rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
