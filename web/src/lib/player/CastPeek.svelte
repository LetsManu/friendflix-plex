<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { img } from '#lib/api';
  import { t } from '#lib/i18n';
  import { peekPeople, type CastInfoData } from './castinfo';

  /**
   * Quick peek: a small slide-in with the leading cast while the film keeps playing (no pause, takes no focus, hides by itself).
   * Opened with I / TV up / the remote's Info key / the cast button; a click (or OK / I) opens the full "Besetzung & Infos" panel.
   */
  export let data: CastInfoData | null;
  /** which way to the full panel the hint names: the I key, the remote's OK, nothing (touch) */
  export let hint: 'key' | 'tv' | 'none' = 'key';
  const dispatch = createEventDispatcher<{ more: void }>();
  $: people = data ? peekPeople(data) : [];
</script>

<aside class="peek" aria-label={$t('scenes.peek.label')}>
  {#if !data}
    <p class="muted">{$t('scenes.info.loading')}</p>
  {:else if !people.length}
    <p class="muted">{$t('scenes.info.none')}</p>
  {:else}
    <ul>{#each people as p (p.id)}
      <li>{#if p.image}<img src={img(p.id, 96)} alt="" />{:else}<span class="ph" aria-hidden="true"></span>{/if}<span><b>{p.name}</b>{#if p.role}<small>{p.role}</small>{/if}</span></li>
    {/each}</ul>
    <button type="button" class="more ui" tabindex="-1" on:click|stopPropagation={() => dispatch('more')}>{$t('scenes.peek.more')}{#if hint !== 'none'}{' · '}<span class="k">{hint === 'tv' ? $t('scenes.peek.hintTv') : $t('scenes.peek.hintKey', { key: 'I' })}</span>{/if}</button>
  {/if}
</aside>

<style>
  .peek { position: absolute; z-index: 7; right: calc(max(clamp(.6rem, 2.4vw, 2.4rem), var(--safe-right)) + var(--inset, 0px)); top: calc(4.8rem + var(--safe-top)); width: min(280px, calc(100% - 1.2rem)); padding: .6rem .7rem .5rem;
    background: rgba(10,10,10,.78); border: 1px solid rgba(255,255,255,.12); border-radius: 10px; backdrop-filter: blur(6px); pointer-events: none; animation: pkIn .22s ease-out; }
  @keyframes pkIn { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .peek { animation: none; } }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
  li { display: flex; align-items: center; gap: .6rem; min-width: 0; font-size: .86rem; line-height: 1.2; }
  li img, .ph { flex: none; width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: #2b333c; }
  li span { display: grid; min-width: 0; } li b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li small { color: #bdbdbd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .more { pointer-events: auto; margin-top: .45rem; width: 100%; min-height: 36px; padding: .2rem .4rem; background: rgba(255,255,255,.1); color: #fff; font-size: .8rem; font-weight: 600; border-radius: 6px; }
  .more:hover:not(:disabled) { background: rgba(255,255,255,.2); }
  .k { color: #cfcfcf; font-weight: 400; }
  p { margin: 0; font-size: .86rem; }
  :global(html.tv) .peek { width: 340px; } :global(html.tv) li { font-size: 1rem; } :global(html.tv) li img { width: 44px; height: 44px; }
  @media (max-width: 720px) { .peek { top: calc(4.2rem + var(--safe-top)); right: max(.5rem, var(--safe-right)); width: min(250px, calc(100% - 1rem)); } }
</style>
