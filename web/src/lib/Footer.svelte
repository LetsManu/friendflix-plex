<script lang="ts">
  import { FOOTER_COLUMNS } from '#lib/menu';
  import Logo from '#lib/Logo.svelte';
  import { LOCALES, locale, t, type Locale } from '#lib/i18n';
  import { saveLanguage } from '#lib/stores';
  /** opens the help dialog of the layout */
  export let onHelp: () => void = () => undefined;
  let langErr = false;
  async function pick(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement, l = sel.value as Locale;
    langErr = false;
    try { await saveLanguage(l); } catch { langErr = true; sel.value = $locale; }
  }
</script>

<footer class="foot" aria-label={$t('shell.footer.label')}>
  <div class="inner">
    <nav class="cols" aria-label={$t('shell.footer.more')}>
      {#each FOOTER_COLUMNS as col, i (i)}
        <ul>{#each col as [href, label] (href)}<li><a {href}>{$t(label)}</a></li>{/each}</ul>
      {/each}
    </nav>
    <div class="meta">
      <label class="lang"><span class="globe" aria-hidden="true">🌐</span><span class="sr-only">{$t('shell.footer.language')}</span>
        <select value={$locale} on:change={pick}>{#each LOCALES as l (l.code)}<option value={l.code} lang={l.code}>{l.name}</option>{/each}</select>
      </label>
      {#if langErr}<span class="err" role="alert">{$t('account.language.saveFailed')}</span>{/if}
      <button type="button" class="help" on:click={onHelp}>{$t('shell.footer.help')}</button>
      <span class="brand"><Logo size={18} label="" /> {$t('shell.footer.tagline')}</span>
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
  a:hover { text-decoration: underline; color: #b3b3b3; }
  .meta { display: flex; align-items: center; gap: 1.2rem; margin-top: 1.2rem; flex-wrap: wrap; }
  .lang { position: relative; display: inline-flex; align-items: center; }
  .globe { position: absolute; left: .7rem; font-size: .9rem; pointer-events: none; filter: grayscale(1); }
  .lang select { min-height: 44px; padding: .3rem .9rem .3rem 2.1rem; background: transparent; border: 1px solid #808080; border-radius: 2px; color: #b3b3b3; font-size: .82rem; }
  .lang select:hover, .lang select:focus-visible { color: #fff; border-color: #fff; }
  .lang option { background: #141414; color: #fff; }
  .help { background: transparent; border: 1px solid #808080; color: #808080; font-weight: 400; font-size: .82rem; min-height: 44px; padding: .3rem .9rem; border-radius: 2px; }
  .help:hover:not(:disabled) { background: transparent; color: #fff; border-color: #fff; }
  .brand { display: inline-flex; align-items: center; gap: .45rem; opacity: .85; }
  @media (max-width: 720px) { .foot { display: none; } }
</style>
