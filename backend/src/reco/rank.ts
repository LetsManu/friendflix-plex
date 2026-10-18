// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { dot, type SparseVec } from './vectors.js';
import type { RecoCoefficients } from './weights.js';

/**
 * Recommendation engine v2, R2: re-ranking of one row (spec 4.5). Maximal marginal relevance with lambda 0.7: each pick maximises
 *   lambda * relevance - (1 - lambda) * (highest similarity to what is already chosen)
 * with hard caps: at most `perFranchise` titles of one collection per row, and at most ceil(limit * genreShare) (at least 2) titles with
 * the same dominant genre. A near-duplicate of a chosen title (cosine >= duplicateCos) takes a further penalty. When the caps leave the
 * row short, the genre cap is relaxed to fill it (a short row is worse than a genre-heavy one); the franchise cap never is.
 */

export interface RankItem {
  id: string;
  score: number;
  vec?: SparseVec;
  /** collection (franchise) the title belongs to, if any */
  franchise?: string | null;
  /** dominant genre: the first genre the index lists for the title */
  genre?: string | null;
}

export function mmr<T extends RankItem>(items: readonly T[], limit: number, c: Pick<RecoCoefficients, 'rank' | 'penalty'>): T[] {
  if (limit <= 0 || !items.length) return [];
  const { lambda, perFranchise, genreShare, duplicateCos } = c.rank;
  const lo = Math.min(...items.map((i) => i.score)), hi = Math.max(...items.map((i) => i.score));
  const rel = (i: T) => (hi > lo ? (i.score - lo) / (hi - lo) : 1);
  const genreCap = Math.max(2, Math.ceil(limit * genreShare));

  const chosen: T[] = [];
  const left = [...items].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const franchiseN = new Map<string, number>(), genreN = new Map<string, number>();
  const pick = (respectGenre: boolean) => {
    while (chosen.length < limit) {
      let best = -1, bestV = -Infinity;
      for (let n = 0; n < left.length; n++) {
        const it = left[n]!;
        if (it.franchise && (franchiseN.get(it.franchise) ?? 0) >= perFranchise) continue;
        if (respectGenre && it.genre && (genreN.get(it.genre) ?? 0) >= genreCap) continue;
        let sim = 0;
        if (it.vec) for (const ch of chosen) if (ch.vec) sim = Math.max(sim, dot(it.vec, ch.vec));
        const v = lambda * rel(it) - (1 - lambda) * sim - (sim >= duplicateCos ? c.penalty.nearDuplicate : 0);
        if (v > bestV) { bestV = v; best = n; }
      }
      if (best < 0) return;
      const [it] = left.splice(best, 1) as [T];
      chosen.push(it);
      if (it.franchise) franchiseN.set(it.franchise, (franchiseN.get(it.franchise) ?? 0) + 1);
      if (it.genre) genreN.set(it.genre, (genreN.get(it.genre) ?? 0) + 1);
    }
  };
  pick(true);
  if (chosen.length < limit) pick(false);
  return chosen;
}
