<script lang="ts">
  import { hubGlow, hubGradient, type Hub } from '#lib/hubs';
  import { t } from '#lib/i18n';

  /** Brand hub tiles under the billboard (Block 15). Renders nothing while loading, on errors and when no hub is defined. The home page loads them (GET /api/home, or /api/hubs as fallback). */
  export let hubs: Hub[] = [];
  let failedImg = new Set<string>();
</script>

{#if hubs.length}
  <section class="hubs" aria-label={$t('hubs.strip.label')}>
    <ul>
      {#each hubs as h (h.id)}
        <li>
          <a class="tile" href="/hub/{h.id}" aria-label={$t('hubs.strip.open', { name: h.name })} style="--hb:{hubGradient(h)};--glow:{hubGlow(h)}">
            {#if h.imageUrl && !failedImg.has(h.id)}<img src={h.imageUrl} alt="" loading="lazy" decoding="async" on:error={() => (failedImg = new Set([...failedImg, h.id]))} />{/if}
            <span class="shade" aria-hidden="true"></span>
            <span class="nm" aria-hidden="true">{h.name}</span>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .hubs { position: relative; z-index: 2; margin: 1.4rem 0 0; }
  ul { list-style: none; margin: 0; padding: .9rem var(--pad-x) 1.1rem; display: flex; gap: .9rem; overflow-x: auto; scrollbar-width: none; scroll-snap-type: x proximity; scroll-padding: 0 var(--pad-x); }
  ul::-webkit-scrollbar { display: none; }
  li { flex: 0 0 clamp(168px, 46vw, 250px); scroll-snap-align: start; min-width: 0; }
  @media (min-width: 800px) { li { flex-basis: clamp(190px, 17vw, 270px); } }
  .tile { position: relative; display: block; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background-color: #1c2228; background-image: var(--hb); border: 1px solid rgba(255, 255, 255, .14); box-shadow: 0 4px 14px rgba(0, 0, 0, .45); transition: transform var(--t-med) var(--ease), box-shadow var(--t-med) var(--ease), border-color var(--t-fast); }
  .tile img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  /* the name must stay readable on any artwork */
  .shade { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0, 0, 0, .72), rgba(0, 0, 0, .1) 62%); }
  .nm { position: absolute; left: .8rem; right: .8rem; bottom: .6rem; font-weight: 800; font-size: clamp(.95rem, .5vw + .8rem, 1.2rem); line-height: 1.15; letter-spacing: -.01em; text-shadow: 0 1px 8px rgba(0, 0, 0, .8); overflow-wrap: anywhere; }
  .tile:hover, .tile:focus-visible { transform: translateY(-4px) scale(1.035); border-color: rgba(255, 255, 255, .6); box-shadow: 0 12px 26px rgba(0, 0, 0, .6), 0 0 22px -2px var(--glow); }
  @media (prefers-reduced-motion: reduce) { .tile { transition: border-color var(--t-fast), box-shadow var(--t-fast); } .tile:hover, .tile:focus-visible { transform: none; } }
  :global(html.tv) .tile:focus-visible { transform: scale(1.08); }
</style>
