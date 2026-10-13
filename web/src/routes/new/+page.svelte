<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, backdrop, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import TrailerButton from '#lib/TrailerButton.svelte';
  import { loadReminders, movieKey, remindKeys, toggleReminder } from '#lib/reminders';
  import { openModal } from '#lib/modal';
  import { openPreview } from '#lib/previewSheet';
  import { mobile } from '#lib/viewport';
  import { firstNonEmptyTab } from '#lib/home';
  import { genreLine, NEW_TABS, dateBlock, releaseLabel, runtimeLabel, sortUpcoming, type NewTab } from '#lib/mobile';
  import { t, tr } from '#lib/i18n';

  type Up = { tmdbId: number; mediaType: string; title: string; releaseDate?: string; overview?: string; poster?: string; status: string };
  let upcoming: Up[] | null = null, week: Item[] | null = null, added: Item[] | null = null, msg = '';
  let availNow = new Set<number>();

  // without ?tab the page opens on the first tab that has something to show (e.g. "Diese Woche" when nothing is upcoming)
  $: explicit = ((t) => (NEW_TABS.some(([id]) => id === t) ? (t as NewTab) : null))($page.url.searchParams.get('tab'));
  $: auto = firstNonEmptyTab(NEW_TABS.map(([id]) => id), { soon: upcoming, week, added });
  $: tab = explicit ?? auto ?? 'soon';
  $: deciding = !explicit && auto === null;
  const select = (t: NewTab) => goto(`?tab=${t}`, { replaceState: true, reset: false });
  // roving arrow keys on the chip row
  function chipKey(e: KeyboardEvent) {
    const i = NEW_TABS.findIndex(([id]) => id === tab);
    const n = e.key === 'ArrowRight' ? (i + 1) % NEW_TABS.length : e.key === 'ArrowLeft' ? (i + NEW_TABS.length - 1) % NEW_TABS.length : -1;
    if (n < 0) return;
    e.preventDefault(); select(NEW_TABS[n]![0]);
    queueMicrotask(() => document.getElementById(`nt-${NEW_TABS[n]![0]}`)?.focus());
  }

  onMount(() => {
    void loadReminders();
    Promise.all([
      api('/api/seerr/upcoming?type=movie').then((r) => r.results as Up[]).catch(() => [] as Up[]),
      api('/api/seerr/upcoming?type=tv').then((r) => r.results as Up[]).catch(() => [] as Up[]),
    ]).then(([m, t]) => (upcoming = sortUpcoming([...m, ...t]).slice(0, 40)));
    api('/api/library/trending').then((r) => (week = (r.items as Item[]).map((i) => ({ ...i, caption: i.viewers ? tr('home.meta.watching', { n: i.viewers }) : i.caption })))).catch(() => (week = []));
    api('/api/library/items?types=Movie,Series&sort=DateCreated&desc=true&limit=30').then((r) => (added = r.items)).catch(() => (added = []));
  });

  async function remind(it: Up) {
    const r = await toggleReminder(movieKey(it.mediaType, it.tmdbId), { mediaType: it.mediaType, tmdbId: it.tmdbId });
    if (r === 'busy') return;
    if (r === 'available') { availNow.add(it.tmdbId); availNow = availNow; msg = tr('home.upcoming.isAvailable', { title: it.title }); }
    else if (r === 'error') msg = tr('home.upcoming.remindFailed');
    else msg = r === 'on' ? tr('home.upcoming.remindSet', { title: it.title }) : tr('home.upcoming.remindRemoved');
  }
  function open(e: MouseEvent, it: Item) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if ($mobile) { e.preventDefault(); openPreview(it, e.currentTarget as HTMLElement); } else openModal(e, `/item/${it.id}`);
  }
  $: list = tab === 'week' ? week : added;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('home.new.title') })}</title></svelte:head>
