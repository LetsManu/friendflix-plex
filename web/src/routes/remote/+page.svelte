<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, fmtClock, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import { castToTv, holdRemote, sendToTv, tvOnline, tvStatus } from '#lib/remote';

  let release: (() => void) | undefined;
  let codeIn = '', fromLink = false, msg = '', msgOk = false, busy = false, pairOpen = true;
  let resume: Item[] = [], nextUp = new Map<string, Item>(), q = '', results: Item[] | null = null, sent = '', sentT: ReturnType<typeof setTimeout>, seq = 0, searchT: ReturnType<typeof setTimeout>;

  $: st = $tvStatus;
  $: playing = Boolean(st?.itemId);
  $: pct = st?.duration ? Math.min(100, ((st.position ?? 0) / st.duration) * 100) : 0;
  $: if ($tvOnline) pairOpen = false;

  const fmtCode = (v: string) => { const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c; };
  const onCode = () => (codeIn = fmtCode(codeIn));

  async function pair() {
    busy = true; msg = ''; msgOk = false;
    try {
      await api('/api/tv/pair', { method: 'POST', body: { code: codeIn } });
      msg = tr('player.remote.paired'); msgOk = true; codeIn = ''; fromLink = false;
    } catch (e: any) {
      msg = e?.status === 404 ? tr('player.remote.unknownCode') : e?.status === 409 ? tr('player.remote.codeUsed') : tr('player.remote.pairFailed');
    }
    busy = false;
  }

  const confirmed = (t: string) => { sent = t; clearTimeout(sentT); sentT = setTimeout(() => (sent = ''), 2500); };
  async function ctl(action: 'play' | 'pause' | 'toggle' | 'seekBy' | 'stop' | 'home' | 'next' | 'audio' | 'sub', value?: number) {
    if (!(await sendToTv({ t: 'ctl', action, value }))) confirmed(tr('player.remote.noConnection'));
  }
  async function cast(id: string, name: string) {
    confirmed((await castToTv(id)) ? tr('player.remote.starting', { name }) : tr('player.remote.noConnection'));
  }
  /** what a click on "play on TV" starts: movies/episodes directly, series via their next-up episode */
  const target = (i: Item): Item | null => (i.type === 'Series' ? nextUp.get(i.id) ?? null : i);

  function search() {
    clearTimeout(searchT);
    const term = q.trim();
    if (term.length < 2) { results = null; return; }
    const my = ++seq;
    searchT = setTimeout(async () => {
      try { const r = (await api(`/api/library/items?q=${encodeURIComponent(term)}&types=Movie,Series&limit=12`)).items as Item[]; if (my === seq) results = r; } catch { if (my === seq) results = []; }
    }, 250);
  }

  onMount(() => {
    release = holdRemote();
    const c = $page.url.searchParams.get('code');
    if (c) { codeIn = fmtCode(c); fromLink = true; }
    api('/api/library/resume').then((r) => (resume = r.items)).catch(() => undefined);
    api('/api/library/nextup').then((r) => (nextUp = new Map((r.items as Item[]).filter((e) => e.seriesId).map((e) => [e.seriesId!, e])))).catch(() => undefined);
  });
  onDestroy(() => { release?.(); clearTimeout(sentT); clearTimeout(searchT); });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('player.remote.title') })}</title></svelte:head>
