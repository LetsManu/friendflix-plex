import { tr, type TFn } from '#lib/i18n';
/** Pure helpers for the player's control bar. */

/** Saved defaults sent with the FIRST playback/info request: quality cap and preferred audio language (detail-page pick wins). */
export function firstInfoBody(pf: { quality?: number; audioLang?: string }, wantAudio = ''): { maxBitrate?: number; audioLang?: string } {
  const out: { maxBitrate?: number; audioLang?: string } = {};
  if (typeof pf.quality === 'number' && pf.quality >= 300_000) out.maxBitrate = Math.floor(pf.quality);
  const lang = (wantAudio || pf.audioLang || '').trim();
  if (lang && lang.length <= 16) out.audioLang = lang;
  return out;
}

/** Centre text of the bar: "Serie  S1:F3 Folgentitel" / "S1:E3 Episode title" (episode code in the UI language) or the film name. Pass `$t` in components. */
export function barTitles(it: { name: string; type?: string; seriesName?: string; indexNumber?: number; parentIndexNumber?: number } | null, tf: TFn = tr): { title: string; sub: string } {
  if (!it) return { title: '', sub: '' };
  if (it.seriesName) {
    const e = it.indexNumber, s = it.parentIndexNumber;
    const code = e === undefined || e === null ? '' : s === undefined || s === null ? tf('player.episodeOnly', { e }) : tf('detail.view.episodeCode', { s, e });
    return { title: it.seriesName, sub: `${code} ${it.name}`.trim() };
  }
  return { title: it.name, sub: '' };
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
/** "1× (Normal)", "1,25×" / "1.25×" (pass `$t` in components so the label follows a language switch) */
export const speedLabel = (r: number, tf: TFn = tr) => (r === 1 ? tf('player.speed.normal') : tf('player.speed.rate', { r }));
