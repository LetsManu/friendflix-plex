<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<svelte:head><title>{$t('common.pageTitle', { page: $t('kids.search.pageTitle') })}</title></svelte:head>
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import KidsTile from '../KidsTile.svelte';

  /** Kids search: one big field, titles only (no people, genres or episodes), big tiles. Jellyfin filters by the kids cap. */
  let q = '', items: Item[] | null = null, failed = false, busy = false, timer: ReturnType<typeof setTimeout>, seq = 0;
  let input: HTMLInputElement;

  async function run(v: string) {
    const term = v.trim();
    void goto(term ? `/kids/search?q=${encodeURIComponent(term)}` : '/kids/search', { replace: true, reset: false });
    if (term.length < 2) { items = null; failed = false; return; }
    const my = ++seq;
    busy = true;
    try {
      const r = await api<{ titles: Item[] }>(`/api/search?q=${encodeURIComponent(term)}`);
      if (my === seq) { items = r.titles ?? []; failed = false; }
    } catch { if (my === seq) { items = null; failed = true; } }
    finally { if (my === seq) busy = false; }
  }
  const onInput = () => { clearTimeout(timer); timer = setTimeout(() => run(q), 300); };
  onMount(() => {
    q = new URLSearchParams(location.search).get('q') ?? '';
    if (q) void run(q);
    input?.focus();
    return () => clearTimeout(timer);
  });
</script>

<div class="kids-page">
  <a class="back" href="/kids"><Icon name="chevron-left" size={22} />{$t('kids.search.back')}</a>
  <h1>{$t('kids.search.title')}</h1>
  <form class="field" role="search" on:submit|preventDefault={() => { clearTimeout(timer); void run(q); }}>
    <Icon name="search" size={30} />
    <input bind:this={input} bind:value={q} on:input={onInput} type="search" enterkeyhint="search" autocomplete="off" aria-label={$t('kids.search.label')} placeholder={$t('kids.search.placeholder')} />
  </form>

  <div class="results" aria-live="polite" aria-busy={busy}>
    {#if failed}<p class="note" role="alert">{$t('kids.search.failed')}</p>
    {:else if items === null}<p class="note muted">{$t('kids.search.hint')}</p>
    {:else if !items.length}<p class="note">{$t('kids.search.none')}</p>
    {:else}
      <div class="grid" data-nav>{#each items as item (item.id)}<KidsTile {item} />{/each}</div>
    {/if}
  </div>
</div>

<style>
  .kids-page { --k-ink: #20233a; --k-card: #fff; --k-focus: #ffb703; --k-accent: #ff5d8f; min-height: 100vh; min-height: 100dvh; padding: calc(var(--nav-total) + 1rem) var(--pad-x) 3rem; color: var(--k-ink);
    background: radial-gradient(circle at 88% 6%, #ffe8a3 0, transparent 34%), linear-gradient(180deg, #c9f0d8 0%, #ecfbf2 60%, #fffaf0 100%); }
  .back { display: inline-flex; align-items: center; gap: .3rem; min-height: 44px; font-weight: 800; color: #2d6a4f; }
  .back:focus-visible { outline: 4px solid var(--k-focus); border-radius: 12px; }
  h1 { margin: .4rem 0 1rem; font-size: clamp(1.6rem, 4.5vw, 2.6rem); font-weight: 900; }
  .field { display: flex; align-items: center; gap: .8rem; max-width: 720px; min-height: 72px; padding: 0 1.4rem; border-radius: 99px; background: #fff; box-shadow: 0 8px 20px rgba(32, 35, 58, .12); color: #5b6280; }
  .field:focus-within { box-shadow: 0 0 0 5px var(--k-focus), 0 8px 20px rgba(32, 35, 58, .12); }
  .field input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: 1.4rem; font-weight: 700; color: var(--k-ink); min-height: 64px; padding: 0; }
  .field input:focus-visible { outline: none; }
  .field input::placeholder { color: #9aa0b8; }
  .results { margin-top: 1.6rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 40vw), 1fr)); gap: 1.2rem; }
  .grid :global(.tile) { width: auto; }
  .note { font-size: 1.2rem; font-weight: 700; }
  .muted { color: #5b6280; }
</style>