<div class="remote">
  <h1><Icon name="tv" size={30} /> {$t('player.remote.title')}</h1>

  <section class="panel status" aria-live="polite">
    <div class="state"><span class="led" class:on={$tvOnline} aria-hidden="true"></span><b>{$tvOnline ? $t('player.remote.tvConnected') : $t('player.remote.noTv')}</b></div>
    {#if $tvOnline}
      {#if playing}
        <p class="now"><b>{st?.title ?? $t('player.remote.playback')}</b><span class="muted">{st?.paused ? $t('player.remote.paused') : $t('player.remote.playing')}{st?.duration ? ` · ${fmtClock(st.position ?? 0)} / ${fmtClock(st.duration)}` : ''}</span></p>
        <div class="bar" aria-hidden="true"><i style="width:{pct}%"></i></div>
      {:else}<p class="muted">{$t('player.remote.tvHome')}</p>{/if}
    {:else}
      <p class="muted"><Rich key="player.remote.howTo" params={{ host: location.host }} /></p>
    {/if}
  </section>

  {#if $tvOnline}
    <section class="panel pad" aria-label={$t('player.remote.controls')}>
      <div class="keys">
        <button class="sec" aria-label={$t('player.remote.back60')} on:click={() => ctl('seekBy', -60)}>−60</button>
        <button class="sec" aria-label={$t('player.remote.back10')} on:click={() => ctl('seekBy', -10)}><Icon name="rewind10" size={30} /></button>
        <button class="main light" aria-label={st?.paused === false ? $t('player.remote.pause') : $t('player.remote.play')} on:click={() => ctl('toggle')}><Icon name={st?.paused === false ? 'pause' : 'play'} size={38} /></button>
        <button class="sec" aria-label={$t('player.remote.forward10')} on:click={() => ctl('seekBy', 10)}><Icon name="forward10" size={30} /></button>
        <button class="sec" aria-label={$t('player.remote.forward60')} on:click={() => ctl('seekBy', 60)}>+60</button>
      </div>
      <div class="flex keys2">
        <button class="sec" on:click={() => ctl('stop')} disabled={!playing}><Icon name="stop" size={18} />{$t('player.remote.stop')}</button>
        <button class="sec" on:click={() => ctl('next')} disabled={!playing}><Icon name="skip-next" size={20} />{$t('player.remote.next')}</button>
        <button class="sec" on:click={() => ctl('home')}><Icon name="home" size={20} />{$t('player.remote.home')}</button>
      </div>
      {#if st?.audio && st.audio.length > 1}
        <label class="tl" for="aud">{$t('player.remote.audio')}</label>
        <select id="aud" value={st.audioSel} on:change={(e) => ctl('audio', Number(e.currentTarget.value))}>{#each st.audio as a}<option value={a.i}>{a.t}</option>{/each}</select>
      {/if}
      {#if st?.subs && st.subs.length}
        <label class="tl" for="sbt">{$t('player.remote.subtitles')}</label>
        <select id="sbt" value={st.subSel ?? -1} on:change={(e) => ctl('sub', Number(e.currentTarget.value))}><option value={-1}>{$t('player.remote.off')}</option>{#each st.subs as a}<option value={a.i}>{a.t}</option>{/each}</select>
      {/if}
    </section>

    {#if resume.length}
      <h2>{$t('player.remote.continueWatching')}</h2>
      <ul class="list">
        {#each resume.slice(0, 10) as i (i.id)}
          <li>
            <span class="th">{#if i.image}<img loading="lazy" src={img(i.id, 200)} alt="" />{/if}</span>
            <span class="tx"><b>{i.seriesName ?? i.name}</b><span class="muted">{i.type === 'Episode' ? `S${i.parentIndexNumber}:E${i.indexNumber} · ${i.name}` : i.year ?? ''}</span></span>
            <button class="light" on:click={() => cast(i.id, i.seriesName ?? i.name)}><Icon name="play" size={18} />{$t('player.remote.onTv')}</button>
          </li>
        {/each}
      </ul>
    {/if}

    <h2>{$t('player.remote.search')}</h2>
    <form role="search" on:submit|preventDefault={search}>
      <label class="sr-only" for="rq">{$t('player.remote.search')}</label>
      <input id="rq" class="wide" type="search" placeholder={$t('player.remote.searchPlaceholder')} bind:value={q} on:input={search} />
    </form>
    {#if results}
      <ul class="list">
        {#each results as i (i.id)}
          {@const tg = target(i)}
          <li>
            <span class="th">{#if i.image}<img loading="lazy" src={img(i.id, 200)} alt="" />{/if}</span>
            <span class="tx"><b>{i.name}</b><span class="muted">{i.type === 'Series' ? $t('player.remote.series') : i.year ?? ''}</span></span>
            {#if tg}<button class="light" on:click={() => cast(tg.id, i.name)}><Icon name="play" size={18} />{i.type === 'Series' ? `S${tg.parentIndexNumber}:E${tg.indexNumber}` : $t('player.remote.onTv')}</button>
            {:else}<a class="btn sec" href="/item/{i.id}">{$t('player.remote.episodes')}</a>{/if}
          </li>
        {:else}<li class="muted">{$t('player.remote.noResults')}</li>{/each}
      </ul>
    {/if}
  {/if}

  <details class="panel pair" bind:open={pairOpen}>
    <summary><b>{$tvOnline ? $t('player.remote.pairAnother') : $t('player.remote.pair')}</b></summary>
    <p class="muted"><Rich key="player.remote.pairHow" params={{ host: location.host }} /></p>
    {#if fromLink}<p class="warn" role="note"><Rich key="player.remote.linkWarn" params={{ code: codeIn }} /></p>{/if}
    <form class="flex" on:submit|preventDefault={pair}>
      <label class="sr-only" for="code">{$t('player.remote.codeLabel')}</label>
      <input id="code" class="code" bind:value={codeIn} on:input={onCode} placeholder="ABCD-EFGH" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="9" />
      <button disabled={busy || codeIn.replace('-', '').length < 8}>{$t('player.remote.pairButton')}</button>
    </form>
    {#if msg}<p role="status" class:ok={msgOk} class:err={!msgOk}>{msg}</p>{/if}
    <p class="muted small">{$t('player.remote.pairNote')}</p>
  </details>

  {#if sent}<div class="toast" role="status">{sent}</div>{/if}
</div>

<style>
  .remote { max-width: 720px; }
  h1 { display: flex; align-items: center; gap: .6rem; }
  .state { display: flex; align-items: center; gap: .6rem; }
  .led { width: 12px; height: 12px; border-radius: 50%; background: #6a7480; } .led.on { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  .now { display: flex; flex-direction: column; margin: .6rem 0 .4rem; }
  .keys { display: grid; grid-template-columns: 1fr 1fr 1.5fr 1fr 1fr; gap: .6rem; align-items: stretch; }
  .keys button { min-height: 64px; font-size: 1.05rem; padding: 0; min-width: 0; }
  .keys .main { min-height: 78px; border-radius: 14px; }
  .keys2 { margin-top: .8rem; }
  .tl { display: block; margin: .9rem 0 .2rem; } select { width: 100%; }
  .pad { padding: 1.1rem; }
  .list { list-style: none; padding: 0; margin: 0 0 1.2rem; display: grid; gap: .5rem; }
  .list li { display: grid; grid-template-columns: 92px 1fr auto; gap: .8rem; align-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .5rem .7rem .5rem .5rem; }
  .th { aspect-ratio: 16 / 9; background: #1c2228; border-radius: 4px; overflow: hidden; display: block; } .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { display: flex; flex-direction: column; min-width: 0; } .tx b, .tx .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wide { width: 100%; font-size: 1.05rem; margin-bottom: .8rem; }
  .pair { margin-top: 1.5rem; } summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .code { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 1.5rem; letter-spacing: .15em; text-transform: uppercase; width: 11ch; text-align: center; }
  .small { font-size: .85rem; }
  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(76px + env(safe-area-inset-bottom)); background: rgba(16,20,24, .96); border: 1px solid #3b444e; padding: .7rem 1.1rem; border-radius: 8px; z-index: 70; max-width: 90vw; }
</style>
