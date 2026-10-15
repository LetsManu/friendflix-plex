<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail, limits tab: one number per limit, the role's value as placeholder; empty = as role. Save sends only the changed fields (PUT). */
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { toast } from '#lib/ui/toast';
  import { LIMIT_FIELDS, limitsForm, limitsPatch, parseLimit, roleHint, type LimitKey, type Limits } from './detail';

  export let userId: string;

  let saved: Limits | null = null, role: Limits | null = null, error: string | null = null;
  /** bound to number inputs: the browser hands back numbers, '' or null */
  let form: Record<LimitKey, string | number | null> = { maxStreams: '', remoteBitrate: '', maxDownloads: '', downloadMaxHeight: '', requestsPerMonth: '' };
  let errors: Partial<Record<LimitKey, string>> = {};
  /** fields whose text the browser could not read as a number ("-", "1e"): they bind as null, which must not mean "as role" */
  let bad: Partial<Record<LimitKey, boolean>> = {};

  async function load() {
    try {
      const r = await api<{ limits: Limits; role: Limits }>(`/api/admin/users/${userId}/limits`);
      saved = r.limits; role = r.role; form = limitsForm(r.limits); error = null;
    } catch {
      error = tr('adminPeople.loadFailed');
    }
  }
  onMount(load);

  const text = (k: LimitKey): string => String(form[k] ?? '');
  $: busy = $busyKeys.has(`limits:${userId}`);
  async function save() {
    if (!saved) return;
    errors = {};
    for (const f of LIMIT_FIELDS) {
      if (bad[f.key] || parseLimit(f.key, text(f.key)) === undefined) errors[f.key] = tr('adminPeople.detail.limits.invalid', { min: fmtNumber(f.min), max: fmtNumber(f.max) });
    }
    const body = limitsPatch(saved, { maxStreams: text('maxStreams'), remoteBitrate: text('remoteBitrate'), maxDownloads: text('maxDownloads'), downloadMaxHeight: text('downloadMaxHeight'), requestsPerMonth: text('requestsPerMonth') });
    if (!body || Object.keys(errors).length) return;
    if (!Object.keys(body).length) { toast.info(tr('adminPeople.detail.limits.unchanged')); return; }
    const r = await runAction({
      key: `limits:${userId}`,
      run: () => api<{ limits: Limits }>(`/api/admin/users/${userId}/limits`, { method: 'PUT', body }),
      success: tr('adminPeople.detail.limits.saved'),
      // 502: saved, but a media server policy failed
      error: (e) => (e instanceof ApiError && e.status === 502 ? tr('adminPeople.detail.limits.partial') : errorText(e)),
    });
    if (r.ok && r.value) { saved = r.value.limits; form = limitsForm(r.value.limits); }
    else if (r.error instanceof ApiError && r.error.status === 502) void load();
  }
</script>

{#if error}
  <div class="state" role="alert"><p>{error}</p><Button variant="secondary" icon="refresh" on:click={() => { error = null; void load(); }}>{$t('ui.retry')}</Button></div>
{:else}
  <form class="card" novalidate aria-label={$t('adminPeople.detail.tabs.limits')} aria-busy={saved === null || busy ? 'true' : undefined} on:submit|preventDefault={save}>
    <p class="intro">{$t('adminPeople.detail.limits.intro')}</p>
    <div class="grid">
      {#each LIMIT_FIELDS as f (f.key)}
        <Field type="number" label={$t(`adminPeople.detail.limits.${f.key}`)} bind:value={form[f.key]} min={f.min} max={f.max} step={f.step}
          placeholder={role ? roleHint(f.key, role[f.key]) : ''} hint={role ? roleHint(f.key, role[f.key]) : ''} error={errors[f.key] ?? ''} disabled={saved === null}
          on:input={(e) => (bad[f.key] = (e.target as HTMLInputElement).validity.badInput)} />
      {/each}
    </div>
    <Button type="submit" pending={busy} disabled={saved === null}>{$t('adminPeople.detail.limits.save')}</Button>
  </form>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; display: flex; flex-direction: column; align-items: flex-start; gap: 1rem; }
  .intro { margin: 0; color: var(--mut); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; width: 100%; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; }
</style>
