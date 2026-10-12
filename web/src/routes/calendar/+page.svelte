<script lang="ts">
  import { t, tr, fmtDate } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { episodeKey, loadReminders, remindKeys, toggleReminder } from '#lib/reminders';
  let items: any[] = [];
  let msg = '';
  onMount(async () => { void loadReminders(); items = (await api('/api/calendar')).items; });
  async function follow(e: any) { await api(`/api/series/${e.seriesId}/follow`, { method: e.followed ? 'DELETE' : 'POST' }); items = items.map((i) => (i.seriesId === e.seriesId ? { ...i, followed: !e.followed } : i)); }
  const future = (e: any) => !e.premiereDate || new Date(e.premiereDate).getTime() > Date.now();
  async function remind(e: any) {
    const r = await toggleReminder(episodeKey(e.id), { episodeId: e.id });
    msg = r === 'available' ? tr('social.calendar.alreadyAvailable') : r === 'error' ? tr('social.calendar.reminderFailed') : '';
  }
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('social.calendar.title') })}</title></svelte:head>
<h1>{$t('social.calendar.title')}</h1>
<p class="muted">{$t('social.calendar.intro')}</p>
{#if msg}<p class="warn" role="status">{msg}</p>{/if}
{#if !items.length}<p class="muted">{$t('social.calendar.none')}</p>{/if}
<table><tbody>{#each items as e}<tr>
  <td>{e.premiereDate ? fmtDate(e.premiereDate, { weekday: 'short', day: '2-digit', month: '2-digit' }) : '?'}</td>
  <td><a href="/item/{e.seriesId}">{e.seriesName}</a> {$t('social.calendar.episodeCode', { s: e.parentIndexNumber, e: e.indexNumber })} – {e.name}</td>
  <td><button class:sec={!e.followed} on:click={() => follow(e)}>{e.followed ? $t('social.calendar.following') : $t('social.calendar.follow')}</button>
    {#if future(e)}
      {#if e.followed}<span class="muted">{$t('social.calendar.viaFollow')}</span>
      {:else}<button class="sec" aria-pressed={$remindKeys[episodeKey(e.id)] !== undefined} aria-label={$t('social.calendar.remindAria')} on:click={() => remind(e)}><Icon name="bell" size={16} /> {$remindKeys[episodeKey(e.id)] !== undefined ? $t('social.calendar.reminderActive') : $t('social.calendar.remindMe')}</button>{/if}
    {/if}</td></tr>{/each}</tbody></table>
