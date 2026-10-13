<script lang="ts">
  /**
   * The version as a button with the codename easter egg: 7 taps (or 7× OK on a TV remote) open a card with the
   * release's snack; from the 4th tap a hint counts down ("3 more…", like Android's build number).
   * Popcorn rain on top unless motion is reduced (prefers-reduced-motion / calm mode). The card is a modal dialog:
   * focus stays inside, Esc / Back / a click closes it and focus returns to the button.
   */
  import { onDestroy, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { t, trDynamic } from '#lib/i18n';
  import { motionAllowed } from '#lib/preview';
  import { isBackKey } from '#lib/spatial';
  import { CODENAMES, codenameEntry, shortVersion } from './codenames';
  import { EGG_START, eggTap } from './egg';

  export let version: string;
  export let codename: string;
  /** visible text (default "1.0.0 · Arancini") */
  export let label = '';

  const RAIN_MS = 2600;
  const uid = `egg-${Math.random().toString(36).slice(2, 8)}`;
  let state = EGG_START;
  let remaining: number | null = null;
  let open = false, rain = false;
  let btn: HTMLButtonElement, closeBtn: HTMLButtonElement;
  let rainTimer: ReturnType<typeof setTimeout> | undefined, hintTimer: ReturnType<typeof setTimeout> | undefined;

  $: text = label || `${version} · ${codename}`;
  $: snack = codenameEntry(codename, version);
  $: hue = snack ? Math.round((CODENAMES.indexOf(snack) * 360) / CODENAMES.length) : 40;
  $: line = snack ? trDynamic(`version.snack.${snack.id}`) : '';
  $: letter = (snack?.name ?? codename ?? '?').charAt(0).toUpperCase();

  /** popcorn kernels: position, delay, size and spin are fixed per open so the layout stays stable */
  let kernels: Array<{ x: number; d: number; s: number; r: number; dur: number }> = [];

  function tap() {
    const r = eggTap(state, Date.now());
    state = r.state;
    remaining = r.remaining;
    clearTimeout(hintTimer);
    if (remaining) hintTimer = setTimeout(() => (remaining = null), 2500);
    if (r.open) void show();
  }

  async function show() {
    remaining = null;
    rain = motionAllowed();
    if (rain) {
      kernels = Array.from({ length: 28 }, () => ({ x: Math.random() * 100, d: Math.random() * 900, s: 0.7 + Math.random() * 0.8, r: Math.round(Math.random() * 720 - 360), dur: 1300 + Math.random() * 400 }));
      clearTimeout(rainTimer);
      rainTimer = setTimeout(() => (rain = false), RAIN_MS);
    }
    open = true;
    await tick();
    closeBtn?.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    rain = false;
    clearTimeout(rainTimer);
    btn?.focus();
  }

  function onCardKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' && isBackKey(e)) { e.preventDefault(); e.stopPropagation(); close(); }
  }

  /** the layer lives in <body>, above every stacking context of the page */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  onDestroy(() => { clearTimeout(rainTimer); clearTimeout(hintTimer); });
</script>

<span class="egg">
  <button bind:this={btn} type="button" class="ver" on:click={tap}>{text}</button>
  <span class="hint" class:on={remaining} aria-live="polite">{remaining ? $t('version.egg.hint', { n: remaining }) : ''}</span>
