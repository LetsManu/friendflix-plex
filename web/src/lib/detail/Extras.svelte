<script lang="ts">
  import { img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  /** Jellyfin special features and local trailers; `kind` comes from GET /api/items/:id/extras/all */
  export let items: Array<Item & { kind?: 'trailer' | 'extra' }>;
  /** query string (audio/sub choice) appended to the player links */
  export let qs = '';

  let failed = new Set<string>();
  const mins = (x: Item) => (x.runtimeTicks ? Math.max(1, Math.round(x.runtimeTicks / 600_000_000)) : 0);
</script>

<ul class="ex">
  {#each items as x (x.id)}
    <li>
      <a href={qs ? `/watch/${x.id}?${qs}` : `/watch/${x.id}`} aria-label={$t('hubs.extras.play', { name: x.name })}>
        <span class="im">
          {#if x.image && !failed.has(x.id)}<img loading="lazy" decoding="async" src={img(x.id, 320)} alt="" on:error={() => (failed = new Set([...failed, x.id]))} />{/if}
          <span class="pl" aria-hidden="true"><Icon name="play" size={22} /></span>
          {#if mins(x)}<span class="dur">{$t('common.duration.m', { m: mins(x) })}</span>{/if}
        </span>
        <span class="bd">
          <span class="kind">{x.kind === 'trailer' ? $t('hubs.extras.trailer') : $t('hubs.extras.extra')}</span>
          <span class="nm">{x.name}</span>
        </span>
      </a>
    </li>
  {/each}
</ul>

<style>
  .ex { list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  @media (max-width: 340px) { .ex { grid-template-columns: minmax(0, 1fr); } }
  a { display: flex; flex-direction: column; height: 100%; background: #2f2f2f; border-radius: 6px; overflow: hidden; transition: background var(--t-fast), transform var(--t-med) var(--ease); }
  a:hover, a:focus-visible { background: #3a3a3a; }
  .im { position: relative; display: block; aspect-ratio: 16 / 9; background: #222; }
  .im img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pl { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; opacity: .9; }
  .pl :global(svg) { padding: .55rem; box-sizing: content-box; background: rgba(0, 0, 0, .55); border: 2px solid rgba(255, 255, 255, .8); border-radius: 50%; }
  .dur { position: absolute; right: .5rem; top: .5rem; background: rgba(0, 0, 0, .65); padding: .05rem .45rem; border-radius: 3px; font-size: .75rem; font-weight: 600; }
  .bd { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .8rem .9rem; }
  .kind { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .nm { font-weight: 600; overflow-wrap: anywhere; }
</style>
