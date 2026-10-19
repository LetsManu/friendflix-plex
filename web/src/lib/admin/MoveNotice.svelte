<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "FriendFlix for Plex has moved" notice (admins only). `hideable` = the slim bar under the app bar (hidden for 7 days per admin);
   * not hideable = the fixed notice at the top of Admin → Update. Mounted by the root layout under the same conditions as HealthBanner.
   */
  import Icon from '#lib/Icon.svelte';
  import { locale, t } from '#lib/i18n';
  import { hideMove, moveGuideUrl, moveHidden } from './moveNotice';

  export let uid = '';
  export let hideable = true;
  export let hero = false;
  /** the health banner is shown right above (hero pages: no second top offset) */
  export let afterBanner = false;
  let hidden = hideable && moveHidden(uid);
  const hide = () => { hideMove(uid); hidden = true; };
</script>

{#if !hidden}
  <div class="mv" class:hero class:after={afterBanner} class:fixed={!hideable} role="note" aria-label={$t('admin.move.label')}>
    <span class="ic" aria-hidden="true"><Icon name="clock" size={20} /></span>
    <p class="msg">{$t('admin.move.text')} <a class="lnk" href={moveGuideUrl($locale)} target="_blank" rel="noopener noreferrer">{$t('admin.move.link')}</a></p>
    {#if hideable}<button type="button" class="x" aria-label={$t('admin.move.hide')} title={$t('admin.move.hide')} on:click={hide}><Icon name="x" size={20} /></button>{/if}
  </div>
{/if}

<style>
  .mv { display: flex; align-items: center; gap: .3rem .6rem; margin: 0 0 1rem; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: var(--tone-warn); padding: .15rem .3rem .15rem .8rem; color: var(--fg); min-width: 0; min-height: 44px; }
  .mv.hero { margin: var(--nav-total) var(--pad-x) 0; }
  .mv.hero.after { margin-top: .5rem; }
  .ic { display: grid; place-items: center; flex: none; color: var(--warn); }
  .msg { flex: 1 1 auto; min-width: 0; margin: 0; padding: .4rem 0; font-weight: 600; font-size: .92rem; overflow-wrap: anywhere; }
  .lnk { color: var(--fg); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; display: inline-block; padding: .5rem .25rem; margin: -.5rem 0; }
  .x { background: transparent; color: var(--fg); width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; flex: none; }
  .x:hover { background: rgba(255,255,255,.1); }
</style>
