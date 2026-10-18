// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecoCoefficients } from './weights.js';

/**
 * Recommendation engine v2, R3b: optional exploration (spec 4.5, 2.3 item 8). About one slot in ten (RECO_EXPLORE, default 0 = off) of a
 * row is filled with a medium-score candidate instead of the ranked one, so that offline replay can later estimate how other rankings
 * would have done (inverse propensity weighting, scripts/reco-eval.mjs --ipw).
 *
 *  - eligible slots: every slot after the best `explore.protectTop` (default 3);
 *  - a slot is explored with probability `rate`; the title is drawn uniformly from the medium band of the pool: the candidates ranked
 *    from `explore.from` to `explore.to` (default 25 % to 60 %) of the score-ordered pool, not already in the row, with a positive score;
 *  - logged propensity of the title that ended up in an eligible slot: exploit = 1 - rate, explore = rate / (size of the medium band).
 * Only counters by row kind and arm are logged (metrics.ts), never a title or a user.
 */

export interface Explorable { id: string; score: number }
export type Arm = 'exploit' | 'explore';
export interface ExploreSlot { index: number; id: string; arm: Arm; propensity: number }

export interface ExploreResult<T> { items: T[]; slots: ExploreSlot[] }

/**
 * `chosen` is the final row (best first), `pool` every scored candidate. `allowed(candidate, rest)` lets the caller keep its own caps
 * (per franchise) when a title is swapped in: `rest` is the row without the slot being replaced. `rng` returns [0, 1).
 */
export function explore<T extends Explorable>(
  chosen: readonly T[], pool: readonly T[], rate: number, c: Pick<RecoCoefficients, 'explore'>, rng: () => number,
  allowed: (candidate: T, rest: readonly T[]) => boolean = () => true,
): ExploreResult<T> {
  const items = [...chosen];
  const slots: ExploreSlot[] = [];
  if (!(rate > 0) || !items.length) return { items, slots };
  const ordered = [...pool].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const from = Math.floor(ordered.length * c.explore.from), to = Math.ceil(ordered.length * c.explore.to);
  const band = ordered.slice(from, to).filter((x) => x.score > 0);
  for (let i = c.explore.protectTop; i < items.length; i++) {
    const rest = items.filter((_, n) => n !== i);
    const inRow = new Set(rest.map((x) => x.id));
    // the medium band as this slot sees it: not already in the row, and fitting the caller's caps
    const options = band.filter((x) => !inRow.has(x.id) && x.id !== items[i]!.id && allowed(x, rest));
    if (!options.length) { slots.push({ index: i, id: items[i]!.id, arm: 'exploit', propensity: 1 }); continue; }
    if (rng() < rate) {
      const pick = options[Math.min(options.length - 1, Math.floor(rng() * options.length))]!;
      items[i] = pick;
      slots.push({ index: i, id: pick.id, arm: 'explore', propensity: rate / options.length });
    } else {
      slots.push({ index: i, id: items[i]!.id, arm: 'exploit', propensity: 1 - rate });
    }
  }
  return { items, slots };
}

/** A small seeded generator (mulberry32) for the replay and for tests. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
