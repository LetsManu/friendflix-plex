<script lang="ts">
  import { t, tr, fmtDate } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import Row from '#lib/Row.svelte';

  interface Data {
    newMovies: Array<{ id: string; name: string; year?: number }>; newMovieCount: number;
    newEpisodes: Array<{ seriesId: string; seriesName: string; count: number; followed: boolean; episodes: Array<{ id: string; name: string; season?: number; episode?: number }> }>; newEpisodeCount: number;
    available: Array<{ title: string; link: string | null; itemId: string | null }>;
    recommendations: Array<{ itemId: string; name: string; from: string; note: string | null; kind: 'recommended' | 'friends' }>;
  }
  let digest: { week: string; sentAt: string; data: Data } | null | undefined;
  let byId: Record<string, Item> = {};
  let movies: Item[] | null = null, series: Item[] | null = null, avail: Item[] | null = null, recs: Item[] | null = null;

  const pick = (ids: string[]): Item[] => ids.flatMap((id) => (byId[id] ? [byId[id]!] : []));
  const cap = (items: Item[], c: Map<string, string>) => items.map((i) => ({ ...i, caption: c.get(i.id) }));
  onMount(async () => {
    try {
      const r = await api('/api/digest/latest');
      digest = r.digest ? { week: r.digest.week, sentAt: r.digest.sentAt, data: r.digest.data } : null;
      byId = r.digest?.items ?? {};
    } catch { digest = null; }
    const d = digest?.data;
    if (!d) return;
    movies = pick(d.newMovies.map((m) => m.id));
    series = cap(pick(d.newEpisodes.map((g) => g.seriesId)), new Map(d.newEpisodes.map((g) => [g.seriesId, `${tr('social.digest.newEpisodes', { n: g.count })}${g.followed ? ' · ' + tr('social.digest.following') : ''}`])));
    avail = pick(d.available.flatMap((a) => (a.itemId ? [a.itemId] : [])));
    recs = cap(pick(d.recommendations.map((r) => r.itemId)), new Map(d.recommendations.map((r) => [r.itemId, r.kind === 'friends' ? tr('social.digest.ratedBy', { name: r.from }) : r.note ? tr('social.digest.fromNote', { name: r.from, note: r.note }) : tr('social.digest.from', { name: r.from })])));
  });
  $: pending = digest?.data.available.filter((a) => !a.itemId) ?? [];
  const when = (iso: string) => fmtDate(iso, { day: '2-digit', month: 'long', year: 'numeric' });
</script>
<svelte:head><title>{$t('common.pageTitle', { page: $t('social.digest.title') })}</title></svelte:head>
<h1>{$t('social.digest.title')}</h1>
{#if digest === undefined}
  <p class="muted" aria-busy="true">{$t('common.loading')}</p>
{:else if !digest}
  <p class="muted">{$t('social.digest.none')}</p>
{:else}
  <p class="muted">{$t('social.digest.summaryOf', { date: when(digest.sentAt) })}</p>
  <div class="bleed">
    <Row title={$t('social.digest.rowNew')} items={movies} />
    <Row title={$t('social.digest.rowEpisodes')} items={series} />
    <Row title={$t('social.digest.rowWishes')} items={avail} />
    {#if pending.length}<ul class="plain">{#each pending as a}<li>{a.title}</li>{/each}</ul>{/if}
    <Row title={$t('social.digest.rowFriends')} items={recs} />
  </div>
  {#if digest.data.newMovieCount > digest.data.newMovies.length}<p class="muted">{$t('social.digest.moreMovies', { n: digest.data.newMovieCount - digest.data.newMovies.length })}</p>{/if}
{/if}
<style>
  .bleed { margin: 0 calc(var(--pad-x) * -1); }
  .plain { margin: 1rem var(--pad-x) 0; color: var(--mut); }
</style>
