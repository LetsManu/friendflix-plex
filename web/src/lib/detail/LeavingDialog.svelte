<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { api } from '#lib/api';
  import { dialogKeys } from '#lib/actions';
  import { t, tr } from '#lib/i18n';

  /** Admin: set, change or clear the date a title stops being available (nothing is deleted on the media server). */
  export let itemId: string;
  export let name: string;
  export let leavesAt = '';
  export let note = '';
  const dispatch = createEventDispatcher<{ close: void; saved: void }>();
  const had = Boolean(leavesAt);
  let date = leavesAt, text = note, busy = false, err = '';
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };

  async function save() {
    if (!date || busy) return;
    busy = true; err = '';
    try {
      await api(`/api/admin/leaving/${itemId}`, { method: 'PUT', body: { leavesAt: date, note: text.trim() || null } });
      dispatch('saved');
    } catch (e) {
      err = (e as { body?: { error?: string } })?.body?.error === 'date_out_of_range' ? tr('fresh.admin.dateRange') : tr('fresh.admin.saveFailed');
    }
    busy = false;
  }
  async function clear() {
    if (busy) return;
    busy = true; err = '';
    try { await api(`/api/admin/leaving/${itemId}`, { method: 'DELETE' }); dispatch('saved'); } catch { err = tr('fresh.admin.saveFailed'); }
    busy = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="scrim" use:portal on:click={() => dispatch('close')}></div>
<div class="dlg" use:portal use:dialogKeys={{ close: () => dispatch('close'), focusFirst: true }} role="dialog" aria-modal="true" aria-labelledby="lv-h">
  <h2 id="lv-h">{$t('fresh.admin.dialogTitle')}</h2>
  <p class="nm">{name}</p>
  <form on:submit|preventDefault={save}>
    <label>{$t('fresh.admin.date')}<input type="date" bind:value={date} min={today()} required /></label>
    <label>{$t('fresh.admin.note')}<input type="text" bind:value={text} maxlength="200" placeholder={$t('fresh.admin.notePlaceholder')} /></label>
    <p class="hint">{$t('fresh.admin.hint')}</p>
    {#if err}<p class="err" role="alert">{err}</p>{/if}
    <div class="acts">
      <button type="submit" disabled={!date || busy}>{$t('fresh.admin.save')}</button>
      {#if had}<button type="button" class="sec" disabled={busy} on:click={clear}>{$t('fresh.admin.clear')}</button>{/if}
      <button type="button" class="sec" on:click={() => dispatch('close')}>{$t('common.cancel')}</button>
    </div>
  </form>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, .65); }
  .dlg { position: fixed; z-index: 121; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(26rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); overflow-y: auto; padding: 1.2rem 1.3rem 1.3rem; border-radius: 10px; background: var(--surface); color: var(--fg); box-shadow: 0 20px 60px rgba(0, 0, 0, .8); }
  h2 { margin: 0; font-size: 1.2rem; }
  .nm { margin: .2rem 0 .8rem; color: var(--mut); overflow-wrap: anywhere; }
  form { display: grid; gap: .8rem; }
  label { display: grid; gap: .3rem; font-size: .85rem; color: var(--mut); font-weight: 600; }
  input { min-height: 44px; font-size: 1rem; color: var(--fg); font-weight: 400; }
  .hint { margin: 0; font-size: .8rem; color: var(--mut); }
  .acts { display: flex; flex-wrap: wrap; gap: .5rem; }
  .acts button { flex: 1; min-height: 44px; }
  @media (max-width: 640px) { .dlg { top: auto; bottom: 0; left: 0; right: 0; transform: none; width: auto; border-radius: 14px 14px 0 0; padding-bottom: calc(1.3rem + var(--safe-bottom)); } }
</style>
