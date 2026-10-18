// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { CreditDto } from '../media/types.js';
import type { JfUser } from '../types.js';
import { resolveVisible } from './candidates.js';
import type { Scored } from './score.js';
import type { Taste } from './profile.js';
import { dot, type FeatureRow, type Index } from './vectors.js';
import type { RecoCoefficients } from './weights.js';

/**
 * Recommendation engine v2, R3: explanations (spec 4.6). Every item carries `reason`: the seed that contributed most, plus up to two
 * shared traits. A trait is "kind" or "kind:value":
 *   friends[:Anna, Ben]  friends rated it / recommended it (names only as far as the friends' opt-ins allow, see sources.ts)
 *   next                 people watch this next (transition aggregate)
 *   together             people who watched the seed also watched this (co-occurrence aggregate)
 *   universe             same collection / franchise as the seed
 *   director:Name  actor:Name  studio:Name  genre:name   shared with the seed
 * The first two that apply in this order are used. Names of people come from the seed's credits (one media-server call per seed, with the
 * viewer's token); without them the trait carries the kind only. Nothing here reaches metrics or logs.
 */

export type TraitKind = 'friends' | 'next' | 'together' | 'universe' | 'director' | 'actor' | 'studio' | 'genre';
export const TRAIT_KINDS: readonly TraitKind[] = ['friends', 'next', 'together', 'universe', 'director', 'actor', 'studio', 'genre'];
export interface Reason { seed: { id: string; name: string } | null; traits: string[] }

const MAX_TRAITS = 2;
/** credits are fetched for at most this many seeds per call */
const MAX_CREDIT_CALLS = 3;
/** an anchor must be at least this similar to the title to count as the reason for it */
const MIN_ANCHOR_COS = 0.05;

/** The seed that contributed most: the explicit seed, else the producing anchor of a crowd signal, else the profile anchor closest to the title. */
export function seedFor(s: Scored, seedId: string | undefined, taste: Pick<Taste, 'anchors'>, index: Index): string | null {
  if (seedId) return seedId;
  const via = s.meta.via;
  if (via && (s.parts.cooccurrence > 0 || s.parts.transition > 0)) return via;
  if (!s.vec) return null;
  let best: string | null = null, bestV = MIN_ANCHOR_COS;
  for (const a of taste.anchors ?? []) {
    const v = index.vecs.get(a.id);
    if (!v || a.id === s.id) continue;
    const contribution = a.w * dot(s.vec, v);
    if (contribution > bestV) { bestV = contribution; best = a.id; }
  }
  return best;
}

interface SeedFacts { row: FeatureRow | undefined; people: Map<string, CreditDto> }

/** Shared traits of the title and its seed, in priority order (before the cut to two). */
function traitsFor(s: Scored, seed: SeedFacts | null, c: RecoCoefficients, index: Index): string[] {
  const out: string[] = [];
  const friends = s.meta.friends?.length ? s.meta.friends.slice(0, 2).join(', ') : '';
  if (s.parts.friends > 0) out.push(friends ? `friends:${friends}` : 'friends');
  if (s.parts.transition > 0) out.push('next');
  if (s.parts.cooccurrence > 0 && s.parts.transition <= 0) out.push('together');
  const a = seed?.row, b = s.row;
  if (a && b) {
    if (a.collection_id && a.collection_id === b.collection_id) out.push('universe');
    const shared = b.people.filter((p) => a.people.includes(p));
    const creator = shared.find((p) => (seed!.people.get(p) ? /director|writer|creator/i.test(seed!.people.get(p)!.type) : a.people.indexOf(p) < c.candidates.creatorSlots));
    const actor = shared.find((p) => p !== creator && (seed!.people.get(p) ? /actor|guest/i.test(seed!.people.get(p)!.type) : a.people.indexOf(p) >= c.candidates.creatorSlots));
    const named = (p: string | undefined) => (p && seed!.people.get(p) ? `:${seed!.people.get(p)!.name}` : '');
    if (creator) out.push(`director${named(creator)}`);
    if (actor) out.push(`actor${named(actor)}`);
    const studio = b.studios.find((x) => a.studios.includes(x));
    if (studio) out.push(`studio:${studio}`);
    const genres = b.genres.filter((g) => a.genres.includes(g)).sort((x, y) => (index.idf.genre.get(y) ?? 0) - (index.idf.genre.get(x) ?? 0) || (x < y ? -1 : 1)); // the rarest shared genre first
    if (genres[0]) out.push(`genre:${genres[0]}`);
  }
  return out;
}

/**
 * Reasons for the finally chosen items. `seed` is the explicit seed of the call (post-play, because, detail), if any. Never throws: an
 * item whose explanation cannot be built just has fewer traits.
 */
export async function explain(
  ctx: Pick<Ctx, 'jf'>, user: JfUser, items: readonly Scored[],
  x: { seed?: { id: string; name: string }; taste: Taste; index: Index; c: RecoCoefficients },
): Promise<Map<string, Reason>> {
  const out = new Map<string, Reason>();
  const seeds = new Map<string, string | null>(items.map((s) => [s.id, seedFor(s, x.seed?.id, x.taste, x.index)]));
  const names = new Map<string, string>();
  if (x.seed) names.set(x.seed.id, x.seed.name);
  const need = [...new Set([...seeds.values()].filter((i): i is string => i !== null && !names.has(i)))];
  if (need.length) for (const [id, it] of await resolveVisible(ctx, user, need).catch(() => new Map())) names.set(id, it.name);

  // people names: the credits of the (few) seeds that share a person with some title
  const credits = new Map<string, Map<string, CreditDto>>();
  const wantPeople = new Set<string>();
  for (const s of items) {
    const id = seeds.get(s.id);
    const a = id ? x.index.rows.get(id) : undefined;
    if (id && a && s.row?.people.some((p) => a.people.includes(p))) wantPeople.add(id);
  }
  const credit = ctx.jf.credits?.bind(ctx.jf);
  if (credit) {
    for (const id of [...wantPeople].slice(0, MAX_CREDIT_CALLS)) {
      const r = await credit(user, id).catch(() => null);
      if (r) credits.set(id, new Map(r.people.map((p) => [p.id, p])));
    }
  }
  for (const s of items) {
    const id = seeds.get(s.id) ?? null;
    const row = id ? x.index.rows.get(id) : undefined;
    const facts: SeedFacts | null = id ? { row, people: credits.get(id) ?? new Map() } : null;
    let traits = traitsFor(s, facts, x.c, x.index);
    if (!id && !traits.length) {
      // no seed at all (taste surface, cold profile): the profile's own favourite genre the title belongs to
      const g = (s.row?.genres ?? []).find((q) => (x.taste.prefs.genres[q] ?? 0) > 0);
      if (g) traits = [`genre:${g}`];
    }
    out.set(s.id, { seed: id && names.has(id) ? { id, name: names.get(id)! } : null, traits: dedupeKinds(traits).slice(0, MAX_TRAITS) });
  }
  return out;
}

/** One trait per kind (director before actor ...), keeping the order. */
function dedupeKinds(traits: string[]): string[] {
  const seen = new Set<string>();
  return traits.filter((t) => {
    const k = t.split(':')[0]!;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
