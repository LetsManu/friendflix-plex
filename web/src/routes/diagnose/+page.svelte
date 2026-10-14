<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import { airLogStart, clearAirLog, formatAirLog, readAirLog, type AirLogEntry } from '#lib/player/airplayLog';
  import { formatTiming, readLocalTimings, type StoredTiming } from '#lib/player/timing';

  type Row = [string, string];
  let rows: Row[] = [];
  let probe: HTMLElement, svh: HTMLElement, lvh: HTMLElement, dvh: HTMLElement, vh: HTMLElement;
  let table: HTMLElement;
  let note = '';
  // AirPlay event log (lib/player/airplayLog.ts): no URLs / tokens are ever stored there
  let air: AirLogEntry[] = [];
  let airNote = '';
  let airPre: HTMLElement;
  const airText = () => formatAirLog(air, airLogStart());
  const readAir = () => { air = readAirLog(); };
  async function copyAir() {
    try {
      await navigator.clipboard.writeText(airText());
      airNote = $t('diagnose.copied');
    } catch {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(airPre);
      sel?.removeAllRanges();
      sel?.addRange(range);
      airNote = $t('diagnose.copyFailed');
    }
  }
  // this device's last start-time measurements (lib/player/timing.ts; readLocalTimings never throws)
  let timings: StoredTiming[] = [];

  function clearAir() { clearAirLog(); readAir(); airNote = ''; }

  const r1 = (n: number) => String(Math.round(n * 100) / 100);
  const rect = (el: Element | null) => {
    if (!el) return 'n/a';
    const b = el.getBoundingClientRect();
    return `top ${r1(b.top)}  bottom ${r1(b.bottom)}  height ${r1(b.height)}`;
  };
  const meta = (name: string) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? 'n/a';
  const mq = (q: string) => String(window.matchMedia(q).matches);

  function measure() {
    if (!probe) return;
    const cs = getComputedStyle(probe);
    const vv = window.visualViewport;
    const h = (el: HTMLElement) => r1(el.getBoundingClientRect().height);
    const de = document.documentElement, b = document.body;
    rows = [
      ['innerWidth x innerHeight', `${window.innerWidth} x ${window.innerHeight}`],
      ['outerWidth x outerHeight', `${window.outerWidth} x ${window.outerHeight}`],
      ['screen.width x height', `${screen.width} x ${screen.height}`],
      ['screen.availHeight', String(screen.availHeight)],
      ['devicePixelRatio', String(window.devicePixelRatio)],
      ['documentElement.clientHeight', String(de.clientHeight)],
      ['body.clientHeight', String(b.clientHeight)],
      ['body.scrollHeight', String(b.scrollHeight)],
      ['visualViewport width x height', vv ? `${r1(vv.width)} x ${r1(vv.height)}` : 'n/a'],
      ['visualViewport offsetTop', vv ? r1(vv.offsetTop) : 'n/a'],
      ['visualViewport pageTop', vv ? r1(vv.pageTop) : 'n/a'],
      ['visualViewport scale', vv ? r1(vv.scale) : 'n/a'],
      ['env(safe-area-inset-top)', cs.paddingTop],
      ['env(safe-area-inset-right)', cs.paddingRight],
      ['env(safe-area-inset-bottom)', cs.paddingBottom],
      ['env(safe-area-inset-left)', cs.paddingLeft],
      ['100vh', h(vh)],
      ['100svh', h(svh)],
      ['100lvh', h(lvh)],
      ['100dvh', h(dvh)],
      ['display-mode standalone', mq('(display-mode: standalone)')],
      ['display-mode fullscreen', mq('(display-mode: fullscreen)')],
      ['display-mode minimal-ui', mq('(display-mode: minimal-ui)')],
      ['display-mode browser', mq('(display-mode: browser)')],
      ['navigator.standalone', String((navigator as Navigator & { standalone?: boolean }).standalone)],
      ['.tabbar rect', rect(document.querySelector('.tabbar'))],
      ['.nav.m rect', rect(document.querySelector('.nav.m'))],
      ['meta viewport', meta('viewport')],
      ['meta apple-mobile-web-app-status-bar-style', meta('apple-mobile-web-app-status-bar-style')],
      ['meta theme-color', meta('theme-color')],
      ['navigator.userAgent', navigator.userAgent],
    ];
  }

  async function copy() {
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      note = $t('diagnose.copied');
    } catch {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(table);
      sel?.removeAllRanges();
      sel?.addRange(range);
      note = $t('diagnose.copyFailed');
    }
  }

  onMount(() => {
    measure();
    readAir();
    timings = readLocalTimings();
    const id = setInterval(measure, 1000);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      clearInterval(id);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  });
