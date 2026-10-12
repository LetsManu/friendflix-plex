<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { playSonicLogo, stopSonicLogo } from '#lib/sonic';
  import { t } from '#lib/i18n';

  /** Play the sonic logo along with the animation (only sensible after a user gesture). */
  export let sound = false;
  /** Hard upper bound: the overlay is gone after this long even if no animationend ever fires. */
  const FALLBACK_MS = 3900;
  const FALLBACK_REDUCED_MS = 1300;

  const dispatch = createEventDispatcher<{ done: void }>();
  const uid = 'ffi' + Math.random().toString(36).slice(2, 7);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const letters = [...'FriendFlix'];

  let root: HTMLElement;
  let skipping = false, finished = false;
  let fallback: ReturnType<typeof setTimeout>, skipTimer: ReturnType<typeof setTimeout>;
  let returnFocus: HTMLElement | null = null;
  const born = Date.now();

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(fallback); clearTimeout(skipTimer);
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', onPointer, true);
    const el = returnFocus;
    if (el && el.isConnected) { try { el.focus({ preventScroll: true }); } catch { /* element not focusable any more */ } }
    dispatch('done');
  }

  function skip() {
    if (skipping || finished) return;
    skipping = true;
    void stopSonicLogo(140);
    skipTimer = setTimeout(finish, 220); // the .skip fade is 150 ms; the timer covers a missing animationend
  }
  function onPointer(e: Event) {
    if (Date.now() - born < 150) return; // the click that opened the intro must not close it
    e.preventDefault(); e.stopPropagation();
    skip();
  }
  function onKey(e: KeyboardEvent) {
    // the intro owns the keyboard while it is up: nothing behind it may be activated or tabbed to
    if (e.key === 'Tab') { e.preventDefault(); return; }
    if (e.repeat) { e.preventDefault(); return; }
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); skip(); }
  }
  function onEnd(e: AnimationEvent) {
    if (e.target !== root) return;
    if (/(ff-out|ff-rm|ff-skip)$/.test(e.animationName)) finish();
  }

  onMount(() => {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    returnFocus?.blur();
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onPointer, true);
    fallback = setTimeout(finish, reduced ? FALLBACK_REDUCED_MS : FALLBACK_MS);
    if (sound) void playSonicLogo();
    return () => { if (!finished) { finished = true; clearTimeout(fallback); clearTimeout(skipTimer); removeEventListener('keydown', onKey, true); removeEventListener('pointerdown', onPointer, true); void stopSonicLogo(100); } };
  });
</script>

