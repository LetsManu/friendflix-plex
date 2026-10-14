<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { fmtDate, t, tr } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import TrailerButton from '#lib/TrailerButton.svelte';
  import Icon from '#lib/Icon.svelte';
  import { loadReminders, movieKey, remindKeys, toggleReminder } from '#lib/reminders';

  /** "Demnächst": upcoming releases from Seerr with a one-click wish. */
  export let type: 'movie' | 'tv' = 'movie';
  /** '' = "Demnächst im Kino" in the UI language */
  export let title = '';
  $: heading = title || $t('home.upcoming.title');
  let items: Array<{ tmdbId: number; mediaType: string; title: string; releaseDate?: string; poster?: string; status: string }> | null = null;
  let msg = '';
  const fmt = (d?: string) => (d ? fmtDate(d, { day: '2-digit', month: 'short', year: 'numeric' }) : tr('home.meta.dateOpen'));
  let avail = new Set<number>();
  async function remind(it: NonNullable<typeof items>[number]) {
    const r = await toggleReminder(movieKey(it.mediaType, it.tmdbId), { mediaType: it.mediaType, tmdbId: it.tmdbId });
    if (r === 'busy') return;
    if (r === 'available') { avail.add(it.tmdbId); avail = avail; msg = tr('home.upcoming.isAvailable', { title: it.title }); }
    else if (r === 'error') msg = tr('home.upcoming.remindFailed');
    else msg = r === 'on' ? tr('home.upcoming.remindSet', { title: it.title }) : tr('home.upcoming.remindRemoved');
  }
  onMount(() => { void loadReminders(); api(`/api/seerr/upcoming?type=${type}`).then((r) => (items = r.results)).catch(() => (items = [])); });
  async function wish(it: NonNullable<typeof items>[number]) {
    try { await api('/api/requests', { method: 'POST', body: { mediaType: it.mediaType, tmdbId: it.tmdbId } }); it.status = 'angefragt'; items = items; msg = tr('home.upcoming.wishSent', { title: it.title }); }
    catch (e) { msg = e instanceof ApiError && e.status === 409 ? tr('home.upcoming.wishExists') : tr('home.upcoming.wishFailed'); }
  }
</script>

{#if items === null || items.length}
  <section class="up" aria-label={heading} aria-busy={items === null}>
    <h2>{heading}</h2>
    <div class="track">
      {#if items === null}{#each Array(7) as _}<div class="skeleton ph"></div>{/each}
      {:else}{#each items as it (it.tmdbId)}
        <article class="c">
          {#if it.poster}<img loading="lazy" src={it.poster} alt="" />{:else}<div class="noimg">{it.title}</div>{/if}
          <div class="t"><b class="name">{it.title}</b><span class="muted">{fmt(it.releaseDate)}</span>
            <div class="act">
              {#if it.status === 'nicht_angefragt' || it.status === 'abgelehnt'}<button class="sec" on:click={() => wish(it)}>{$t('home.upcoming.wish')}</button>
              {:else if it.status === 'verfuegbar'}<span class="ok">{$t('home.upcoming.available')}</span>{:else}<span class="warn">{$t('home.upcoming.wished')}</span>{/if}
            </div>
            {#if it.status !== 'verfuegbar'}
              <div class="act tr">
                {#if avail.has(it.tmdbId)}<span class="ok">{$t('home.upcoming.alreadyAvailable')}</span>
                {:else}<button class="sec bell" aria-pressed={$remindKeys[movieKey(it.mediaType, it.tmdbId)] !== undefined} on:click={() => remind(it)}><Icon name="bell" size={16} /> {$remindKeys[movieKey(it.mediaType, it.tmdbId)] !== undefined ? $t('home.upcoming.reminderOn') : $t('home.upcoming.remind')}</button>{/if}
              </div>
              <div class="act tr"><TrailerButton mediaType={it.mediaType} tmdbId={it.tmdbId} title={it.title} /></div>{/if}
          </div>
        </article>{/each}{/if}
    </div>
    {#if msg}<p class="muted" role="status">{msg}</p>{/if}
  </section>
{/if}

<style>
  .up { margin: 1.6rem 0 0; position: relative; z-index: 1; }
  h2 { font-size: clamp(1.05rem, 1.6vw, 1.4rem); font-weight: 600; margin: 0 var(--pad-x) .6rem; }
  .track { display: flex; gap: .6rem; overflow-x: auto; padding: 0 var(--pad-x) .8rem; scrollbar-width: thin; scroll-snap-type: x proximity; }
  .c, .ph { flex: 0 0 150px; scroll-snap-align: start; } .ph { aspect-ratio: 2 / 3; }
  .c { background: var(--surface); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; }
  .c img, .noimg { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; background: #1c2228; display: grid; place-items: center; text-align: center; padding: .4rem; }
  /* Cards stretch to the tallest one; the text block fills the card and the action sits at the bottom, so all buttons line up */
  .t { flex: 1; padding: .5rem .6rem .7rem; display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
  .name { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.6em; line-height: 1.3; } /* always two lines of space */
  .act { margin-top: auto; padding-top: .35rem; min-height: 44px; display: flex; align-items: center; }
  .bell { display: inline-flex; gap: .3rem; align-items: center; justify-content: center; } .bell[aria-pressed='true'] { color: var(--accent, inherit); }
  .act.tr { margin-top: 0; padding-top: 0; min-height: 0; }
  .act button, .act :global(button) { width: 100%; min-height: 36px; padding: .3rem .6rem; font-size: .85rem; }
</style>
