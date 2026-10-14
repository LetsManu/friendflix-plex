<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin frame: grouped sidebar (≥900px), page header with breadcrumb + <h1> + per-page <title>, pending badges from
   * /api/admin/summary. Phone: /admin is a grouped list (like /me), sub-pages get a back chevron to /admin.
   * Pages render only their content; they must not add their own <h1> or <title>.
   */
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { GROUPS, OVERVIEW, activeItem, badgeCount, badgeTone, groupOf } from './nav';
  import { refreshSummary, summary } from './summary';

  const page = pageStore();
  $: item = activeItem($page.url.pathname);
  $: group = groupOf(item);
  $: overview = item === OVERVIEW;
  $: title = item && !overview ? $t(item.label) : $t('admin.title');

  onMount(() => {
    void refreshSummary();
    const iv = setInterval(() => { if (document.visibilityState === 'visible') void refreshSummary(); }, 60_000);
    return () => clearInterval(iv);
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: overview ? $t('admin.title') : `${title} · ${$t('admin.title')}` })}</title></svelte:head>

<div class="adm" class:overview>
  <aside class="side">
    <nav aria-label={$t('admin.nav.label')}>
      <a class="ni" href={OVERVIEW.href} aria-current={overview ? 'page' : undefined}><Icon name={OVERVIEW.icon} size={20} /><span class="nl">{$t(OVERVIEW.label)}</span></a>
      {#each GROUPS as g (g.id)}
        <h2 class="gh" id="adm-g-{g.id}">{$t(g.label)}</h2>
        <ul aria-labelledby="adm-g-{g.id}">
          {#each g.items as it (it.href)}
            {@const n = badgeCount($summary, it.badge)}
            <li>
              <a class="ni" href={it.href} aria-current={item === it ? 'page' : undefined}>
                <Icon name={it.icon} size={20} /><span class="nl">{$t(it.label)}</span>
                {#if n && it.badge}<span class="cnt {badgeTone(it.badge)}" aria-hidden="true">{n}</span><span class="sr-only">({badgeTone(it.badge) === 'err' ? $t('admin.nav.failing', { n }) : $t('admin.nav.pending', { n })})</span>{/if}
              </a>
            </li>
          {/each}
        </ul>
      {/each}
    </nav>
  </aside>

  <div class="body">
    <header class="ah">
      {#if !overview}<a class="back" href="/admin" aria-label={$t('admin.nav.back')}><Icon name="chevron-left" size={24} /></a>{/if}
      <div class="ht">
        {#if !overview && group}<p class="crumb"><a href="/admin">{$t('admin.title')}</a><Icon name="chevron-right" size={14} /><span>{$t(group.label)}</span></p>{/if}
        <h1>{title}</h1>
      </div>
    </header>

    {#if overview}
      <!-- phone: the admin index is a grouped list (same look as /me); hidden next to the sidebar -->
      <nav class="plist" aria-label={$t('admin.nav.label')}>
        {#each GROUPS as g (g.id)}
          <section aria-labelledby="adm-p-{g.id}">
            <h2 class="pgh" id="adm-p-{g.id}">{$t(g.label)}</h2>
            <ul class="lst">
              {#each g.items as it (it.href)}
                {@const n = badgeCount($summary, it.badge)}
                <li><a href={it.href}><Icon name={it.icon} size={20} /><span class="nl">{$t(it.label)}</span>
                  {#if n && it.badge}<span class="cnt {badgeTone(it.badge)}" aria-hidden="true">{n}</span><span class="sr-only">({badgeTone(it.badge) === 'err' ? $t('admin.nav.failing', { n }) : $t('admin.nav.pending', { n })})</span>{/if}
                  <Icon name="chevron-right" size={18} /></a></li>
              {/each}
            </ul>
          </section>
        {/each}
      </nav>
    {/if}

    <div class="content"><slot /></div>
  </div>
</div>

<style>
  .adm { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; max-width: 1400px; margin: 0 auto; }
  .side { display: none; }
  .body { min-width: 0; }
  .content { min-width: 0; }

  /* page header */
  .ah { display: flex; align-items: center; gap: .6rem; margin: 0 0 1.2rem; min-height: 44px; }
  .ht { min-width: 0; }
  h1 { margin: 0; font-size: clamp(1.45rem, 2.4vw, 1.9rem); font-weight: 800; letter-spacing: -.02em; overflow-wrap: anywhere; }
  .crumb { display: none; margin: 0 0 .15rem; color: var(--mut); font-size: .85rem; align-items: center; gap: .3rem; }
  .crumb a:hover { color: var(--fg); text-decoration: underline; }
  .back { display: grid; place-items: center; width: 44px; height: 44px; flex: none; margin-left: -.5rem; border-radius: 50%; color: var(--fg); }
  .back:hover { background: rgba(255,255,255,.08); }

  /* sidebar */
  .gh { margin: 1.2rem 0 .3rem .75rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); }
  .side ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .ni { position: relative; display: flex; align-items: center; gap: .75rem; min-height: 44px; padding: .45rem .75rem; border-radius: 6px; color: var(--mut); font-weight: 500; font-size: .95rem; transition: background var(--t-fast), color var(--t-fast); }
  .ni:hover { background: rgba(255,255,255,.06); color: var(--fg); }
  .ni[aria-current='page'] { background: rgba(255,255,255,.1); color: #fff; font-weight: 700; }
  .ni[aria-current='page']::before { content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 2px; background: var(--acc); }
  .nl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cnt { flex: none; min-width: 1.5rem; height: 1.5rem; padding: 0 .4rem; border-radius: 99px; display: inline-grid; place-items: center; font-size: .75rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .cnt.warn { background: var(--warn); color: #1a1200; }
  .cnt.err { background: var(--err); color: #200; }

  /* phone list (like /me) */
  .plist { margin-bottom: 1.6rem; }
  .plist section { margin-bottom: 1.2rem; }
  .pgh { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); margin: 0 0 .3rem .2rem; font-weight: 700; }
  .lst { list-style: none; margin: 0; padding: 0; background: var(--surface); border-radius: 8px; border: 1px solid var(--line); overflow: hidden; }
  .lst li + li { border-top: 1px solid var(--line); }
  .lst a { display: flex; align-items: center; gap: .8rem; min-height: 48px; padding: .5rem 1rem; }
  .lst a:hover { background: rgba(255,255,255,.05); }
  .lst a > :global(svg:last-child) { color: var(--mut); }

  @media (min-width: 900px) {
    .adm { grid-template-columns: 232px minmax(0, 1fr); gap: 2.4rem; }
    .side { display: block; position: sticky; top: calc(var(--nav-total) + 1rem); align-self: start; max-height: calc(100vh - var(--nav-total) - 2rem); overflow-y: auto; overscroll-behavior: contain; padding: .2rem .2rem 1rem; margin-left: -.2rem; }
    .plist, .back { display: none; }
    .crumb { display: flex; }
  }
  :global(html.tv) .ni { min-height: 52px; font-size: 1.05rem; }
</style>
