<script lang="ts">
  import { api } from '#lib/api';
  import { t } from '#lib/i18n';
  import { isKnownLang, langLabel } from '#lib/langs';
  /** movie or episode that would be played (for a series: the next episode) */
  export let targetId: string;
  /** remembers the choice per title/series on this device */
  export let storeKey: string;
  /** chosen audio language ('' = default) and subtitles ('' = my default, 'off' = none) */
  export let audio = '';
  export let sub = '';
  type Tr = { audio: Array<{ language: string; title: string }>; subtitles: Array<{ language: string; title: string }> };
  let tr: Tr | null = null, loadedFor = '';
  /** language name in the UI language; unknown codes keep the track title from Jellyfin */
  const name = (l: { language: string; title: string }, unknown: string) => (l.language === 'und' ? unknown : isKnownLang(l.language) ? langLabel(l.language) : l.title);

  async function load(id: string) {
    if (!id || id === loadedFor) return;
    loadedFor = id;
    try { tr = await api<Tr>(`/api/items/${id}/tracks`); } catch { tr = null; }
    try { const s = JSON.parse(localStorage.getItem(`ff_lang:${storeKey}`) ?? '{}'); audio = tr?.audio.some((a) => a.language === s.audio) ? s.audio : ''; sub = s.sub === 'off' || tr?.subtitles.some((a) => a.language === s.sub) ? s.sub : ''; } catch { /* none saved */ }
  }
  $: load(targetId);
  const save = () => { try { localStorage.setItem(`ff_lang:${storeKey}`, JSON.stringify({ audio, sub })); } catch { /* private mode */ } };
</script>

{#if tr && (tr.audio.length > 1 || tr.subtitles.length)}
  <div class="lang flex">
    {#if tr.audio.length > 1}
      <label for="lg-a">{$t('detail.langPick.audio')}</label>
      <select id="lg-a" bind:value={audio} on:change={save}><option value="">{$t('detail.langPick.standard')}</option>{#each tr.audio as a}<option value={a.language}>{name(a, $t('detail.langPick.unknown'))}</option>{/each}</select>
    {/if}
    {#if tr.subtitles.length}
      <label for="lg-s">{$t('detail.langPick.subs')}</label>
      <select id="lg-s" bind:value={sub} on:change={save}><option value="">{$t('detail.langPick.standard')}</option><option value="off">{$t('detail.langPick.off')}</option>{#each tr.subtitles as a}<option value={a.language}>{name(a, $t('detail.langPick.unknown'))}</option>{/each}</select>
    {/if}
  </div>
{/if}

<style>.lang { margin: 0 0 1rem; gap: .5rem .8rem; } .lang label { color: var(--fg); }</style>
