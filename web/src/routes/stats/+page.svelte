<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { localWeekday, shareCard } from '#lib/wrapped';
  import { t, fmtDate, fmtDuration, hasKey, trDynamic } from '#lib/i18n';
  let s: any = null, c: any = null, year = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => fmtDate(new Date(2024, i, 1), { month: 'short' }));
  /** achievement text in the UI language (keyed by the backend key; unknown achievements keep the server text) */
  const ach = (a: { key?: string; title: string; desc: string }, f: 'title' | 'desc') => (a.key && hasKey(`social.stats.ach.${a.key}.${f}`) ? trDynamic(`social.stats.ach.${a.key}.${f}`) : a[f]);
  async function load() { s = await api(`/api/stats/me?year=${year}`); c = await api('/api/stats/community'); }
  onMount(load);
  $: max = s ? Math.max(1, ...s.byMonth.map((m: any) => m.minutes)) : 1;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('social.stats.title') })}</title></svelte:head>
<h1>{$t('social.stats.title')} <select bind:value={year} on:change={load}>{#each [0, 1, 2] as d}<option>{new Date().getFullYear() - d}</option>{/each}</select></h1>
{#if s}
  <p><button on:click={() => shareCard(s)}><Icon name="share" size={18} />{$t('social.stats.share')}</button></p>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
    <div class="panel"><h2>{fmtDuration(s.totalMinutes * 60)}</h2><span class="muted">{$t('social.stats.watched')}</span></div>
    <div class="panel"><h2>{s.titles}</h2><span class="muted">{$t('social.stats.distinctTitles')}</span></div>
    <div class="panel"><h2>{s.movies} / {s.episodes}</h2><span class="muted">{$t('social.stats.moviesEpisodes')}</span></div>
    <div class="panel"><h2>{localWeekday(s.favoriteWeekday) ?? '–'}</h2><span class="muted">{$t('social.stats.favoriteDay')}</span></div>
  </div>
  <div class="panel"><h3>{$t('social.stats.top5')}</h3><ol>{#each s.topItems as ti}<li>{ti.name} <span class="muted">· {fmtDuration(ti.minutes * 60)}</span></li>{/each}</ol></div>
  <div class="panel"><h3>{$t('social.stats.perMonth')}</h3>
    <div style="display:flex;gap:.4rem;align-items:flex-end;height:120px">
      {#each months as m, i}{@const v = s.byMonth.find((x: any) => x.m === i + 1)?.minutes ?? 0}
        <div style="flex:1;text-align:center"><div style="background:var(--acc);height:{(v / max) * 100}px;border-radius:3px 3px 0 0" title={fmtDuration(v * 60)}></div><small class="muted">{m}</small></div>{/each}
    </div></div>
  <h3>{$t('social.stats.achievements')}</h3>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
    {#each s.achievements as a}<div class="panel" style="opacity:{a.earnedAt ? 1 : 0.4}"><span class="ach"><Icon name={a.icon} size={26} /></span> <b>{ach(a, 'title')}</b><br /><small class="muted">{ach(a, 'desc')}</small></div>{/each}
  </div>
{/if}
{#if c}
  <h3>{$t('social.stats.groupMonth')}</h3>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
    <div class="panel"><b>{$t('social.stats.leaderboard')}</b><ol>{#each c.leaderboard as l}<li>{l.name} <span class="muted">· {$t('common.duration.h', { h: Math.round(l.minutes / 60 * 10) / 10 })}</span></li>{/each}</ol></div>
    <div class="panel"><b>{$t('social.stats.mostWatched')}</b><ol>{#each c.topTitles as tt}<li>{tt.name} <span class="muted">· {$t('social.stats.viewers', { n: tt.viewers })}</span></li>{/each}</ol></div>
  </div>
{/if}
<style>.ach { display: inline-grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: var(--surface-2); color: var(--acc); vertical-align: middle; }</style>
