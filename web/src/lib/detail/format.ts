import type { Item } from '#lib/api';
import { fmtDuration, tr, type TKey } from '#lib/i18n';

const MOOD_KEYS = {
  thrilling: 'detail.format.mood.thrilling', funny: 'detail.format.mood.funny', emotional: 'detail.format.mood.emotional', scary: 'detail.format.mood.scary',
  romantic: 'detail.format.mood.romantic', exciting: 'detail.format.mood.exciting', imaginative: 'detail.format.mood.imaginative',
  heartwarming: 'detail.format.mood.heartwarming', informative: 'detail.format.mood.informative', moving: 'detail.format.mood.moving',
} as const satisfies Record<string, TKey>;

type Mood = keyof typeof MOOD_KEYS;
/** genre (lower-case, German or English) -> mood tag for "Dieser Titel ist:" */
const MOOD: Record<string, Mood> = {
  thriller: 'thrilling', krimi: 'thrilling', crime: 'thrilling', mystery: 'thrilling', action: 'thrilling',
  komödie: 'funny', komoedie: 'funny', comedy: 'funny',
  drama: 'emotional',
  horror: 'scary',
  romanze: 'romantic', romance: 'romantic', liebesfilm: 'romantic',
  abenteuer: 'exciting', adventure: 'exciting',
  'sci-fi': 'imaginative', 'science fiction': 'imaginative', 'sci-fi & fantasy': 'imaginative', fantasy: 'imaginative',
  animation: 'heartwarming', familie: 'heartwarming', family: 'heartwarming', kinder: 'heartwarming',
  dokumentarfilm: 'informative', dokumentation: 'informative', documentary: 'informative',
  krieg: 'moving', war: 'moving', historie: 'moving', history: 'moving',
};

/** Up to three distinct mood tags derived from the genres, in genre order. */
export function moodTags(genres: readonly string[] | undefined, max = 3): string[] {
  const out: string[] = [];
  for (const g of genres ?? []) {
    const k = MOOD[g.trim().toLowerCase()];
    const m = k ? tr(MOOD_KEYS[k]) : '';
    if (m && !out.includes(m)) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

/** "Noch 23 Min." for something that was started but not finished; '' otherwise. */
export function remainingLabel(positionTicks?: number, runtimeTicks?: number): string {
  if (!positionTicks || !runtimeTicks || positionTicks >= runtimeTicks) return '';
  const min = Math.ceil((runtimeTicks - positionTicks) / 600_000_000);
  if (min < 1) return '';
  return tr('detail.format.remaining', { d: fmtDuration(min * 60) });
}

export interface Person { id: string; name: string; role?: string; type: string; image: boolean }
/** names of one credit type (Director / Writer / Actor ...), de-duplicated, order kept */
export function byType(people: readonly Person[], ...types: string[]): Person[] {
  const seen = new Set<string>();
  return people.filter((p) => types.includes(p.type) && !seen.has(p.id) && seen.add(p.id));
}

/** Age rating text for the info block ("FSK 12" -> "Ab 12 Jahren"), '' when it cannot be derived. */
export function ageText(rating?: string): string {
  if (!rating) return '';
  const m = /(?:FSK|PG|ab)?\s*[-:]?\s*(\d{1,2})\b/i.exec(rating);
  if (/^(fsk\s*)?0$/i.test(rating.trim()) || /^(g|all|u|ab 0)$/i.test(rating.trim())) return tr('detail.format.ageAll');
  return m ? tr('detail.format.ageFrom', { n: Number(m[1]) }) : '';
}

/** label of a season option (Jellyfin name, else "Staffel n") */
export const seasonLabel = (s: Pick<Item, 'name' | 'indexNumber'>): string => s.name || (s.indexNumber !== undefined ? tr('detail.format.seasonN', { n: s.indexNumber }) : tr('detail.format.season'));
