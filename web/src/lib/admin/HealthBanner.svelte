<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Slim warning bar for admins under the app bar (Block 22): the worst issue as one sentence, "+n weitere" opens the rest,
   * "Ansehen" goes to /admin/status (open approvals: to the approval queue), every issue can be hidden until it changes.
   * Mounted by the root layout only for an admin on the owner profile, never in TV mode, on player / party / profile / public
   * pages or kids profiles.
   */
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { banner, bannerView, dismiss, issueHref, issueText } from './banner';
  import type { HealthIssue } from './health';

  /** hero pages (/, /item/…) have no top padding under the transparent app bar */
  export let hero = false;
  let open = false;
  /** red issues already announced with role=alert in this page view (by fingerprint) */
  const announced = new Set<string>();

  $: view = bannerView($banner?.issues ?? []);
  $: if (!view.more) open = false;
  $: role = view.first && view.first.level === 'err' && !announced.has(view.first.fp) ? 'alert' : 'status';
  $: if (role === 'alert' && view.first) announced.add(view.first.fp);
  // the sentences follow a language switch ($t is read here)
  const text = (i: HealthIssue, _l: unknown): string => issueText(i);
</script>

{#if view.first}
  {@const first = view.first}
  <div class="hb {view.level}" class:hero {role} aria-label={$t('admin.banner.label')}>
    <div class="row">
      <span class="ic" aria-hidden="true"><Icon name={view.level === 'err' ? 'alert' : 'clock'} size={20} /></span>
      <p class="msg">{text(first, $t)}</p>
      <span class="acts">
        {#if view.more}
          <button type="button" class="lnk" aria-expanded={open} on:click={() => (open = !open)}>{open ? $t('admin.banner.less') : $t('admin.banner.more', { n: view.more })}</button>
        {/if}
        <a class="lnk" href={issueHref(first)}>{$t('admin.banner.view')}</a>
        <button type="button" class="x" aria-label={$t('admin.banner.dismiss')} on:click={() => dismiss(first)}><Icon name="x" size={20} /></button>
      </span>
    </div>
    {#if open && view.rest.length}
      <ul class="rest">
        {#each view.rest as i (i.id + i.fp)}
          <li class={i.level}>
            <span class="ic sm" aria-hidden="true"><Icon name={i.level === 'err' ? 'alert' : 'clock'} size={16} /></span>
            <span class="msg">{text(i, $t)}</span>
            <button type="button" class="x" aria-label={$t('admin.banner.dismissOne', { text: text(i, $t) })} on:click={() => dismiss(i)}><Icon name="x" size={18} /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .hb { margin: 0 0 1rem; border-radius: 8px; border: 1px solid; padding: .15rem .3rem .15rem .8rem; color: var(--fg); min-width: 0; }
  .hb.hero { margin: var(--nav-total) var(--pad-x) 0; }
  .warn { background: var(--tone-warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
  .err { background: var(--tone-err); border-color: color-mix(in srgb, var(--err) 45%, transparent); }
  .row { display: flex; align-items: center; gap: .3rem .6rem; flex-wrap: wrap; min-height: 44px; }
  .ic { display: grid; place-items: center; flex: none; }
  .warn .ic, li.warn .ic { color: var(--warn); } .err .ic, li.err .ic { color: var(--err); }
  .msg { flex: 1 1 14rem; min-width: 0; margin: 0; font-weight: 600; font-size: .92rem; overflow-wrap: anywhere; }
  .acts { display: flex; align-items: center; gap: .2rem; margin-left: auto; flex-wrap: wrap; }
  .lnk { background: transparent; color: var(--fg); font: inherit; font-size: .88rem; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; min-height: 44px; padding: 0 .55rem; display: inline-flex; align-items: center; border-radius: 6px; }
  .lnk:hover { background: rgba(255,255,255,.08); }
  .x { background: transparent; color: var(--fg); width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; flex: none; }
  .x:hover { background: rgba(255,255,255,.1); }
  .rest { list-style: none; margin: 0 0 .3rem; padding: .2rem 0 0; border-top: 1px solid rgba(255,255,255,.12); }
  .rest li { display: flex; align-items: center; gap: .6rem; min-height: 44px; }
  .rest .msg { font-weight: 500; }
</style>
