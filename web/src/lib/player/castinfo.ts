// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api, type Item } from '#lib/api';
/** "Besetzung & Infos" in the player: GET /api/items/:id/castinfo, shared by the quick peek and the full panel. */

export interface CreditPerson { id: string; name: string; role?: string; image: boolean }
export interface CastInfoData {
  item: { id: string; name: string; type: string; year?: number; rating?: string; communityRating?: number; seriesId?: string; seriesName?: string };
  cast: CreditPerson[];
  guests: CreditPerson[];
  directors: CreditPerson[];
  writers: CreditPerson[];
  creators: CreditPerson[];
  studios: string[];
  genres: string[];
  tags: string[];
}

const cache = new Map<string, Promise<CastInfoData>>();
/** one request per item while the page lives (the player remounts per episode; going back and forth stays cheap) */
export function loadCastInfo(id: string): Promise<CastInfoData> {
  let p = cache.get(id);
  if (!p) {
    p = api<CastInfoData>(`/api/items/${id}/castinfo`).then(normalize);
    p.catch(() => { if (cache.get(id) === p) cache.delete(id); }); // never keep a failure
    cache.set(id, p);
    while (cache.size > 30) cache.delete(cache.keys().next().value!);
  }
  return p;
}
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
function normalize(r: CastInfoData): CastInfoData {
  return {
    item: r?.item ?? { id: '', name: '', type: '' },
    cast: arr(r?.cast), guests: arr(r?.guests), directors: arr(r?.directors), writers: arr(r?.writers), creators: arr(r?.creators),
    studios: arr(r?.studios), genres: arr(r?.genres), tags: arr(r?.tags),
  };
}

/** the quick peek: the leading cast plus (for an episode) its first guest stars, at most `max` */
export function peekPeople(d: CastInfoData, max = 6): CreditPerson[] {
  const guests = d.guests.slice(0, 2);
  return [...d.cast.slice(0, Math.max(0, max - guests.length)), ...guests].slice(0, max);
}

export const hasPeople = (d: CastInfoData) => d.cast.length + d.guests.length > 0;

/** the person sheet's "more with …": other titles than the one playing (and its series), at most `max` */
export function otherTitles(items: Item[], current: CastInfoData['item'], max = 12): Item[] {
  return items.filter((i) => i.id !== current.id && i.id !== current.seriesId).slice(0, max);
}

/** background facts as label key + text (only the ones the title has) */
export type FactKey = 'scenes.info.directors' | 'scenes.info.writers' | 'scenes.info.creators' | 'scenes.info.studio' | 'scenes.info.year' | 'scenes.info.rating' | 'scenes.info.score' | 'scenes.info.genres' | 'scenes.info.tags';
export function facts(d: CastInfoData, fmtNum: (n: number) => string, list: (xs: string[]) => string): Array<{ key: FactKey; text: string; people?: CreditPerson[] }> {
  const out: Array<{ key: FactKey; text: string; people?: CreditPerson[] }> = [];
  const ppl = (key: FactKey, xs: CreditPerson[]) => { if (xs.length) out.push({ key, text: list(xs.map((p) => p.name)), people: xs }); };
  ppl('scenes.info.creators', d.creators);
  ppl('scenes.info.directors', d.directors);
  ppl('scenes.info.writers', d.writers);
  if (d.studios.length) out.push({ key: 'scenes.info.studio', text: list(d.studios) });
  if (d.item.year) out.push({ key: 'scenes.info.year', text: String(d.item.year) });
  if (d.item.rating) out.push({ key: 'scenes.info.rating', text: d.item.rating });
  if (d.item.communityRating) out.push({ key: 'scenes.info.score', text: `★ ${fmtNum(Math.round(d.item.communityRating * 10) / 10)}` });
  if (d.genres.length) out.push({ key: 'scenes.info.genres', text: list(d.genres) });
  if (d.tags.length) out.push({ key: 'scenes.info.tags', text: d.tags.slice(0, 8).join(' · ') });
  return out;
}
