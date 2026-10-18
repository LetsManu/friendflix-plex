// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { friendsRatedRows, recommendationRows, trendingItems } from '../discoverData.js';
import { badgesFor } from '../fresh.js';
import type { ItemDto } from '../media/types.js';
import { coocSignals, tablesOfViewer, transitionSignals } from './aggregates.js';
import { SOURCES, type CandidateSource, type SourceHit, type SourceInput } from './candidates.js';

/**
 * Recommendation engine v2, R3: the candidate sources that build on other accounts' aggregates and on the library's fresh labels
 * (spec 4.4 items 4-7). Each is skipped when the surface gives its signal no weight, so a surface never pays for what it ignores.
 * Everything here marked `social` is never run for a kids profile (gatherCandidates), and each source checks it once more itself.
 */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The titles a seedless surface co-occurs from: the profile's strongest positives. With a seed, the seed alone. */
function anchorsOf({ seed, taste, c }: SourceInput): Array<{ id: string; w: number }> {
  if (seed) return [{ id: seed.id, w: 1 }];
  return (taste.anchors ?? []).slice(0, c.social.anchors);
}

const cooccurrenceSource: CandidateSource = {
  name: 'cooccurrence', social: true,
  async run(input) {
    const { ctx, profile, index, c, surface } = input;
    if (profile.kids || !(c.surface[surface].cooccurrence > 0)) return [];
    const anchors = anchorsOf(input);
    if (!anchors.length) return [];
    const { tables, own } = await tablesOfViewer(ctx, index, c, profile.user_id);
    const best = new Map<string, { s: number; via: string }>();
    for (const a of anchors) {
      for (const [id, cos] of coocSignals(tables, a.id, { own, minSupport: c.social.minSupport })) {
        const s = clamp01(cos * a.w);
        if (id !== a.id && s > (best.get(id)?.s ?? 0)) best.set(id, { s, via: a.id });
      }
    }
    return [...best].map(([id, b]): SourceHit => ({ id, signals: { cooccurrence: b.s }, meta: { via: b.via } }));
  },
};

const transitionSource: CandidateSource = {
  name: 'transition', social: true,
  async run(input) {
    const { ctx, profile, index, c, surface, seed } = input;
    // a transition needs a title that was just finished: the seed. Surfaces without a seed (taste, home rows) have none.
    if (profile.kids || !seed || !(c.surface[surface].transition > 0)) return [];
    const { tables, own } = await tablesOfViewer(ctx, index, c, profile.user_id);
    return [...transitionSignals(tables, seed.id, { own, minSupport: c.social.minSupport })].map(([id, t]): SourceHit => ({ id, signals: { transition: t.p }, meta: { via: seed.id } }));
  },
};

const friendsSource: CandidateSource = {
  name: 'friends', social: true,
  async run({ ctx, profile, c, surface }) {
    if (profile.kids || !(c.surface[surface].friends > 0)) return [];
    // the existing queries, with their opt-ins: friends' ratings need shareRatings (default on), recommendations are sent to this user
    const [rated, recs] = await Promise.all([
      friendsRatedRows(ctx, profile.user_id, profile.id).catch(() => []),
      recommendationRows(ctx, profile.user_id).catch(() => []),
    ]);
    const out = new Map<string, SourceHit>();
    for (const r of rated) {
      const avg = Number(r.avg);
      const s = clamp01(clamp01((avg - 3) / 2) + Math.min(0.2, 0.1 * (r.who.length - 1)));
      out.set(r.item_id, { id: r.item_id, signals: { friends: s }, meta: { friends: r.who.slice(0, 2) } });
    }
    for (const r of recs) {
      const prev = out.get(r.item_id);
      out.set(r.item_id, { id: r.item_id, signals: { friends: 1 }, meta: { friends: [...new Set([r.from_name, ...(prev?.meta?.friends ?? [])])].slice(0, 2) } });
    }
    return [...out.values()];
  },
};

const trendingSource: CandidateSource = {
  name: 'trending', social: true,
  async run({ ctx, user, profile, c, surface }) {
    if (profile.kids || !(c.surface[surface].trending > 0)) return [];
    const items = await trendingItems(ctx, user, profile.user_id).catch(() => []);
    const top = Math.max(3, ...items.map((i) => i.viewers));
    return items.map((it): SourceHit => ({ id: it.id, item: it, signals: { trending: clamp01(Math.log1p(it.viewers) / Math.log1p(top)) } }));
  },
};

/** Recently added titles the media server labels new (fresh.ts): new series, new films, and a new season of a series the profile watches. */
const RECENT = 40;
const freshSource: CandidateSource = {
  name: 'fresh', social: false,
  async run({ ctx, user, taste, now }) {
    const recent = await ctx.jf.items(user, { types: 'Movie,Series', sort: 'DateLastContentAdded,DateCreated', desc: true, limit: RECENT }).then((r) => r.items).catch((): ItemDto[] => []);
    if (!recent.length) return [];
    const badges = await badgesFor(ctx, user, recent, now).catch(() => ({}) as Awaited<ReturnType<typeof badgesFor>>);
    const out: SourceHit[] = [];
    for (const it of recent) {
      const label = badges[it.id]?.fresh;
      if (!label) continue;
      // a series the profile already watches is a candidate only for its new season (the rest belongs to "continue watching")
      if (taste.seen.has(it.id) ? label !== 'newSeason' : label !== 'newSeries' && label !== 'new' && label !== 'newSeason') continue;
      out.push({ id: it.id, item: it, meta: { fresh: label } });
    }
    return out;
  },
};

/** Every source of the engine: the R2 sources plus the R3 ones. recommend() uses this list unless a caller passes its own. */
export const RECO_SOURCES: readonly CandidateSource[] = [...SOURCES, cooccurrenceSource, transitionSource, friendsSource, trendingSource, freshSource];
