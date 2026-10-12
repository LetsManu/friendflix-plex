<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { castState, castStop, initCast, requestCastSession } from '#lib/cast';
  import { t } from '#lib/i18n';

  export let size = 28;
  /** true while the Player is casting to the receiver */
  export let active = false;
  const dispatch = createEventDispatcher<{ start: void }>();
  /** Loads the SDK lazily (Chromium only). A fresh session is picked up by the Player through the cast events; an already
   *  connected session (another page, auto-join) is started with the `start` event. */
  onMount(() => { void initCast(); });
  function click() {
    if (!$castState.connected) void requestCastSession();
    else if (active) castStop();
    else dispatch('start');
  }
</script>

{#if $castState.available || $castState.connected}
  <button class="ic" class:on={active} aria-pressed={active}
    aria-label={active ? $t('player.cast.stopOn', { name: $castState.deviceName || 'Chromecast' }) : $castState.connected ? $t('player.cast.playOn', { name: $castState.deviceName || 'Chromecast' }) : $t('player.cast.castTo')}
    title={active ? $t('player.cast.connectedTo', { name: $castState.deviceName || 'Chromecast' }) : $t('player.cast.castTo')} on:click={click}>
    <Icon name="cast" {size} />
  </button>
{/if}

<style>
  /* same look as the player's control-bar icon buttons (scoped styles of the Player do not reach child components) */
  .ic { display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 0; padding: 0; width: 48px; min-height: 48px; border-radius: 50%; color: #fff; cursor: pointer; transition: transform .12s, background .12s; }
  .ic:hover { background: rgba(255,255,255,.14); transform: scale(1.08); }
  .ic.on { color: var(--acc); }
  :global(html.tv) .ic { width: 64px; min-height: 64px; }
  @media (max-width: 720px) { .ic { width: 44px; } }
</style>
