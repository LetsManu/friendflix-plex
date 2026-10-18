// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import type { JfUser } from '../types.js';
import type { RecoProfile, Taste } from './profile.js';
import type { Surface, RecoCoefficients } from './weights.js';
import { nearest, type Index } from './vectors.js';

/**
 * Recommendation engine v2, R2: candidate generation (spec 4.4). Every candidate carries the sources that proposed it.
 * Implemented: 1 `similar` (the media server's similar() for the seed), 2 `universe` (same collection or shared creator),
 * 3 `taste_nn` (nearest neighbours of the profile vector in the item index, bounded by its inverted index), plus `prior` (cold-start filler by quality).
 *
 * Extension points: a source is one `CandidateSource` pushed with registerSource(); `social: true` marks sources built on other
 * accounts' data (co-occurrence, transitions, friends, trending), which gatherCandidates never runs for a kids profile. A source may
 * return numeric `signals` (cooccurrence, transition, friends, trending, each 0..1) that score.ts weights per surface, and `meta`.
 * R3 adds those sources in sources.ts (RECO_SOURCES = SOURCES + co-occurrence, transition, friends, trending, fresh).
 */

export type SourceName = 'similar' | 'universe' | 'taste_nn' | 'prior' | 'cooccurrence' | 'transition' | 'friends' | 'trending' | 'fresh';
export type SignalName = 'cooccurrence' | 'transition' | 'friends' | 'trending';

/** What a source knows about a hit beyond the numbers; the explanations (explain.ts) and the scoring (score.ts) read it. */
export interface HitMeta {
  /** the seed or profile anchor that produced the hit with its strongest signal (co-occurrence, transition) */
  via?: string;
  /** first names of friends behind the hit, only as far as the friends' opt-ins allow (at most 3) */
  friends?: string[];
  /** the media server's fresh label of the title (fresh.ts) */
  fresh?: 'newEpisode' | 'newSeason' | 'finale' | 'newSeries' | 'new';
}

export interface Candidate {
  id: string;
  sources: Set<SourceName>;
  /** resolved with the viewer's token (similar() answers come resolved; the others are looked up afterwards) */
  item?: ItemDto;
  /** 1 for the first answer of the media server's similar(), falling to 0 for the last */
  jfRank?: number;
  signals: Partial<Record<SignalName, number>>;
  meta: HitMeta;
}

export interface SourceInput {
  ctx: Pick<Ctx, 'jf' | 'db' | 'kv'>;
  user: JfUser;
  profile: RecoProfile;
  taste: Taste;
  index: Index;
  c: RecoCoefficients;
  surface: Surface;
  /** the seed title (a film or series; an episode was rolled up by the caller) */
  seed?: ItemDto;
  /** the clock of the request (ms); sources that look at dates use it, tests pin it */
  now?: number;
}

export interface SourceHit { id: string; item?: ItemDto; jfRank?: number; signals?: Partial<Record<SignalName, number>>; meta?: HitMeta }

export interface CandidateSource {
  name: SourceName;
  /** built on other accounts' data: never run for kids profiles */
  social: boolean;
  run(input: SourceInput): Promise<SourceHit[]>;
}

/** Sources that read other accounts' data. A kids profile gets none of them (spec 4.8), whatever else is registered. */
export const SOCIAL_SOURCES: ReadonlySet<SourceName> = new Set<SourceName>(['cooccurrence', 'transition', 'friends', 'trending']);

const similarSource: CandidateSource = {
  name: 'similar', social: false,
  async run({ ctx, user, seed, c }) {
    if (!seed) return [];
    const list = (await ctx.jf.similar(user, seed.id, c.candidates.similar).catch((): ItemDto[] => [])).filter((i) => i.id !== seed.id);
    return list.map((item, n) => ({ id: item.id, item, jfRank: list.length > 1 ? 1 - n / (list.length - 1) : 1 }));
  },
};

