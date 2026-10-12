<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { t, tr } from '#lib/i18n';
  interface AdminList { id: string; name: string; owner: { id: string; name: string }; itemCount: number; featured: boolean }
  let lists: AdminList[] | null = null, msg = '', failed = false, busy = '';
  const MAX = 5;
  $: count = lists ? lists.filter((l) => l.featured).length : 0;

  async function load() {
    try { lists = (await api('/api/admin/lists')).lists; failed = false; } catch { lists = []; failed = true; }
  }
  async function toggle(l: AdminList) {
    if (busy) return;
    busy = l.id; msg = '';
    const next = !l.featured;
    try {
      await api(`/api/admin/lists/${l.id}/featured`, { method: 'PUT', body: { featured: next } });
      l.featured = next; lists = lists;
      msg = next ? tr('admin.lists.shown', { name: l.name }) : tr('admin.lists.hidden', { name: l.name });
    } catch (e) {
      msg = e instanceof ApiError && e.status === 409 ? tr('admin.lists.tooMany', { max: MAX }) : e instanceof ApiError && e.status === 404 ? tr('admin.lists.gone') : tr('common.failed');
      if (e instanceof ApiError && e.status === 404) await load();
    }
    busy = '';
  }
  onMount(load);
</script>

<p class="muted">{$t('admin.lists.intro', { max: MAX, count })}</p>
<p role="status" aria-live="polite" class="msg">{msg}</p>
{#if lists === null}<p class="muted">{$t('admin.lists.loading')}</p>
{:else if failed}<p class="err" role="alert">{$t('admin.lists.loadFailed')} <button type="button" class="sec" on:click={load}>{$t('admin.tryAgain')}</button></p>
{:else if !lists.length}<p class="muted">{$t('admin.lists.empty')}</p>
{:else}
  <ul class="ls">
    {#each lists as l (l.id)}
      <li class="panel">
        <div class="info"><a href="/lists/{l.id}"><b>{l.name}</b></a><span class="muted"> {$t('admin.lists.meta', { name: l.owner.name, n: l.itemCount })}</span></div>
        <button type="button" class:sec={!l.featured} aria-pressed={l.featured} disabled={busy === l.id} on:click={() => toggle(l)}>{$t('admin.lists.feature')}<span class="sr-only">: {l.name}</span></button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .ls { list-style: none; padding: 0; margin: 0; display: grid; gap: .6rem; }
  .ls li { display: flex; gap: .8rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .info { min-width: 0; overflow-wrap: anywhere; }
  .ls button { min-height: 44px; }
  .ls button[aria-pressed='true']::before { content: '✓ '; }
  .msg { min-height: 1.4em; }
</style>
