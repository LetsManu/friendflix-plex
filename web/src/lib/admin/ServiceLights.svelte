<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Traffic light per dependency (Block 22): worst first, icon + text pill, a link to where it is handled. null = skeleton. */
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, t, type TKey } from '#lib/i18n';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { levelIcon, levelTone, serviceText, sortServices, type ServiceHealth, type ServiceId } from './health';

  export let services: ServiceHealth[] | null;
  const META: Record<ServiceId, { icon: string; href?: string }> = {
    media: { icon: 'film', href: '/admin/playback' }, postgres: { icon: 'hard-drive' }, redis: { icon: 'grid' }, gateway: { icon: 'link' },
    oidc: { icon: 'key' }, requests: { icon: 'inbox', href: '/admin/requests' }, tmdb: { icon: 'info', href: '/admin/sources' },
    omdb: { icon: 'star', href: '/admin/sources' }, playbackCheck: { icon: 'play', href: '/admin/playback' },
  };
  $: list = services ? sortServices(services) : null;
  const textsOf = (l: ServiceHealth[] | null, _tr: unknown) => new Map((l ?? []).map((s) => [s.id, serviceText(s)]));
  // $t as an argument: the texts follow a language switch (serviceText reads the same store)
  $: texts = textsOf(list, $t);
</script>

<ul class="lights">
  {#each list ?? [null, null, null, null, null, null] as s, i (s?.id ?? i)}
    <li>
      {#if s}
        {@const m = META[s.id] ?? { icon: 'activity' }}
        <svelte:element this={m.href ? 'a' : 'div'} href={m.href} class="svc">
          <span class="hi" aria-hidden="true"><Icon name={m.icon} size={18} /></span>
          <span class="hl">{$t(`adminContent.health.svc.${s.id}` as TKey)}</span>
          <StatusPill tone={levelTone(s.level)} icon={levelIcon(s.level)} label={texts.get(s.id) ?? ''} />
          {#if s.ms !== undefined && s.level !== 'off'}<span class="ms">{$t('adminContent.health.ms', { n: fmtNumber(s.ms) })}</span>{/if}
        </svelte:element>
      {:else}<span class="svc sk" aria-hidden="true"><Skeleton w="60%" h=".9rem" /><Skeleton w="5rem" h="1.3rem" radius="99px" /></span>{/if}
    </li>
  {/each}
</ul>

<style>
  .lights { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: .6rem; }
  .svc { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; min-height: 64px; padding: .7rem .9rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; transition: background var(--t-fast); color: inherit; }
  .sk { flex-direction: column; align-items: flex-start; justify-content: center; }
  a.svc:hover { background: #1b2127; }
  .hi { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.08); flex: none; }
  .hl { flex: 1; min-width: 6rem; font-weight: 600; font-size: .92rem; }
  .ms { width: 100%; padding-left: calc(32px + .6rem); color: var(--mut); font-size: .78rem; font-variant-numeric: tabular-nums; }
</style>
