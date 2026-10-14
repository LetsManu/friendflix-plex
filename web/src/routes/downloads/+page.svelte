<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { downloads, initManager, getSupport, pause, progressPct, refreshStorage, removeDownload, resume, stateLabel, storageInfo, checkIn, type DlView } from '#lib/offline/manager';
  import { SUPPORT_HINT, persist, type Support } from '#lib/offline/opfs';
  import { daysLeft } from '#lib/offline/license';
  import { fmtBytes } from '#lib/offline/size';
  import { intlLocale, t, tr } from '#lib/i18n';

  let support: Support = { ok: false };
  let me: Me | null = null, ready = false;
  let quality = 'hd', persistMsg = '';

  onMount(async () => {
    support = await getSupport();
    me = await api<Me>('/api/me').catch(() => null);
    try { quality = localStorage.getItem('ff_dl_quality') ?? 'hd'; } catch { /* ignore */ }
    if (support.ok) { await initManager(); void refreshStorage(); void checkIn(); }
    ready = true;
  });
  function setQuality(q: string) { quality = q; try { localStorage.setItem('ff_dl_quality', q); } catch { /* ignore */ } }
  async function askPersist() { persistMsg = (await persist()) ? tr('account.downloads.persisted') : tr('account.downloads.persistDenied'); void refreshStorage(); }

  $: list = [...$downloads.values()].filter((v) => v.profileId === (me?.profile?.id ?? v.profileId));
  $: groups = Object.values(list.reduce<Record<string, { name: string; items: DlView[] }>>((acc, v) => {
    const k = v.seriesName ?? '\u0000Filme';
    (acc[k] ??= { name: v.seriesName ?? tr('account.downloads.movies'), items: [] }).items.push(v);
    return acc;
  }, {})).map((g) => ({ ...g, items: g.items.sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.e ?? 0) - (b.e ?? 0) || a.title.localeCompare(b.title, intlLocale())) }))
    .sort((a, b) => a.name.localeCompare(b.name, intlLocale()));
  $: used = list.reduce((n, v) => n + v.bytesHave, 0);
  $: total = $storageInfo.quota;
  $: barPct = total ? Math.min(100, (used / total) * 100) : 0;
  const label = (v: DlView) => (v.seriesName ? `S${v.s ?? '?'}:E${v.e ?? '?'} · ${v.title}` : v.title);
  const busy = (v: DlView) => v.state === 'queued' || v.state === 'preparing' || v.state === 'downloading';
  let confirmAll = false;
  async function wipe() { confirmAll = false; await Promise.all(list.map((v) => removeDownload(v.id))); }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.downloads.pageTitle') })}</title></svelte:head>