<h1 class="ph1">{$t('home.new.title')}</h1>
<div class="chips" role="tablist" aria-label={$t('home.new.tabs')} tabindex="-1">
  {#each NEW_TABS as [id, label] (id)}
    <button type="button" role="tab" id="nt-{id}" class="chip" class:on={tab === id} aria-selected={tab === id} aria-controls="np" tabindex={tab === id ? 0 : -1} on:click={() => select(id)} on:keydown={chipKey}>{$t(label)}</button>
  {/each}
</div>

<div id="np" role="tabpanel" aria-labelledby="nt-{tab}" class="panel2" aria-busy={deciding}>
  {#if deciding}
    {#each Array(3) as _}<div class="entry plain"><div class="body"><div class="skeleton img"></div></div></div>{/each}
  {:else if tab === 'soon'}
    {#if upcoming === null}
      {#each Array(3) as _}<div class="entry"><div class="skeleton dsk"></div><div class="body"><div class="skeleton img"></div></div></div>{/each}
    {:else if !upcoming.length}
      <p class="muted">{$t('home.new.noUpcoming')}</p>
    {:else}
      <ul class="elist">
        {#each upcoming as it (it.mediaType + it.tmdbId)}
          {@const db = dateBlock(it.releaseDate)}
          <li class="entry">
            <div class="date" aria-hidden={db ? undefined : 'true'}>{#if db}<span class="mo">{db.month}</span><span class="dy">{db.day}</span>{/if}</div>
            <div class="body">
              <div class="img poster">
                {#if it.poster}<img class="bl" loading="lazy" src={it.poster} alt="" aria-hidden="true" /><img class="pp" loading="lazy" src={it.poster} alt="" />{:else}<span class="noimg">{it.title}</span>{/if}
              </div>
              <h2>{it.title}</h2>
              <p class="rel">{releaseLabel(it.releaseDate)} · {it.mediaType === 'tv' ? $t('home.meta.series') : $t('home.meta.movie')}</p>
              {#if it.overview}<p class="ov">{it.overview}</p>{/if}
              {#if it.status === 'verfuegbar'}<p class="ok">{$t('home.upcoming.available')}</p>
              {:else}
                <div class="btns">
                  {#if availNow.has(it.tmdbId)}<span class="ok">{$t('home.upcoming.alreadyAvailable')}</span>
                  {:else}<button type="button" class="sec" aria-pressed={$remindKeys[movieKey(it.mediaType, it.tmdbId)] !== undefined} on:click={() => remind(it)}><Icon name="bell" size={18} />{$remindKeys[movieKey(it.mediaType, it.tmdbId)] !== undefined ? $t('home.upcoming.reminderOn') : $t('home.upcoming.remind')}</button>{/if}
                  <TrailerButton mediaType={it.mediaType} tmdbId={it.tmdbId} title={it.title} />
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if msg}<p class="muted" role="status">{msg}</p>{/if}
      <p><a class="btn sec" href="/calendar">{$t('home.new.toCalendar')}</a></p>
    {/if}
  {:else if list === null}
    {#each Array(3) as _}<div class="entry plain"><div class="body"><div class="skeleton img"></div></div></div>{/each}
  {:else if !list.length}
    <p class="muted">{$t('home.new.nothing')}</p>
  {:else}
    <ol class="elist" class:ranked={tab === 'week'}>
      {#each list as it, i (it.id)}
        <li class="entry plain">
          {#if tab === 'week'}<span class="rank" aria-label={$t('home.row.rank', { n: i + 1 })}>{i + 1}</span>{/if}
          <div class="body">
            <a class="img" href="/item/{it.id}" aria-label={$t('home.new.details', { name: it.name })} on:click={(e) => open(e, it)}>
              {#if it.backdrop}<img loading="lazy" src={backdrop(it.id, 780)} alt="" />{:else if it.image}<img class="bl" loading="lazy" src={img(it.id, 320)} alt="" aria-hidden="true" /><img class="pp" loading="lazy" src={img(it.id, 320)} alt="" />{:else}<span class="noimg">{it.name}</span>{/if}
              <span class="playi" aria-hidden="true"><Icon name="play" size={20} /></span>
            </a>
            <h2><a href="/item/{it.id}" on:click={(e) => open(e, it)}>{it.name}</a></h2>
            <p class="rel">{[it.caption, it.year ? String(it.year) : '', runtimeLabel(it), genreLine(it.genres, 2)].filter(Boolean).join(' · ')}</p>
            {#if it.overview}<p class="ov">{it.overview}</p>{/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .ph1 { margin-bottom: .6rem; }
  .chips { position: sticky; top: var(--nav-total); z-index: 5; display: flex; gap: .5rem; overflow-x: auto; scrollbar-width: none; padding: .5rem 0 .6rem; margin: 0 calc(var(--pad-x) * -1) .6rem; padding-inline: var(--pad-x); background: var(--bg); }
  .chips::-webkit-scrollbar { display: none; }
  .chip::after { content: ''; position: absolute; inset: -2px 0; }
  .chip { position: relative; flex: none; min-height: 40px; padding: 0 1rem; border-radius: 99px; background: transparent; border: 1px solid rgba(255,255,255,.5); color: #fff; font-weight: 500; font-size: .92rem; white-space: nowrap; }
  .chip:hover:not(:disabled) { background: rgba(255,255,255,.12); }
  .chip.on, .chip.on:hover:not(:disabled) { background: #fff; color: #000; border-color: #fff; font-weight: 700; }
  .panel2 { max-width: 900px; padding-bottom: 3rem; }
  .elist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1.8rem; }
  .entry { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: .8rem; }
  .entry.plain { grid-template-columns: minmax(0, 1fr); }
  .elist.ranked .entry.plain { grid-template-columns: 44px minmax(0, 1fr); }
  .date { display: flex; flex-direction: column; align-items: center; padding-top: .2rem; line-height: 1; }
  .mo { font-size: .75rem; font-weight: 700; letter-spacing: .06em; color: var(--mut); }
  .dy { font-size: 1.7rem; font-weight: 800; margin-top: .2rem; }
  .rank { font-size: 2.6rem; font-weight: 900; line-height: 1; color: #fff; text-align: center; padding-top: .2rem; letter-spacing: -.04em; }
  .body { min-width: 0; }
  .img { position: relative; display: block; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #1c2228; margin-bottom: .6rem; }
  .img img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .img.poster img.bl { position: absolute; inset: 0; filter: blur(18px) brightness(.7); transform: scale(1.3); }
  .img img.pp { position: absolute; inset: 0; object-fit: contain; }
  .img:not(.poster) img.pp { object-fit: contain; }
  .img img.bl { position: absolute; inset: 0; filter: blur(18px) brightness(.7); transform: scale(1.3); }
  .noimg { position: absolute; inset: 0; display: grid; place-items: center; padding: .6rem; text-align: center; font-weight: 700; background: linear-gradient(160deg, #252c34, #161b21); }
  .playi { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2px solid rgba(255,255,255,.85); background: rgba(0,0,0,.5); display: grid; place-items: center; padding-left: 2px; }
  h2 { font-size: 1.1rem; font-weight: 700; margin: 0 0 .15rem; }
  h2 a:hover { text-decoration: underline; }
  .rel { margin: 0 0 .4rem; color: var(--mut); font-size: .88rem; }
  .ov { margin: 0 0 .7rem; font-size: .92rem; line-height: 1.45; color: #d6d6d6; display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .btns { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  .btns :global(button) { font-size: .9rem; }
  .dsk { height: 3rem; }
  .skeleton.img { aspect-ratio: 16 / 9; }
  @media (min-width: 721px) {
    .entry { grid-template-columns: 80px minmax(0, 1fr); gap: 1.4rem; }
    .elist.ranked .entry.plain { grid-template-columns: 70px minmax(0, 1fr); }
    .rank { font-size: 4rem; }
    .dy { font-size: 2.2rem; } .mo { font-size: .85rem; }
    .body { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); column-gap: 1.2rem; align-items: start; }
    .body .img { grid-row: 1 / span 4; margin: 0; }
    .body > :not(.img) { grid-column: 2; }
  }
</style>
