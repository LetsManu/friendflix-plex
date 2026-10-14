// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { tr, type TKey } from '#lib/i18n';

/** Three-step rating: -1 "Naja", 1 "Gut", 2 "Geliebt", 0 = no rating. */
export type Thumb = -1 | 0 | 1 | 2;

interface RatingOption { value: Exclude<Thumb, 0>; key: TKey; icon: 'down' | 'up' | 'double'; /** translated label (current language) */ readonly label: string }
const opt = (value: Exclude<Thumb, 0>, key: TKey, icon: RatingOption['icon']): RatingOption => ({ value, key, icon, get label() { return tr(key); } });
export const RATING_OPTIONS: ReadonlyArray<RatingOption> = [
  opt(-1, 'common.rating.notForMe', 'down'),
  opt(1, 'common.rating.like', 'up'),
  opt(2, 'common.rating.love', 'double'),
];

/** normalises whatever the API returned (null, '1', 3 …) to a known value */
export function toThumb(v: unknown): Thumb {
  const n = typeof v === 'string' ? Number(v) : v;
  return n === -1 || n === 1 || n === 2 ? n : 0;
}

/** clicking the active option resets the rating, any other option selects it */
export const nextThumb = (current: Thumb, picked: Exclude<Thumb, 0>): Thumb => (current === picked ? 0 : picked);

/** accessible name of the collapsed button */
export function thumbLabel(v: Thumb): string {
  const o = RATING_OPTIONS.find((x) => x.value === v);
  return o ? tr('common.rating.rated', { label: o.label }) : tr('common.rating.rate');
}

/** index of the option keyboard focus starts on when the picker opens (the active one, else "Gut") */
export const focusIndex = (v: Thumb): number => Math.max(0, RATING_OPTIONS.findIndex((x) => x.value === (v === 0 ? 1 : v)));