<h1>{$t('account.downloads.title')}</h1>
{#if !ready}<div class="skeleton" style="height:10rem"></div>
{:else if !support.ok}
  <p class="muted">{SUPPORT_HINT[support.reason ?? 'no-opfs']}</p>
{:else if me && !me.downloads?.allowed}
  <p class="muted">{$t('account.downloads.notAllowed')}</p>
{:else}
  {#if !list.length}
    <div class="empty">
      <svg class="ill" viewBox="0 0 160 160" width="160" height="160" aria-hidden="true" focusable="false">
        <circle cx="80" cy="80" r="76" fill="#242b33" />
        <rect x="52" y="38" width="56" height="84" rx="8" fill="#151a20" stroke="#4f5964" stroke-width="3" />
        <rect x="60" y="48" width="40" height="56" rx="3" fill="#2b333c" />
        <circle cx="80" cy="112" r="3.5" fill="#4f5964" />
        <circle cx="112" cy="104" r="22" fill="var(--acc)" />
        <path d="M112 93v18m-8-8 8 8 8-8" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <h2>{$t('account.downloads.emptyTitle')}</h2>
      <p class="muted">{$t('account.downloads.emptyText')}</p>
      <a class="btn light find" href="/browse/movies">{$t('account.downloads.emptyFind')}</a>
    </div>
  {/if}
  <section class="panel store">
    <div class="bar" role="progressbar" aria-label={$t('account.downloads.storageAria')} aria-valuenow={Math.round(barPct)} aria-valuemin="0" aria-valuemax="100"><i style="width:{barPct}%"></i></div>
    <p>{$t('account.downloads.storageUsed', { used: fmtBytes(used), total: fmtBytes(total) })}{#if me?.downloads?.max}{$t('account.downloads.maxDownloads', { n: me.downloads.max })}{/if}</p>
    <div class="flex">
      <label>{$t('account.downloads.defaultQuality')}
        <select value={quality} on:change={(e) => setQuality(e.currentTarget.value)}>
          <option value="sd">{$t('account.downloads.qualities.sd')}</option><option value="hd">{$t('account.downloads.qualities.hd')}</option><option value="fhd">{$t('account.downloads.qualities.fhd')}</option><option value="original">{$t('account.downloads.qualities.original')}</option>
        </select>
      </label>
      {#if !$storageInfo.persisted}<button class="sec" on:click={askPersist}>{$t('account.downloads.persist')}</button>{/if}
    </div>
    {#if persistMsg}<p class="muted" role="status">{persistMsg}</p>{/if}
    <p class="muted small">{$t('account.downloads.note')}</p>
  </section>

  {#if list.length}
    {#each groups as g (g.name)}
      <h2>{g.name}</h2>
      <ul class="list">
        {#each g.items as v (v.id)}
          <li class="item">
            <div class="tx">
              <b>{label(v)}</b>
              <span class="muted small">{stateLabel(v)}{#if v.state === 'done'}{' · '}{fmtBytes(v.bytesTotal)}{' · '}{$t('account.downloads.daysLeft', { n: daysLeft(v.expiresAt, Date.now()) })}{/if}{#if v.state === 'error' && v.msg}{' · '}{v.msg}{/if}</span>
              {#if busy(v) || v.state === 'paused'}<div class="bar slim" role="progressbar" aria-label={$t('account.downloads.progress')} aria-valuenow={v.state === 'preparing' ? v.prep ?? 0 : progressPct(v)} aria-valuemin="0" aria-valuemax="100"><i style="width:{v.state === 'preparing' ? v.prep ?? 0 : progressPct(v)}%"></i></div>{/if}
            </div>
            <div class="acts">
              {#if v.state === 'done'}<a class="btn" href="/offline?play={v.id}"><Icon name="play" size={18} />{$t('account.downloads.play')}</a>{/if}
              {#if v.state === 'downloading'}<button class="sec" on:click={() => pause(v.id)}><Icon name="pause" size={18} />{$t('account.downloads.pause')}</button>{/if}
              {#if v.state === 'paused' || v.state === 'error'}<button class="sec" on:click={() => resume(v.id)}><Icon name="play" size={18} />{$t('account.downloads.resume')}</button>{/if}
              <button class="icon-btn" aria-label={$t('account.downloads.removeAria', { action: v.state === 'done' ? $t('account.downloads.delete') : $t('account.downloads.cancel'), title: label(v) })} title={v.state === 'done' ? $t('account.downloads.delete') : $t('account.downloads.cancel')} on:click={() => removeDownload(v.id)}><Icon name="x" size={20} /></button>
            </div>
          </li>
        {/each}
      </ul>
    {/each}
    {#if confirmAll}
      <p class="flex"><span>{$t('account.downloads.confirmAll')}</span><button on:click={wipe}>{$t('account.downloads.confirmAllYes')}</button><button class="sec" on:click={() => (confirmAll = false)}>{$t('account.downloads.cancel')}</button></p>
    {:else}<button class="sec" on:click={() => (confirmAll = true)}>{$t('account.downloads.deleteAll')}</button>{/if}
  {/if}
{/if}

<style>
  .store { display: grid; gap: .8rem; max-width: 720px; margin-bottom: 1.5rem; }
  .empty + .store { margin: 0 auto 1.5rem; }
  .bar { height: 8px; border-radius: 4px; background: var(--surface-2, #242b33); overflow: hidden; } .bar i { display: block; height: 100%; background: var(--acc); transition: width .3s; }
  .bar.slim { height: 4px; margin-top: .3rem; }
  .small { font-size: .85rem; } .store p { margin: 0; }
  .list { list-style: none; padding: 0; margin: 0 0 1.5rem; display: grid; gap: .5rem; max-width: 900px; }
  .item { display: flex; gap: 1rem; align-items: center; justify-content: space-between; padding: .8rem 1rem; background: var(--surface); border-radius: 8px; flex-wrap: wrap; }
  .tx { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 240px; }
  .acts { display: flex; gap: .5rem; align-items: center; }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: .6rem; padding: 2rem 0 3rem; max-width: 520px; margin: 0 auto; }
  .empty h2 { margin: .6rem 0 0; font-size: 1.3rem; }
  .empty p { margin: 0 0 .6rem; line-height: 1.5; }
  .ill { width: 140px; height: 140px; }
  .find { min-height: 48px; padding: .6rem 1.4rem; }
</style>
