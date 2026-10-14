// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locale } from '#lib/i18n';

/**
 * "Anime: Originalton mit Untertiteln" (per-profile pref `animeOriginal`). Applies only to anime series that have no own
 * audio/subtitle choice yet (the series pref always wins), and only when the episode really has a Japanese track: a dub-only
 * release keeps the normal defaults.
 */

/** ISO 639-2 codes Jellyfin reports for the UI languages (bibliographic and terminology forms) */
const TRACK_CODES: Record<Locale, readonly string[]> = { de: ['ger', 'deu'], en: ['eng'], fr: ['fre', 'fra'], es: ['spa'], it: ['ita'], tr: ['tur'], pl: ['pol'] };
const JAPANESE = ['jpn', 'ja'];

export interface SeriesPref { audio: string | null; subtitle: string | null }

/** true when the anime default should be used for this start */
export const animeDefaultApplies = (enabled: boolean, anime: boolean | undefined, pref: SeriesPref): boolean =>
  enabled && anime === true && !pref.audio && !pref.subtitle;

/** audio language to ask the server for ('' = no anime default) */
export const animeAudio = (applies: boolean): string => (applies ? 'jpn' : '');

const isJapanese = (lang: string | undefined) => Boolean(lang && JAPANESE.includes(lang.toLowerCase()));

/**
 * Subtitle language for the started episode: the UI language when the playing audio track is Japanese and such a subtitle
 * exists, else null (the global subtitle default applies).
 */
export function animeSubtitle(ui: Locale, playingAudio: string | undefined, subtitles: ReadonlyArray<{ language?: string }>): string | null {
  if (!isJapanese(playingAudio)) return null;
  const want = TRACK_CODES[ui] ?? [];
  return subtitles.find((s) => s.language && want.includes(s.language.toLowerCase()))?.language ?? null;
}