</script>

<svelte:head><title>{$t('diagnose.title')}</title></svelte:head>

<div class="page">
  <h1>{$t('diagnose.title')}</h1>
  <p class="hint">{$t('diagnose.hint')}</p>
  <button type="button" on:click={copy}>{$t('diagnose.copy')}</button>
  {#if note}<span role="status" class="note">{note}</span>{/if}
  <table bind:this={table} data-testid="diagnose-table">
    <tbody>
      {#each rows as [k, v] (k)}
        <tr><th scope="row">{k}</th><td>{v}</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>{$t('diagnose.airplayTitle')}</h2>
  <p class="hint">{$t('diagnose.airplayHint')}</p>
  <div class="row">
    <button type="button" on:click={copyAir} disabled={!air.length}>{$t('diagnose.airplayCopy')}</button>
    <button type="button" on:click={clearAir} disabled={!air.length}>{$t('diagnose.airplayClear')}</button>
    {#if airNote}<span role="status" class="note">{airNote}</span>{/if}
  </div>
  {#if air.length}<pre class="airlog" bind:this={airPre} data-testid="airplay-log">{formatAirLog(air, airLogStart())}</pre>
  {:else}<p class="hint" data-testid="airplay-log-empty">{$t('diagnose.airplayEmpty')}</p>{/if}

  <h2>{$t('diagnose.timingTitle')}</h2>
  <p class="hint">{$t('diagnose.timingHint')}</p>
  {#if timings.length}<pre class="airlog" data-testid="timing-log">{timings.map(formatTiming).join('\n\n')}</pre>
  {:else}<p class="hint" data-testid="timing-log-empty">{$t('diagnose.timingEmpty')}</p>{/if}
</div>

<div class="probe" bind:this={probe} aria-hidden="true"></div>
<div class="unit vh" bind:this={vh} aria-hidden="true"></div>
<div class="unit svh" bind:this={svh} aria-hidden="true"></div>
<div class="unit lvh" bind:this={lvh} aria-hidden="true"></div>
<div class="unit dvh" bind:this={dvh} aria-hidden="true"></div>
<div class="edge top" aria-hidden="true"></div>
<div class="edge bottom" aria-hidden="true"></div>
<div class="edge safe" aria-hidden="true"></div>

<style>
  .hint { color: var(--mut); }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 15px; user-select: text; -webkit-user-select: text; }
  th, td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid #2b333c; vertical-align: top; word-break: break-word; }
  th { font-weight: 600; color: #cfd6dd; width: 48%; }
  .note { margin-left: .8rem; }
  h2 { margin-top: 2rem; }
  .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .airlog { margin-top: 1rem; padding: .6rem; background: #12171c; border: 1px solid #2b333c; border-radius: 6px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; }
  .probe { position: fixed; visibility: hidden; pointer-events: none; width: 0; height: 0; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .unit { position: fixed; left: 0; width: 1px; top: 0; visibility: hidden; pointer-events: none; }
  .vh { height: 100vh; } .svh { height: 100svh; } .lvh { height: 100lvh; } .dvh { height: 100dvh; }
  .edge { position: fixed; z-index: 200; pointer-events: none; }
  .top { top: 0; left: 0; right: 0; height: 1px; background: blue; }
  .bottom { bottom: 0; left: 0; right: 0; height: 1px; background: red; }
  .safe { bottom: env(safe-area-inset-bottom); left: 0; right: 0; height: 12px; border: 1px solid #0f0; box-sizing: border-box; }
</style>