const universeSource: CandidateSource = {
  name: 'universe', social: false,
  async run({ seed, index, c }) {
    const row = seed && index.rows.get(seed.id);
    if (!seed || !row) return [];
    const out = new Set<string>();
    if (row.collection_id) for (const id of index.byCollection.get(row.collection_id) ?? []) if (id !== seed.id) out.add(id);
    const creators = new Set(row.people.slice(0, c.candidates.creatorSlots));
    // the inverted index lists the titles of each person (p:<id>): only those are looked at, never the whole library
    for (const p of creators) {
      for (const id of index.postings.get('p:' + p) ?? []) {
        if (out.size >= c.candidates.universe * 3) break;
        if (id !== seed.id && index.rows.get(id)?.people.slice(0, c.candidates.creatorSlots).some((x) => creators.has(x))) out.add(id);
      }
    }
    // collection mates first, then creators (the Set keeps insertion order)
    return [...out].slice(0, c.candidates.universe).map((id) => ({ id }));
  },
};

const tasteNnSource: CandidateSource = {
  name: 'taste_nn', social: false,
  async run({ taste, index, c }) {
    if (taste.cold || !taste.pos.size) return [];
    // bounded: only titles sharing one of the profile's strongest dimensions are scored (vectors.ts nearest)
    return nearest(index, taste.pos, c.candidates.knn, (id) => taste.seen.has(id)).map(([id]) => ({ id }));
  },
};

const priorSource: CandidateSource = {
  name: 'prior', social: false,
  async run({ taste, seed, index, c }) {
    if (seed || !taste.cold) return [];
    return index.topRated.slice(0, c.candidates.prior).map((id) => ({ id }));
  },
};

export const SOURCES: CandidateSource[] = [similarSource, universeSource, tasteNnSource, priorSource];

export function registerSource(s: CandidateSource, list: CandidateSource[] = SOURCES): void {
  if (!list.some((x) => x.name === s.name)) list.push(s);
}

/** Runs every allowed source in parallel (a failing source contributes nothing) and merges the hits per item id. */
export async function gatherCandidates(input: SourceInput, sources: readonly CandidateSource[] = SOURCES): Promise<Map<string, Candidate>> {
  const allowed = sources.filter((s) => !(input.profile.kids && (s.social || SOCIAL_SOURCES.has(s.name))));
  const lists = await Promise.all(allowed.map((s) => s.run(input).catch((): SourceHit[] => [])));
  const out = new Map<string, Candidate>();
  allowed.forEach((s, n) => {
    for (const h of lists[n]!) {
      let cand = out.get(h.id);
      if (!cand) out.set(h.id, (cand = { id: h.id, sources: new Set(), signals: {}, meta: {} }));
      cand.sources.add(s.name);
      if (h.item && !cand.item) cand.item = h.item;
      if (h.jfRank !== undefined) cand.jfRank = Math.max(cand.jfRank ?? 0, h.jfRank);
      for (const [k, v] of Object.entries(h.signals ?? {})) {
        // the anchor behind the strongest signal explains the hit
        if (h.meta?.via && v >= (cand.signals[k as SignalName] ?? 0)) cand.meta.via = h.meta.via;
        cand.signals[k as SignalName] = Math.max(cand.signals[k as SignalName] ?? 0, v);
      }
      if (h.meta?.friends?.length) cand.meta.friends = [...new Set([...(cand.meta.friends ?? []), ...h.meta.friends])].slice(0, 3);
      if (h.meta?.fresh && !cand.meta.fresh) cand.meta.fresh = h.meta.fresh;
    }
  });
  return out;
}

/** Looks the ids up with the viewer's own token (library permissions and the kids age cap apply); what the viewer cannot see is simply absent. */
export async function resolveVisible(ctx: Pick<Ctx, 'jf'>, user: JfUser, ids: string[]): Promise<Map<string, ItemDto>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  const out = new Map<string, ItemDto>();
  for (let i = 0; i < chunks.length; i += 4) {
    const parts = await Promise.all(chunks.slice(i, i + 4).map((ch) => ctx.jf.items(user, { ids: ch, types: 'Movie,Series', limit: 40 }).then((r) => r.items).catch((): ItemDto[] => [])));
    for (const it of parts.flat()) out.set(it.id, it);
  }
  return out;
}
