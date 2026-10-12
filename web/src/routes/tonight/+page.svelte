<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, type TKey } from '#lib/i18n';

  // Mood -> genre names (matched case-insensitively against the library's own genre list, German or English metadata)
  const MOODS: Array<{ id: string; label: TKey; re: RegExp }> = [
    { id: 'laugh', label: 'social.tonight.moods.laugh', re: /kom(ö|oe)die|comedy/i },
    { id: 'tension', label: 'social.tonight.moods.tension', re: /thriller|krimi|crime|mystery|horror/i },
    { id: 'action', label: 'social.tonight.moods.action', re: /action|abenteuer|adventure|science|sci-?fi|fantasy/i },
    { id: 'heart', label: 'social.tonight.moods.heart', re: /drama|romanz|romance|liebe/i },
    { id: 'family', label: 'social.tonight.moods.family', re: /familie|family|animation|kinder/i },
    { id: 'know', label: 'social.tonight.moods.know', re: /dokumentation|documentary|geschichte|history|biograf/i },
  ];
  const TIMES: Array<[string, TKey, number]> = [['short', 'social.tonight.times.short', 90], ['normal', 'social.tonight.times.normal', 120], ['long', 'social.tonight.times.long', 0]];
  const KINDS: Array<[string, TKey]> = [['Movie', 'social.tonight.kinds.movie'], ['Series', 'social.tonight.kinds.series'], ['Movie,Series', 'social.tonight.kinds.any']];

  let genres: string[] = [], mood = new Set<string>(), time = 'normal', kind = 'Movie,Series', picks: Item[] | null = null, busy = false, tried = false, seen = new Set<string>();
  onMount(async () => { genres = (await api('/api/library/genres').catch(() => ({ genres: [] }))).genres; });

  const toggle = (id: string) => { const s = new Set(mood); if (s.has(id)) s.delete(id); else s.add(id); mood = s; };
  async function find(again = false) {
    busy = true; tried = true;
    if (!again) seen = new Set();
    const names = MOODS.filter((m) => mood.has(m.id)).flatMap((m) => genres.filter((g) => m.re.test(g)));
    const maxMin = TIMES.find((x) => x[0] === time)![2];
    try {
      const q = new URLSearchParams({ types: kind, filter: 'unplayed', sort: 'Random', limit: '60' });
      if (names.length) q.set('genre', [...new Set(names)].join('|'));
      const items = ((await api(`/api/library/items?${q}`)).items as Item[])
        .filter((i) => !seen.has(i.id) && (!maxMin || i.type === 'Series' || !i.runtimeTicks || i.runtimeTicks <= maxMin * 600_000_000));
      // best rated first among the random draw, so every suggestion is worth it
      picks = items.sort((a, b) => (b.communityRating ?? 0) - (a.communityRating ?? 0)).slice(0, 3);
      picks.forEach((p) => seen.add(p.id));
    } catch { picks = []; }
    busy = false;
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('social.tonight.pageTitle') })}</title></svelte:head>
<h1>{$t('social.tonight.title')}</h1>
<p class="muted">{$t('social.tonight.intro')}</p>

<section class="panel q" aria-label={$t('social.tonight.mood')}>
  <h2>{$t('social.tonight.moodQ')}</h2>
  <div class="chips" role="group" aria-label={$t('social.tonight.moodGroup')}>{#each MOODS as m}<button class="chip" class:on={mood.has(m.id)} aria-pressed={mood.has(m.id)} on:click={() => toggle(m.id)}>{$t(m.label)}</button>{/each}</div>
  <small class="muted">{$t('social.tonight.nothingIsAll')}</small>
</section>
<section class="panel q" aria-label={$t('social.tonight.time')}>
  <h2>{$t('social.tonight.timeQ')}</h2>
  <div class="chips" role="radiogroup">{#each TIMES as [v, l]}<button class="chip" class:on={time === v} role="radio" aria-checked={time === v} on:click={() => (time = v)}>{$t(l)}</button>{/each}</div>
</section>
<section class="panel q" aria-label={$t('social.tonight.kind')}>
  <h2>{$t('social.tonight.kindQ')}</h2>
  <div class="chips" role="radiogroup">{#each KINDS as [v, l]}<button class="chip" class:on={kind === v} role="radio" aria-checked={kind === v} on:click={() => (kind = v)}>{$t(l)}</button>{/each}</div>
</section>

<div class="flex"><button on:click={() => find(false)} disabled={busy}><Icon name="shuffle" size={20} />{$t('social.tonight.show')}</button>{#if picks?.length}<button class="sec" on:click={() => find(true)} disabled={busy}>{$t('social.tonight.again')}</button>{/if}</div>

{#if picks}
  {#if picks.length}<div class="tiles picks">{#each picks as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
  {:else if tried}<p class="muted" style="margin-top:1.5rem">{$t('social.tonight.nothing')}</p>{/if}
{/if}

<style>
  .q h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .4rem; }
  .chip { background: var(--surface-2); border-radius: 999px; font-weight: 500; padding: .5rem 1.1rem; }
  .chip.on { background: #fff; color: #000; }
  .picks { margin-top: 1.5rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
</style>
