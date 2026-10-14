// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { getLocale, intlLocale, tr } from '#lib/i18n';

/** ISO 639-2/T language codes (as indexed by the backend) -> German labels. */
const LABEL: Record<string, string> = {
  deu: 'Deutsch', eng: 'Englisch', fra: 'Französisch', spa: 'Spanisch', ita: 'Italienisch', por: 'Portugiesisch', nld: 'Niederländisch',
  rus: 'Russisch', pol: 'Polnisch', tur: 'Türkisch', jpn: 'Japanisch', kor: 'Koreanisch', zho: 'Chinesisch', ara: 'Arabisch',
  hin: 'Hindi', swe: 'Schwedisch', nor: 'Norwegisch', dan: 'Dänisch', fin: 'Finnisch', ces: 'Tschechisch', slk: 'Slowakisch',
  hun: 'Ungarisch', ron: 'Rumänisch', ell: 'Griechisch', heb: 'Hebräisch', tha: 'Thailändisch', ukr: 'Ukrainisch', bul: 'Bulgarisch',
  hrv: 'Kroatisch', srp: 'Serbisch', fas: 'Persisch', vie: 'Vietnamesisch', ind: 'Indonesisch', isl: 'Isländisch', lat: 'Latein',
};

/** ISO 639-2 (T and B variants) -> ISO 639-1, for Intl.DisplayNames in other UI languages */
const ISO1: Record<string, string> = {
  deu: 'de', ger: 'de', eng: 'en', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', dut: 'nl', rus: 'ru', pol: 'pl', tur: 'tr',
  jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', ara: 'ar', hin: 'hi', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', ces: 'cs', cze: 'cs', slk: 'sk',
  slo: 'sk', hun: 'hu', ron: 'ro', rum: 'ro', ell: 'el', gre: 'el', heb: 'he', tha: 'th', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', fas: 'fa',
  per: 'fa', vie: 'vi', ind: 'id', isl: 'is', ice: 'is', lat: 'la',
};

/** ISO 639-2/B codes (Jellyfin also reports these) -> 639-2/T */
const B2T: Record<string, string> = { ger: 'deu', fre: 'fra', dut: 'nld', chi: 'zho', cze: 'ces', slo: 'slk', rum: 'ron', gre: 'ell', per: 'fas', ice: 'isl' };

/** Display name for a language code in the current UI language (German list for German); unknown codes fall back to the upper-case code. */
export function langLabel(code: string): string {
  const raw = code.trim().toLowerCase(), c = B2T[raw] ?? raw;
  if (getLocale() !== 'de') {
    try { const n = ISO1[c] && new Intl.DisplayNames(intlLocale(), { type: 'language' }).of(ISO1[c]); if (n) return n.charAt(0).toLocaleUpperCase(intlLocale()) + n.slice(1); } catch { /* old browser */ }
  }
  return LABEL[c] ?? c.toUpperCase();
}

/** true when the code is a language we have a name for (else langLabel() returns the upper-case code) */
export function isKnownLang(code: string): boolean {
  const raw = code.trim().toLowerCase();
  return (B2T[raw] ?? raw) in LABEL;
}

/** "Ton: Deutsch, Englisch · Untertitel: Deutsch" (empty string when nothing is known). */
export function langLine(langs: { audio?: string[]; subs?: string[] } | undefined | null): string {
  const parts: string[] = [];
  if (langs?.audio?.length) parts.push(tr('detail.langs.audio', { list: langs.audio.map(langLabel).join(', ') }));
  if (langs?.subs?.length) parts.push(tr('detail.langs.subs', { list: langs.subs.map(langLabel).join(', ') }));
  return parts.join(' · ');
}
