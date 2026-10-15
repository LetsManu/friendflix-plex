<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The frame of the public sign-in pages (/login, /pending; later /reset and /confirm-email): the logo, the cover wall and one card.
   * Desktop: the card is centred, at most 420px wide. Phone: the card sits at the bottom with a 16px gutter (and the safe areas).
   */
  import Logo from '#lib/Logo.svelte';
  import CoverWall from './CoverWall.svelte';
  /** extra class on the card (e.g. `center` for the notice screens) */
  export let center = false;
</script>

<div class="shell">
  <CoverWall />
  <div class="in">
    <div class="logo"><Logo wordmark size={34} /></div>
    <main class="card" class:center id="main" tabindex="-1">
      <slot />
    </main>
  </div>
</div>

<style>
  .shell { position: relative; min-height: 100vh; min-height: 100dvh; overflow: hidden; background: var(--bg); }
  .in { position: relative; z-index: 1; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column;
    padding: calc(1.5rem + var(--safe-top)) max(16px, var(--safe-right)) calc(16px + var(--safe-bottom)) max(16px, var(--safe-left)); }
  .logo { display: flex; align-self: flex-start; }
  .card { margin-top: auto; width: 100%; background: rgba(22, 27, 33, .86); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid var(--line); border-radius: 16px; padding: 20px; outline: none; }
  .card.center { text-align: center; }
  .card :global(h1) { margin: 0 0 4px; font-size: 1.35rem; }
  .card :global(.sub) { margin: 0 0 16px; color: var(--mut); font-size: .9rem; }
  @media (min-width: 640px) {
    .in { padding-bottom: calc(2rem + var(--safe-bottom)); }
    .card { margin: auto; max-width: 420px; padding: 28px; }
  }
</style>
