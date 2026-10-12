<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t, tr, fmtNumber, type TKey } from '#lib/i18n';
  type Row = { itemId: string; name: string; type: string; status: 'ok' | 'failed' | 'missing' | 'preparing'; bytes: number | null; audioLang: string | null; error: string | null };
  let sum: any = null;
  let items: Row[] = [];
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const order = { failed: 0, preparing: 1, missing: 2, ok: 3 };
  const mb = (b: number) => tr('admin.previews.mb', { n: fmtNumber(b / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  async function load() {
    const r = await api('/api/admin/previews');
    sum = r.summary;
    items = [...r.items].sort((a: Row, b: Row) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    if (sum.preparing && !timer) timer = setInterval(load, 10_000);
    else if (!sum.preparing && timer) stop();
  }
  function stop() { clearInterval(timer); timer = undefined; }
  async function regen(id: string) { await api('/api/admin/previews/regenerate', { method: 'POST', body: { itemId: id } }); load(); }
  async function regenFailed() {
    busy = true;
    try { await api('/api/admin/previews/regenerate-failed', { method: 'POST' }); await load(); } finally { busy = false; }
  }
  onMount(load);
  onDestroy(stop);
</script>
<p class="muted">{$t('admin.previews.intro')}</p>
{#if sum}
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
    {#each [[$t('admin.previews.titles'), sum.total, ''], [$t('admin.previews.state.ok'), sum.ok, 'ok'], [$t('admin.previews.state.failed'), sum.failed, sum.failed ? 'err' : ''], [$t('admin.previews.missing'), sum.missing, ''], [$t('admin.previews.state.preparing'), sum.preparing, 'warn'], [$t('admin.previews.size'), mb(sum.totalBytes), '']] as [l, v, c]}
      <div class="panel"><h2 class={c}>{v}</h2><span class="muted">{l}</span></div>{/each}
  </div>
  <div class="panel">
    <progress style="width:100%" max={sum.total || 1} value={sum.ok}></progress>
    <div class="flex"><span class="muted">{$t('admin.previews.done', { ok: sum.ok, total: sum.total })}</span>
      <button class="sec" disabled={busy || !sum.failed} on:click={regenFailed}>{$t('admin.previews.regenFailed')}</button></div>
  </div>
  {#each items as i (i.itemId)}
    <div class="panel flex">
      <b>{i.name}</b> <span class="muted">{i.type === 'Series' ? $t('admin.kind.series') : $t('admin.kind.movie')}</span>
      <span class={i.status === 'ok' ? 'ok' : i.status === 'failed' ? 'err' : i.status === 'preparing' ? 'warn' : 'muted'}>{$t(`admin.previews.state.${i.status}` as TKey)}</span>
      {#if i.bytes}<span class="muted">{mb(i.bytes)}</span>{/if}
      {#if i.audioLang}<span class="muted">{$t('admin.previews.audio', { lang: i.audioLang })}</span>{/if}
      {#if i.error}<span class="muted" style="word-break:break-all">{i.error}</span>{/if}
      <span style="margin-left:auto" class="flex">
        {#if i.status === 'ok'}<a href="/api/items/{i.itemId}/preview.mp4" target="_blank" rel="noopener">{$t('admin.previews.watch')}</a>{/if}
        <button class="sec" disabled={i.status === 'preparing'} on:click={() => regen(i.itemId)}>{$t('admin.previews.regen')}</button>
      </span>
    </div>
  {/each}
{/if}