</span>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="layer" use:portal on:click={close}>
    {#if rain}
      <div class="rain" data-egg-rain aria-hidden="true">
        {#each kernels as k, i (i)}
          <span class="pop" style="left:{k.x}%; animation-delay:{k.d}ms; animation-duration:{k.dur}ms; --s:{k.s}; --r:{k.r}deg">
            <svg viewBox="0 0 32 32" width="28" height="28"><g fill="#fff6dc" stroke="#e2b85a" stroke-width="1.2"><circle cx="11" cy="13" r="6.5" /><circle cx="20" cy="11.5" r="6" /><circle cx="22.5" cy="19.5" r="5.5" /><circle cx="15" cy="21" r="6.5" /><circle cx="8.5" cy="20" r="4.5" /></g><circle cx="15.5" cy="16" r="2.2" fill="#f2c14e" /></svg>
          </span>
        {/each}
      </div>
    {/if}
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="{uid}-t" aria-describedby="{uid}-d" tabindex="-1" use:dialogKeys={{ close }} on:keydown={onCardKey}>
      <svg class="art" viewBox="0 0 120 96" width="120" height="96" aria-hidden="true" style="--h:{hue}">
        <ellipse cx="60" cy="88" rx="40" ry="5" fill="rgba(0,0,0,.25)" />
        <g class="heap"><circle cx="38" cy="38" r="13" /><circle cx="56" cy="30" r="15" /><circle cx="76" cy="36" r="13" /><circle cx="88" cy="46" r="9" /><circle cx="30" cy="48" r="9" /></g>
        <path class="bowl" d="M18 46 h84 l-9 36 a6 6 0 0 1 -6 5 H33 a6 6 0 0 1 -6 -5 Z" />
        <path class="rim" d="M16 44 h88 a3 3 0 0 1 0 6 H16 a3 3 0 0 1 0 -6 Z" />
        <text x="60" y="76" text-anchor="middle">{letter}</text>
      </svg>
      <p class="kicker">{$t('version.egg.kicker')}</p>
      <h2 id="{uid}-t">{shortVersion(version)} {codename}</h2>
      <p id="{uid}-d" class="line">{line}</p>
      <button bind:this={closeBtn} type="button" class="close" on:click|stopPropagation={close}>{$t('version.egg.close')}</button>
    </div>
  </div>
{/if}

<style>
  .egg { position: relative; display: inline-flex; align-items: center; gap: .5rem; }
  .ver { background: transparent; border: 0; padding: .2rem 0; min-height: 0; color: inherit; font: inherit; font-weight: 400; cursor: default; }
  .ver:hover:not(:disabled) { background: transparent; color: inherit; }
  .ver:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 2px; }
  /* floats above the button: appearing never shifts the layout */
  .hint { position: absolute; bottom: calc(100% + 4px); right: 0; padding: .15rem .55rem; border-radius: 99px; background: rgba(16, 20, 26, .94); color: #e6e9ec; font-size: .78rem; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .15s; }
  .hint.on { opacity: 1; }

  .layer { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 1rem; background: rgba(5, 7, 10, .72); }
  .rain { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 1; }
  .pop { position: absolute; top: -40px; transform: scale(var(--s)); animation-name: fall; animation-timing-function: cubic-bezier(.3, .1, .7, 1); animation-fill-mode: both; }
  @keyframes fall {
    from { transform: translateY(0) rotate(0) scale(var(--s)); opacity: 1; }
    85% { opacity: 1; }
    to { transform: translateY(calc(100vh + 80px)) rotate(var(--r)) scale(var(--s)); opacity: 0; }
  }
  .card { position: relative; z-index: 2; width: min(22rem, 100%); padding: 1.6rem 1.4rem 1.3rem; border-radius: 16px; background: #161b22; color: #fff; text-align: center; box-shadow: 0 20px 60px rgba(0, 0, 0, .55); border: 1px solid rgba(255, 255, 255, .08); outline: none; }
  .art { display: block; margin: 0 auto .4rem; }
  .art .heap { fill: hsl(var(--h) 85% 82%); stroke: hsl(var(--h) 55% 55%); stroke-width: 1.5; }
  .art .bowl { fill: hsl(var(--h) 70% 52%); }
  .art .rim { fill: hsl(var(--h) 70% 42%); }
  .art text { font: 800 26px/1 system-ui, sans-serif; fill: #fff; }
  .kicker { margin: 0; font-size: .75rem; letter-spacing: .12em; text-transform: uppercase; color: #9aa4ae; }
  h2 { margin: .2rem 0 .6rem; font-size: 1.9rem; line-height: 1.15; }
  .line { margin: 0 0 1.2rem; color: #d5dbe1; line-height: 1.45; }
  .close { min-height: 44px; padding: .4rem 1.4rem; }
  @media (prefers-reduced-motion: reduce) { .pop { animation: none; display: none; } }
</style>
