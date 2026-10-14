<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t, fmtDuration, fmtTime } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';

  let rooms: any[] = [], pick: Item | null = null, results: Item[] = [], q = '', delay = 0, busy = false;
  const preItem = $page.url.searchParams.get('item');
  async function load() { rooms = (await api('/api/party')).rooms; }
  async function search() {
    if (q.length < 2) return;
    results = (await api(`/api/library/items?q=${encodeURIComponent(q)}&types=Movie,Episode&limit=24`)).items;
  }
  async function create() {
    if (!pick) return;
    busy = true;
    const r = await api('/api/party', { method: 'POST', body: { itemId: pick.id, startInMinutes: delay || undefined } });
    location.href = `/party/${r.id}`;
  }
  onMount(async () => {
    load();
    if (preItem) pick = (await api(`/api/items/${preItem}`)).item;
  });
</script>

<h1>{$t('social.party.title')}</h1>
<div class="panel">
  <h3>{$t('social.party.newParty')}</h3>
  {#if pick}
    <p>{$t('social.party.chosen')} <b>{pick.name}</b> <button class="sec" on:click={() => (pick = null)}>{$t('social.party.change')}</button></p>
    <label>{$t('social.party.startIn')} <select bind:value={delay}><option value={0}>{$t('social.party.startNow')}</option>{#each [5, 15, 60] as m}<option value={m}>{fmtDuration(m * 60)}</option>{/each}</select></label>
    <button on:click={create} disabled={busy}>{$t('social.party.create')}</button>
  {:else}
    <form class="flex" on:submit|preventDefault={search}><input placeholder={$t('social.party.searchPlaceholder')} bind:value={q} /><button>{$t('social.search')}</button></form>
    <div class="grid" style="margin-top:1rem">{#each results as i}<a href="#pick" on:click|preventDefault={() => (pick = i)}><Card item={{ ...i, type: 'Movie' }} /></a>{/each}</div>
  {/if}
</div>
<h3>{$t('social.party.openRooms')}</h3>
{#if !rooms.length}<p class="muted">{$t('social.party.noRooms')}</p>{/if}
<table><tbody>{#each rooms as r}<tr><td>{r.title}</td><td class="muted">{r.hostName ?? ''} · {$t('social.party.members', { n: r.members })}</td><td>{#if r.startAt}<span class="badge">{$t('social.party.startAt', { time: fmtTime(r.startAt) })}</span>{/if}</td><td><a class="btn" href="/party/{r.id}">{$t('social.party.join')}</a></td></tr>{/each}</tbody></table>