<div class="intro" class:rm={reduced} class:leaving={skipping} bind:this={root} role="presentation" on:animationend={onEnd}>
  <p class="sr" role="status">{$t('home.intro.loading')}</p>
  <div class="stage" aria-hidden="true">
    <div class="tilewrap">
      <div class="glow"></div>
      <div class="flare"></div>
      <svg class="tile" viewBox="0 0 64 64" focusable="false">
        <defs>
          <linearGradient id="{uid}g" x1="8" y1="2" x2="56" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff6b81" /><stop offset="1" stop-color="#e23c5b" /></linearGradient>
          <linearGradient id="{uid}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0" /><stop offset=".5" stop-color="#fff" stop-opacity=".85" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient>
          <clipPath id="{uid}c"><rect x="2" y="2" width="60" height="60" rx="15" /></clipPath>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#{uid}g)" />
        <!-- the F is drawn along its centre line first, then the solid shape of the real mark takes over -->
        <path class="fstroke" pathLength="1" d="M23.500 49V22.500Q23.500 18 28 18H46" fill="none" stroke="#fff" stroke-width="9" stroke-linejoin="round" />
        <path class="ffill" fill="#fff" d="M19 18a4 4 0 0 1 4-4h23a4 4 0 0 1 0 8H28v28a4.500 4.500 0 0 1-9 0z" />
        <path class="play" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round" d="M33.500 29.500 45.500 36 33.500 42.500z" />
        <g clip-path="url(#{uid}c)"><rect class="sweep" x="-12" y="-6" width="22" height="76" fill="url(#{uid}s)" /></g>
      </svg>
      <div class="ring"></div>
    </div>
    <div class="word">{#each letters as ch, i}<span class="ch" style="--i:{i}">{ch}</span>{/each}</div>
  </div>
</div>

<style>
  /* one continuous timeline (~3.2 s) in step with sonic.ts: tile + swell 0-0.9 s, F drawn 0.4-1.1 s on the rising notes,
     play mark + flare + sweep on the chord at 1.2 s, wordmark 1.3-2.1 s, then a soft coral ring expands once from the tile
     (1.9-3.0 s) while the stage eases to 1.04 and the overlay fades out (2.7-3.2 s). Only transform and opacity animate,
     and every phase overlaps the next so the motion never stops or jumps. */
  .intro { position: fixed; inset: 0; z-index: 10000; background: #000; display: grid; place-items: center; overflow: hidden; cursor: pointer; animation: ff-out .5s cubic-bezier(.4, 0, .2, 1) 2.7s both; contain: strict; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: 0; }
  .stage { --tile: clamp(104px, 22vmin, 176px); position: relative; display: grid; justify-items: center; gap: clamp(.9rem, 3.2vmin, 1.7rem); will-change: transform; animation: ff-stage 3.2s linear both; }
  .glow { position: absolute; inset: -110%; border-radius: 50%; background: radial-gradient(circle, rgba(255, 79, 109, .45) 0%, rgba(255, 79, 109, .14) 38%, transparent 68%); opacity: 0; pointer-events: none; will-change: transform, opacity; animation: ff-bloom 3.2s cubic-bezier(.22, 1, .36, 1) .05s both; }
  .tilewrap { position: relative; width: var(--tile); aspect-ratio: 1; will-change: transform, opacity; animation: ff-tile .95s cubic-bezier(.16, 1, .3, 1) .05s both; }
  .tile { display: block; width: 100%; height: 100%; overflow: visible; }
  .flare { position: absolute; inset: -30%; border-radius: 50%; background: radial-gradient(circle, rgba(255, 255, 255, .5) 0%, rgba(255, 120, 140, .22) 30%, transparent 62%); opacity: 0; will-change: transform, opacity; animation: ff-flare 1.1s cubic-bezier(.22, 1, .36, 1) 1.18s both; }
  .fstroke { stroke-dasharray: 1 1; animation: ff-draw .7s cubic-bezier(.65, 0, .35, 1) .4s both, ff-hide .3s ease-in-out 1s forwards; }
  .ffill { animation: ff-fade .3s ease-in-out 1s both; }
  .play { transform-box: fill-box; transform-origin: center; animation: ff-play .55s cubic-bezier(.34, 1.36, .64, 1) 1.02s both; }
  .sweep { opacity: 0; animation: ff-sweep .85s cubic-bezier(.45, 0, .25, 1) 1.2s both; }
  /* the ring: a soft coral radial band (transparent centre) that grows from the tile once and fades while it travels */
  .ring { position: absolute; inset: -4%; border-radius: 50%; opacity: 0; pointer-events: none; background: radial-gradient(circle, transparent 52%, rgba(255, 79, 109, .55) 60%, rgba(255, 79, 109, .18) 70%, transparent 78%); will-change: transform, opacity; animation: ff-ring 1.15s cubic-bezier(.2, .6, .25, 1) 1.9s both; }
  .word { display: flex; align-items: baseline; font-weight: 800; font-size: clamp(1.2rem, 3.8vmin, 2.1rem); letter-spacing: -.005em; color: #fff; }
  .ch { display: inline-block; will-change: transform, opacity; animation: ff-letter .75s cubic-bezier(.16, 1, .3, 1) calc(1.3s + var(--i) * 45ms) both; }

  /* gentle drift in, then a slow ease to 1.04 as the overlay fades */
  @keyframes ff-stage { 0% { transform: scale(.94); animation-timing-function: cubic-bezier(.33, 0, .2, 1); } 40% { transform: scale(1.02); animation-timing-function: cubic-bezier(.3, 0, .4, 1); } 100% { transform: scale(1.04); } }
  @keyframes ff-tile { from { opacity: 0; transform: scale(.72); } to { opacity: 1; transform: scale(1); } }
  @keyframes ff-bloom { 0% { opacity: 0; transform: scale(.6); } 35% { opacity: .85; transform: scale(1.05); } 100% { opacity: 0; transform: scale(1.25); } }
  @keyframes ff-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes ff-hide { to { opacity: 0; } }
  @keyframes ff-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ff-play { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: scale(1); } }
  @keyframes ff-sweep { 0% { opacity: 0; transform: translateX(-12px) skewX(-18deg); } 25% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; transform: translateX(78px) skewX(-18deg); } }
  @keyframes ff-flare { 0% { opacity: 0; transform: scale(.6); } 25% { opacity: .5; } 100% { opacity: 0; transform: scale(1.5); } }
  @keyframes ff-letter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes ff-ring { 0% { opacity: 0; transform: scale(.7); } 20% { opacity: .9; } 100% { opacity: 0; transform: scale(3.4); } }
  @keyframes ff-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes ff-skip { from { opacity: 1; } to { opacity: 0; } }
  @keyframes ff-rm { 0% { opacity: 0; } 33% { opacity: 1; } 67% { opacity: 1; } 100% { opacity: 0; } }

  /* reduced motion: the finished logo, faded in and out over 300 ms each; no ring, no sweep, no drawing */
  .rm { animation: ff-rm .9s linear both !important; }
  .rm .stage, .rm .glow, .rm .tilewrap, .rm .tile, .rm .flare, .rm .fstroke, .rm .ffill, .rm .play, .rm .sweep, .rm .ring, .rm .word, .rm .ch { animation: none !important; }
  .rm .fstroke, .rm .flare, .rm .sweep, .rm .ring { display: none; }
  .rm .glow { opacity: .3; transform: none; }

  .leaving { animation: ff-skip .15s linear both !important; pointer-events: none; }
</style>
