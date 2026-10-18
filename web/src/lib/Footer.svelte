<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { FOOTER_COLUMNS } from '#lib/menu';
  import { features, linkShown, serverCaps } from '#lib/capabilities';
  import Logo from '#lib/Logo.svelte';
  import { LOCALES, locale, t, type Locale } from '#lib/i18n';
  import { saveLanguage } from '#lib/stores';
  import VersionEgg from '#lib/version/VersionEgg.svelte';
  import { APP_CODENAME, APP_VERSION } from '#lib/version/codenames';
  import { buildInfo, loadBuild, versionText } from '#lib/version/build';
  /** opens the help dialog of the layout */
  export let onHelp: () => void = () => undefined;
  /** kids profile: no link columns (party, lists, stats … are not for kids), language and help stay */
  export let kids = false;
  let langErr = false;
  async function pick(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement, l = sel.value as Locale;
    langErr = false;
    try { await saveLanguage(l); } catch { langErr = true; sel.value = $locale; }
  }
  // a nightly build shows "1.1.0-nightly · abc1234" (the backend knows whether its commit is the release tag)
  onMount(() => loadBuild());
</script>

<footer class="foot" class:kids aria-label={$t('shell.footer.label')}>
  <div class="inner">
    {#if !kids}
      <nav class="cols" aria-label={$t('shell.footer.more')}>
        {#each FOOTER_COLUMNS as col, i (i)}
          <ul>{#each col.filter(([href]) => linkShown($serverCaps, href, $features)) as [href, label] (href)}<li><a {href}>{$t(label)}</a></li>{/each}</ul>
        {/each}
      </nav>
    {/if}
    <div class="meta">
      <label class="lang"><span class="globe" aria-hidden="true">🌐</span><span class="sr-only">{$t('shell.footer.language')}</span>
        <select value={$locale} on:change={pick}>{#each LOCALES as l (l.code)}<option value={l.code} lang={l.code}>{l.name}</option>{/each}</select>
      </label>
      {#if langErr}<span class="err" role="alert">{$t('account.language.saveFailed')}</span>{/if}
      <button type="button" class="help" on:click={onHelp}>{$t('shell.footer.help')}</button>
      <span class="brand"><Logo size={18} label="" /> {$t('shell.footer.tagline')}</span>
      <span class="version"><VersionEgg version={APP_VERSION} codename={APP_CODENAME} label="{$t('common.appName')} {versionText(APP_VERSION, APP_CODENAME, $buildInfo)}" /></span>
    </div>
  </div>
</footer>

<style>
  .foot { padding: 3rem var(--pad-x) 2.5rem; color: #808080; font-size: .82rem; }
  .inner { max-width: 980px; margin: 0 auto; }
  .cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 1.2rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin: 0; }
  a { display: inline-flex; align-items: center; min-height: 44px; color: #808080; }
  a:hover { text-decoration: underline; color: #b3bac2; }
  .meta { display: flex; align-items: center; gap: 1.2rem; margin-top: 1.2rem; flex-wrap: wrap; }
  .lang { position: relative; display: inline-flex; align-items: center; }
  .globe { position: absolute; left: .7rem; font-size: .9rem; pointer-events: none; filter: grayscale(1); }
  .lang select { min-height: 44px; padding: .3rem .9rem .3rem 2.1rem; background: transparent; border: 1px solid #808080; border-radius: 2px; color: #b3bac2; font-size: .82rem; }
  .lang select:hover, .lang select:focus-visible { color: #fff; border-color: #fff; }
  .lang option { background: #101418; color: #fff; }
  .help { background: transparent; border: 1px solid #808080; color: #808080; font-weight: 400; font-size: .82rem; min-height: 44px; padding: .3rem .9rem; border-radius: 2px; }
  .help:hover:not(:disabled) { background: transparent; color: #fff; border-color: #fff; }
  .brand { display: inline-flex; align-items: center; gap: .45rem; opacity: .85; }
  .version { margin-left: auto; font-size: .76rem; opacity: .8; }
  .foot.kids { background: #fffaf0; color: #5b6280; }
  .foot.kids .meta { margin-top: 0; }
  .foot.kids .lang select, .foot.kids .help { color: #20233a; border-color: #9aa0b8; border-radius: 99px; }
  .foot.kids .lang option { background: #fff; color: #20233a; }
  @media (max-width: 720px) { .foot { display: none; } }
</style>
