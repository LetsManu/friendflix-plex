<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Row from '#lib/Row.svelte';
  import { avatarBg, initial } from '#lib/avatars';
  import { groupLinks, linksFor } from '#lib/menu';
  import { linkShown, serverCaps } from '#lib/capabilities';
  import { logout } from '#lib/session';
  import { goto } from '$app/navigation';
  import { locale, localeName, t, type TKey } from '#lib/i18n';

  type Note = { id: number; title: string; link?: string; read: boolean };
  let me: Me | null = null, notes: Note[] | null = null, resume: Item[] | null = null, allNotes = false;

  onMount(() => {
    api<Me>('/api/me').then((m) => (me = m)).catch(() => undefined);
    api('/api/library/resume').then((r) => (resume = r.items)).catch(() => (resume = []));
    api('/api/notifications').then(async (r) => {
      notes = r.notifications;
      // seeing them here counts as reading (same as opening the bell)
      if (notes!.some((n) => !n.read)) { await api('/api/notifications/read', { method: 'POST' }).catch(() => undefined); setTimeout(() => window.dispatchEvent(new Event('ff-notes')), 1200); }
    }).catch(() => (notes = []));
  });
  async function removeResume(id: string) {
    const prev = resume;
    resume = resume ? resume.filter((i) => i.id !== id) : resume;
    try { await api(`/api/library/resume/${id}`, { method: 'DELETE' }); } catch { resume = prev; }
  }
  async function surprise() {
    try { await goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { await goto('/browse/movies'); }
  }
  $: canDownload = Boolean(me?.downloads?.allowed);
  $: groups = groupLinks(linksFor(canDownload).filter(([href]) => linkShown($serverCaps, href)));
  $: admin = Boolean(me?.isAdmin && me?.profile?.isOwner);
  $: shown = notes ? (allNotes ? notes : notes.slice(0, 5)) : [];
  $: tiles = [['/watchlist', 'shell.menu.myList', 'plus'], ...(canDownload ? [['/downloads', 'shell.menu.downloads', 'download']] : []), ['/lists', 'shell.menu.lists', 'list'], ['/history', 'shell.menu.history', 'calendar']] as Array<[string, TKey, string]>;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.me.title') })}</title></svelte:head>
<h1 class="sr-only">{$t('account.me.title')}</h1>
<div class="me">
  <header class="prof">
    <span class="face" style={me?.profile ? `background:${avatarBg(me.profile.avatar)}` : undefined} aria-hidden="true">{me ? initial(me.profile?.name ?? me.name) : ''}</span>
    <div class="who">
      {#if me}<b>{me.profile?.name ?? me.name}</b><span class="muted">{me.roleLabel}</span>{:else}<span class="skeleton sk"></span>{/if}
      <span class="pl"><a class="swap" href="/profiles"><Icon name="users" size={16} />{$t('account.me.switchProfile')}</a><a class="swap" href="/profiles?manage=1">{$t('account.me.manageProfiles')}</a></span>
    </div>
  </header>

  <ul class="tiles2" aria-label={$t('account.me.quick')}>
    {#each tiles as [href, label, icon] (href)}<li><a {href}><span class="ti"><Icon name={icon} size={24} /></span><span class="tl">{$t(label)}</span></a></li>{/each}
  </ul>

  <section aria-labelledby="h-notes">
    <div class="sech"><h2 id="h-notes">{$t('account.me.notifications')}</h2>{#if notes && notes.length > 5}<button type="button" class="lnk" aria-expanded={allNotes} on:click={() => (allNotes = !allNotes)}>{allNotes ? $t('account.me.less') : $t('account.me.all', { n: notes.length })}</button>{/if}</div>
    {#if notes === null}<div class="skeleton nsk"></div>
    {:else if !notes.length}<p class="muted pad">{$t('account.me.noNotifications')}</p>
    {:else}
      <ul class="notes">
        {#each shown as n (n.id)}
          <li class:muted={n.read}>{#if n.link}<a href={n.link}><span class="nd" class:unread={!n.read} aria-hidden="true"></span><span class="nt">{n.title}</span><Icon name="chevron-right" size={18} /></a>{:else}<span class="plainn"><span class="nd" class:unread={!n.read} aria-hidden="true"></span><span class="nt">{n.title}</span></span>{/if}</li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if resume === null || resume.length}
    <div class="bleed"><Row title={$t('account.me.continueWatching')} items={resume} landscape removable on:remove={(e) => removeResume(e.detail.id)} /></div>
  {/if}

  <div class="groups">
    {#each groups as g (g.title)}
      {@const isAcc = g.title === 'shell.menu.groups.account'}
      {#if g.items.length || isAcc}
        <section class="grp" aria-label={$t(g.title)}>
          <h2 class="gh">{$t(g.title)}</h2>
          <ul class="lst">
            {#if g.title === 'shell.menu.groups.discover'}<li><button type="button" class="rowbtn" on:click={surprise}><Icon name="shuffle" size={20} />{$t('shell.menu.surprise')}<Icon name="chevron-right" size={18} /></button></li>{/if}
            {#each g.items as [href, label, icon] (href)}<li><a {href}><Icon name={icon} size={20} />{$t(label)}<Icon name="chevron-right" size={18} /></a></li>{/each}
            {#if isAcc}<li><a href="/settings#language"><Icon name="globe" size={20} />{$t('account.me.language', { name: localeName($locale) })}<Icon name="chevron-right" size={18} /></a></li>{/if}
            {#if isAcc}<li><button type="button" class="rowbtn" on:click={() => window.dispatchEvent(new Event('ff-help'))}><Icon name="info" size={20} />{$t('shell.menu.help')}<Icon name="chevron-right" size={18} /></button></li>{/if}
            {#if isAcc && admin}<li><a href="/admin"><Icon name="shield" size={20} />{$t('shell.menu.admin')}<Icon name="chevron-right" size={18} /></a></li>{/if}
            {#if isAcc && admin}<li><a href="/diagnose" data-testid="me-diagnose"><Icon name="info" size={20} />{$t('diagnose.title')}<Icon name="chevron-right" size={18} /></a></li>{/if}
          </ul>
        </section>
      {/if}
    {/each}
  </div>

  <button type="button" class="out" on:click={() => logout(me?.tv)}><Icon name="log-out" size={20} />{$t('account.me.logout')}</button>
</div>

<style>
  .me { max-width: 1000px; margin: 0 auto; }
  .prof { display: flex; align-items: center; gap: 1.1rem; padding: .6rem 0 1.2rem; }
  .face { width: 72px; height: 72px; flex: none; border-radius: 24%; display: grid; place-items: center; font-size: 2rem; font-weight: 800; box-shadow: 0 0 0 1px rgba(255,255,255,.12); background: linear-gradient(135deg, #ff6b81, #9a2440); }
  .who { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; gap: .1rem; }
  .who b { font-size: 1.4rem; line-height: 1.2; overflow-wrap: anywhere; }
  .sk { width: 9rem; height: 1.6rem; }
  .swap { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; color: #54b9c5; font-weight: 600; }
  .swap:hover { text-decoration: underline; }
  .tiles2 { list-style: none; margin: 0 0 1.6rem; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: .5rem; }
  @media (min-width: 721px) { .tiles2 { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); } }
  .tiles2 a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .45rem; min-height: 86px; padding: .5rem .25rem; background: var(--surface-2); border-radius: 8px; font-size: .8rem; font-weight: 600; text-align: center; white-space: nowrap; transition: background var(--t-fast); }
  .tiles2 li { min-width: 0; }
  .tiles2 .tl { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .pl { display: flex; flex-wrap: wrap; column-gap: 1.2rem; }
  .rowbtn { width: 100%; display: flex; align-items: center; justify-content: flex-start; gap: .8rem; min-height: 48px; padding: .5rem 1rem; background: transparent; border-radius: 0; font-weight: 400; color: inherit; }
  .rowbtn:hover:not(:disabled) { background: rgba(255,255,255,.05); }
  .rowbtn :global(svg:last-child) { margin-left: auto; color: var(--mut); }
  .tiles2 a:hover { background: #2e363f; }
  .ti { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,.08); }
  section { margin-bottom: 1.4rem; }
  .sech { display: flex; align-items: baseline; justify-content: space-between; }
  h2 { font-size: 1.1rem; font-weight: 700; margin: 0 0 .5rem; }
  .gh { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); margin: 0 0 .3rem .2rem; }
  .lnk { background: transparent; color: #54b9c5; padding: 0 .4rem; font-weight: 600; }
  .lnk:hover:not(:disabled) { background: transparent; text-decoration: underline; }
  .pad { padding: .4rem 0; margin: 0; }
  .notes, .lst { list-style: none; margin: 0; padding: 0; background: var(--surface); border-radius: 8px; border: 1px solid var(--line); overflow: hidden; }
  .notes li + li, .lst li + li { border-top: 1px solid var(--line); }
  .notes a, .plainn, .lst a { display: flex; align-items: center; gap: .8rem; min-height: 48px; padding: .5rem 1rem; }
  .notes a:hover, .lst a:hover { background: rgba(255,255,255,.05); }
  .nt { flex: 1; min-width: 0; font-size: .93rem; }
  .nd { flex: none; width: 8px; height: 8px; border-radius: 50%; background: transparent; }
  .nd.unread { background: var(--acc); }
  li.muted { color: var(--mut); }
  .nsk { height: 120px; border-radius: 8px; }
  .lst a :global(svg:last-child) { margin-left: auto; color: var(--mut); }
  .notes a :global(svg:last-child) { color: var(--mut); }
  .bleed { margin: 0 calc(var(--pad-x) * -1) 1.4rem; }
  .groups { display: grid; grid-template-columns: 1fr; gap: 0; }
  @media (min-width: 900px) { .groups { grid-template-columns: repeat(3, 1fr); gap: 1.2rem; align-items: start; } }
  .out { width: 100%; justify-content: flex-start; gap: .8rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; min-height: 52px; padding: 0 1rem; color: #fff; margin-top: .2rem; }
  .out:hover:not(:disabled) { background: #20262d; }
  @media (min-width: 900px) { .out { width: auto; } }
</style>
