<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The end states of a flow that are no step: denied, locked, expired, unavailable and classic (a stage FriendFlix does not show: it
   * continues on the sign-in page, so a custom Authentik flow never locks anyone out). The sign-in page is always offered where it can
   * help. Never navigates: `retry` (unavailable) and `restart` are for the page; the links use `classicHref`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import './auth.css';

  export let kind: 'denied' | 'locked' | 'expired' | 'unavailable' | 'classic';
  export let classicHref: string;
  /** a more precise text than the kind's default (e.g. why the sign-in service is unavailable) */
  export let text: TKey | null = null;
  /** the label of the classic link (default: "continue on the sign-in page") */
  export let classicLabel: TKey | null = null;

  const dispatch = createEventDispatcher<{ retry: void; restart: void }>();
  const TEXT: Record<typeof kind, { title: TKey; text: TKey; icon: string }> = {
    classic: { title: 'login.notice.classicTitle', text: 'login.notice.classicText', icon: 'link' },
    unavailable: { title: 'login.notice.unavailableTitle', text: 'login.notice.unavailableText', icon: 'alert' },
    expired: { title: 'login.notice.expiredTitle', text: 'login.notice.expiredText', icon: 'clock' },
    denied: { title: 'login.notice.deniedTitle', text: 'login.notice.deniedText', icon: 'shield' },
    locked: { title: 'login.notice.lockedTitle', text: 'login.notice.lockedText', icon: 'lock' },
  };
  let heading: HTMLElement;
  onMount(() => heading?.focus());
</script>

<div class="af-form af-center" role={kind === 'unavailable' ? 'alert' : undefined} data-notice={kind}>
  <div class="af-big" aria-hidden="true"><Icon name={TEXT[kind].icon} size={30} /></div>
  <h1 bind:this={heading} tabindex="-1">{$t(TEXT[kind].title)}</h1>
  <p class="af-sub">{$t(text ?? TEXT[kind].text)}</p>
  {#if kind === 'classic'}
    <a class="btn af-pri" href={classicHref}>{$t(classicLabel ?? 'login.notice.classic')}</a>
  {:else if kind === 'unavailable'}
    <button class="af-pri" type="button" on:click={() => dispatch('retry')}>{$t('login.notice.retry')}</button>
    <a class="af-link" href={classicHref}>{$t(classicLabel ?? 'login.notice.classic')}</a>
  {:else}
    <button class="af-pri" type="button" on:click={() => dispatch('restart')}>{$t('login.notice.restart')}</button>
    {#if kind === 'denied'}<a class="af-link" href={classicHref}>{$t('login.notice.classic')}</a>{/if}
  {/if}
</div>
