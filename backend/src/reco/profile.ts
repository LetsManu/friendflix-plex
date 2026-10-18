// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { homeGens } from '../homegen.js';
import { hourIn, timeBucket, TIME_BUCKETS, type TimeBucket } from './context.js';
import type { ItemDto } from '../media/types.js';
import type { JfUser, ProfileRow } from '../types.js';
import { addScaled, normalize, topDims, vecFromJson, vecToJson, weightsSignature, type FeatureRow, type Index, type SparseVec } from './vectors.js';
import type { RecoCoefficients, RecoWeights } from './weights.js';

/**
 * Recommendation engine v2, R2: the taste profile of one FriendFlix profile (spec 4.3). Signals -> recency decay -> a positive and a
 * negative vector over the item index features, each L2-normalised. Everything stays on the server, per profile; the cache holds
 * numbers (dimension weights, item ids the profile has seen) and nothing else.
 */

/** The profile fields the engine reads. */
export type RecoProfile = Pick<ProfileRow, 'id' | 'user_id' | 'is_owner' | 'kids' | 'kids_max_rating'>;

export type SignalKind =
  | 'thumbUp2' | 'thumbUp1' | 'thumbDown' | 'star' | 'finishedMovie' | 'seriesCompletion' | 'rewatch' | 'favorite' | 'watchlist' | 'abandonedEarly' | 'dropped';

/** One observation: `weight` is the starting weight before decay, `at` the time it happened (ms). */
export interface Signal { item: string; kind: SignalKind; weight: number; at: number }

export interface TastePrefs {
  /** share of the positive weight on anime titles (genre or tag "anime") */
  animeShare: number;
  /** runtime band of what the profile likes: short < 40 min, medium < 100, long */
  runtimeBand: 'short' | 'medium' | 'long' | null;
  /** top genres with their share of the positive weight */
  genres: Record<string, number>;
  /** share of the positive weight that came from rewatching */
  rewatchShare: number;
  /** R3: share of the positive weight by original language of the title (top 5; the index does not know the language of every title) */
  languages?: Record<string, number>;
  /** R3: share of the series the profile started that it dropped or abandoned; null = fewer than 3 started series */
  dropRate?: number | null;
  /** R3: the profile's own plays by time bucket: how many, and the genre mix per bucket and overall (numbers only) */
  timeOfDay?: { n: Record<TimeBucket, number>; genres: Record<TimeBucket, Record<string, number>>; overall: Record<string, number> } | null;
}

export interface Taste {
  pos: SparseVec;
  neg: SparseVec;
  /** distinct titles with a weighted interaction */
  weighted: number;
  /** fewer weighted interactions than coefficients.profile.coldStart: scoring then leans on the quality prior */
  cold: boolean;
  /** series and films the profile has played or started (episodes rolled up into their series) */
  seen: Set<string>;
  prefs: TastePrefs;
  /** R3: the titles that weigh most in the positive vector, strongest first (w relative to the strongest, 0..1): seeds for seedless surfaces and for explanations */
  anchors?: Array<{ id: string; w: number }>;
}

/** One play of a title by the profile (episodes rolled up into their series), when it last happened (ms). */
export interface PlayAt { item: string; at: number }

const ANCHORS_KEPT = 8;

const DAY_MS = 86_400_000;

/** w * 0.5^(age / halfLife); a future timestamp counts as now. */
export function decayed(weight: number, ageDays: number, halfLifeDays: number): number {
  return weight * 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

const anime = (r: FeatureRow) => r.genres.includes('anime') || r.tags.includes('anime');

/**
 * Pure part: signals + item vectors -> taste. Per title the decayed signal weights add up; a positive sum feeds the positive vector,
 * a negative sum the negative one (the title's vector scaled by |sum|). A title without a vector (not indexed yet) still counts as an
 * interaction but adds nothing to either vector.
 */
export function buildTaste(
  signals: readonly Signal[], seen: ReadonlySet<string>, lookup: { vec(id: string): SparseVec | undefined; row(id: string): FeatureRow | undefined },
  c: RecoCoefficients, now = Date.now(), plays: readonly PlayAt[] = [],
): Taste {
  const net = new Map<string, number>();
  const rewatch = new Map<string, number>();
  const counted = new Set<string>();
  for (const s of signals) {
    if (!s.weight || !Number.isFinite(s.weight)) continue;
    counted.add(s.item);
    const w = decayed(s.weight, (now - s.at) / DAY_MS, c.signal.halfLifeDays);
    net.set(s.item, (net.get(s.item) ?? 0) + w);
    if (s.kind === 'rewatch') rewatch.set(s.item, (rewatch.get(s.item) ?? 0) + w);
  }
  const pos: SparseVec = new Map(), neg: SparseVec = new Map();
  const genreW = new Map<string, number>();
  const runtimes: Array<[number, number]> = [];
  let posTotal = 0, animeW = 0, rewatchW = 0;
  const langW = new Map<string, number>();
  const anchorW: Array<[string, number]> = [];
  for (const [id, w] of net) {
    const v = lookup.vec(id);
    if (w > 0) {
      posTotal += w;
      rewatchW += Math.min(w, rewatch.get(id) ?? 0);
      if (v) anchorW.push([id, w]);
      const r = lookup.row(id);
      if (r) {
        if (r.original_language) langW.set(r.original_language, (langW.get(r.original_language) ?? 0) + w);
        if (anime(r)) animeW += w;
        for (const g of r.genres) genreW.set(g, (genreW.get(g) ?? 0) + w / r.genres.length);
        if (r.runtime_min) runtimes.push([r.runtime_min, w]);
      }
      if (v) addScaled(pos, v, w);
    } else if (w < 0 && v) addScaled(neg, v, -w);
  }
  const share = (x: number) => (posTotal > 0 ? Math.round((x / posTotal) * 1000) / 1000 : 0);
  const genres = Object.fromEntries([...genreW.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([g, x]) => [g, share(x)]));
  let runtimeBand: TastePrefs['runtimeBand'] = null;
  if (runtimes.length) {
    runtimes.sort((a, b) => a[0] - b[0]);
    let acc = 0;
    const half = runtimes.reduce((s, [, w]) => s + w, 0) / 2;
    const median = runtimes.find(([, w]) => (acc += w) >= half)![0];
    runtimeBand = median < 40 ? 'short' : median < 100 ? 'medium' : 'long';
  }
  const languages = Object.fromEntries([...langW.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([l, x]) => [l, share(x)]));
  anchorW.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const anchors = anchorW.slice(0, ANCHORS_KEPT).map(([id, w]) => ({ id, w: Math.round((w / anchorW[0]![1]) * 1000) / 1000 }));
  return {
    pos: normalize(pos), neg: normalize(neg), weighted: counted.size, cold: counted.size < c.profile.coldStart, seen: new Set(seen), anchors,
    prefs: { animeShare: share(animeW), runtimeBand, genres, rewatchShare: share(rewatchW), languages, dropRate: dropRate(signals, lookup), timeOfDay: timeOfDay(plays, lookup) },
  };
}

/** Share of the started series that the profile dropped or abandoned early; null with fewer than 3 started series. */
function dropRate(signals: readonly Signal[], lookup: { row(id: string): FeatureRow | undefined }): number | null {
  const started = new Set<string>(), lost = new Set<string>();
  for (const s of signals) {
    if (lookup.row(s.item)?.type !== 'Series') continue;
    if (s.kind === 'seriesCompletion' || s.kind === 'abandonedEarly' || s.kind === 'dropped') started.add(s.item);
    if (s.kind === 'abandonedEarly' || s.kind === 'dropped') lost.add(s.item);
  }
  return started.size >= 3 ? Math.round((lost.size / started.size) * 1000) / 1000 : null;
}

/** The profile's plays by time bucket (instance time zone): count and genre mix per bucket, and the genre mix overall. Null without plays. */
function timeOfDay(plays: readonly PlayAt[], lookup: { row(id: string): FeatureRow | undefined }): TastePrefs['timeOfDay'] {
  const n = { morning: 0, afternoon: 0, evening: 0, night: 0 } as Record<TimeBucket, number>;
  const per = { morning: new Map<string, number>(), afternoon: new Map<string, number>(), evening: new Map<string, number>(), night: new Map<string, number>() } as Record<TimeBucket, Map<string, number>>;
  const all = new Map<string, number>();
  let total = 0;
  for (const p of plays) {
    const r = lookup.row(p.item);
    if (!r?.genres.length) continue;
    const b = timeBucket(hourIn(p.at));
    n[b]++;
    total++;
    for (const g of r.genres) {
      per[b].set(g, (per[b].get(g) ?? 0) + 1 / r.genres.length);
      all.set(g, (all.get(g) ?? 0) + 1 / r.genres.length);
    }
  }
  if (!total) return null;
  const shares = (m: Map<string, number>, div: number) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([g, x]) => [g, Math.round((x / div) * 1000) / 1000]));
  return { n, genres: Object.fromEntries(TIME_BUCKETS.map((b) => [b, shares(per[b], Math.max(1, n[b]))])) as Record<TimeBucket, Record<string, number>>, overall: shares(all, total) };
}

// ----------------------------------------------------------------------------------------------------------------------- signals

const rootOf = (i: Pick<ItemDto, 'id' | 'type' | 'seriesId'>) => (i.type === 'Episode' ? (i.seriesId ?? i.id) : i.id);
const ts = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

export function starWeight(stars: number, c: RecoCoefficients): number {
  const s = c.signal;
  return ({ 5: s.star5, 4: s.star4, 3: s.star3, 2: s.star2, 1: s.star1 } as Record<number, number>)[stars] ?? 0;
}

interface Group { series: boolean; played: Set<string>; maxPct: number; lastAt: number }

/**
 * Collects the profile's signals. Per-profile sources: thumbs, watchlist, dropped, and the watch state of the profile's own media
 * identity (history, favorites; read with the viewer's token). Per-account sources (stars, viewing time for rewatches) have no profile
 * column, so they count for the owner profile only. Failures of the media server count as "no data", never as an error.
 */
export async function gatherSignals(ctx: Pick<Ctx, 'db' | 'jf'>, user: JfUser, profile: RecoProfile, c: RecoCoefficients, now = Date.now()): Promise<{ signals: Signal[]; seen: Set<string>; plays: PlayAt[] }> {
  const [thumbs, watchlist, dropped, ratings, history, favorites] = await Promise.all([
    ctx.db.query<{ item_id: string; value: number; at: Date }>('select item_id, value, created_at as at from thumbs where profile_id=$1', [profile.id]),
    ctx.db.query<{ item_id: string; at: Date }>('select item_id, added_at as at from watchlist where profile_id=$1', [profile.id]),
    ctx.db.query<{ item_id: string; at: Date }>('select item_id, dropped_at as at from dropped where profile_id=$1', [profile.id]),
    profile.is_owner ? ctx.db.query<{ item_id: string; stars: number; at: Date }>('select item_id, stars, created_at as at from ratings where user_id=$1', [profile.user_id]) : Promise.resolve({ rows: [] as Array<{ item_id: string; stars: number; at: Date }> }),
    ctx.jf.history(user, { limit: c.profile.historyLimit }).catch((): ItemDto[] => []),
    ctx.jf.items(user, { filter: 'favorites', types: 'Movie,Series', limit: 100 }).then((r) => r.items).catch((): ItemDto[] => []),
  ]);
  const out: Signal[] = [];
  const s = c.signal;
  for (const r of thumbs.rows) out.push({ item: r.item_id, kind: r.value === 2 ? 'thumbUp2' : r.value > 0 ? 'thumbUp1' : 'thumbDown', weight: r.value === 2 ? s.thumbUp2 : r.value > 0 ? s.thumbUp1 : s.thumbDown, at: r.at.getTime() });
  for (const r of ratings.rows) out.push({ item: r.item_id, kind: 'star', weight: starWeight(r.stars, c), at: r.at.getTime() });
  for (const r of watchlist.rows) out.push({ item: r.item_id, kind: 'watchlist', weight: s.watchlist, at: r.at.getTime() });
  for (const r of dropped.rows) out.push({ item: r.item_id, kind: 'dropped', weight: s.dropped, at: r.at.getTime() });

  // watch state: episodes roll up into their series
  const groups = new Map<string, Group>();
  const runtimeS = new Map<string, { root: string; seconds: number }>();
  const favored = new Set<string>();
  for (const i of history) {
    const root = rootOf(i);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { series: i.type === 'Episode', played: new Set(), maxPct: 0, lastAt: 0 }));
    const pct = i.playedPercentage ?? (i.runtimeTicks && i.positionTicks ? (i.positionTicks / i.runtimeTicks) * 100 : 0);
    if (i.played || pct >= 90) g.played.add(i.id);
    else g.maxPct = Math.max(g.maxPct, pct);
    g.lastAt = Math.max(g.lastAt, ts(i.lastPlayedDate));
    if (i.runtimeTicks) runtimeS.set(i.id, { root, seconds: i.runtimeTicks / 1e7 });
    if (i.favorite) favored.add(root);
  }
  for (const i of favorites) favored.add(rootOf(i));

  // series completion ratio r = played / (played + unplayed), from the series' own unplayed count (viewer's token)
  const seriesIds = [...groups].filter(([, g]) => g.series && g.played.size).map(([id]) => id);
  const unplayed = new Map<string, number>();
  for (let n = 0; n < seriesIds.length; n += 40) {
    const ids = seriesIds.slice(n, n + 40);
    const r = await ctx.jf.items(user, { ids, types: 'Series', limit: 40 }).catch(() => ({ items: [] as ItemDto[] }));
    for (const i of r.items) if (typeof i.unplayedCount === 'number') unplayed.set(i.id, i.unplayedCount);
  }

  // rewatch: a film viewed on 2+ days for at least `rewatchFactor` runtimes (viewing time is per account: owner profile only)
  const rewatched = new Set<string>();
  if (profile.is_owner && runtimeS.size) {
    const rows = (await ctx.db.query<{ item_id: string; s: number }>(
      'select item_id, sum(seconds)::int as s from play_seconds where user_id=$1 and item_id = any($2::text[]) group by item_id having count(*) >= 2', [profile.user_id, [...runtimeS.keys()]],
    ).catch(() => ({ rows: [] as Array<{ item_id: string; s: number }> }))).rows;
    for (const r of rows) {
      const m = runtimeS.get(r.item_id);
      if (m && r.s >= c.profile.rewatchFactor * m.seconds) rewatched.add(m.root);
    }
  }

  const seen = new Set<string>();
  for (const [root, g] of groups) {
    seen.add(root);
    const at = g.lastAt || now;
    if (g.played.size) {
      if (!g.series) out.push({ item: root, kind: 'finishedMovie', weight: s.finishedMovie, at });
      else {
        const left = unplayed.get(root);
        const r = left === undefined ? Math.min(1, g.played.size / 10) : g.played.size / (g.played.size + left);
        out.push({ item: root, kind: 'seriesCompletion', weight: s.seriesCompletion * r, at });
      }
    } else if (g.maxPct < c.profile.abandonPct && now - g.lastAt > c.profile.abandonDays * DAY_MS) {
      out.push({ item: root, kind: 'abandonedEarly', weight: s.abandonedEarly, at });
    }
    if (rewatched.has(root)) out.push({ item: root, kind: 'rewatch', weight: s.rewatch, at });
  }
  for (const root of favored) out.push({ item: root, kind: 'favorite', weight: s.favorite, at: groups.get(root)?.lastAt || now - c.profile.favoriteAgeDays * DAY_MS });
  const plays: PlayAt[] = [...groups].filter(([, g]) => g.lastAt > 0).map(([item, g]) => ({ item, at: g.lastAt }));
  return { signals: out, seen, plays };
}

// ------------------------------------------------------------------------------------------------------------------------ cache

interface Stored { v: 2; pos: Record<string, number>; neg: Record<string, number>; weighted: number; cold: boolean; seen: string[]; prefs: TastePrefs; anchors: Array<{ id: string; w: number }> }

const cacheKey = (profileId: string, ver: string, gens: string, sig: string) => `reco:taste:${profileId}:${ver}:${gens}:${sig}`;

/**
 * The profile's taste, from Redis when the key (profile, user-data version, home generation, weight signature) is unchanged, else
 * built and stored. The user-data version moves with every play / favorite write, the home generation (bumpHome) with every thumb,
 * rating, watchlist and dropped change, so feedback shows up on the next request.
 */
export async function tasteProfile(ctx: Pick<Ctx, 'db' | 'jf' | 'kv'>, user: JfUser, profile: RecoProfile, index: Index, c: RecoCoefficients, w: RecoWeights, now = Date.now()): Promise<Taste> {
  const [ver, gens] = await Promise.all([ctx.jf.userDataVersion(user).catch(() => '0'), homeGens(ctx, profile.id)]);
  const key = cacheKey(profile.id, ver, gens, weightsSignature(w) + ':' + c.signal.halfLifeDays + ':' + c.profile.coldStart);
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) {
    try {
      const o = JSON.parse(hit) as Stored;
      if (o.v === 2) return { pos: vecFromJson(o.pos), neg: vecFromJson(o.neg), weighted: o.weighted, cold: o.cold, seen: new Set(o.seen), prefs: o.prefs, anchors: o.anchors };
    } catch {
      // corrupt entry: rebuild
    }
  }
  const { signals, seen, plays } = await gatherSignals(ctx, user, profile, c, now);
  const built = buildTaste(signals, seen, { vec: (id) => index.vecs.get(id), row: (id) => index.rows.get(id) }, c, now, plays);
  // the stored and the returned vector are the same one: top dimensions only, re-normalised
  const taste: Taste = { ...built, pos: normalize(topDims(built.pos, c.profile.topDims)), neg: normalize(topDims(built.neg, c.profile.topDims)) };
  const stored: Stored = { v: 2, pos: vecToJson(topDims(taste.pos, c.profile.topDims)), neg: vecToJson(topDims(taste.neg, c.profile.topDims)), weighted: taste.weighted, cold: taste.cold, seen: [...taste.seen], prefs: taste.prefs, anchors: taste.anchors ?? [] };
  await ctx.kv.set(key, JSON.stringify(stored), c.profile.cacheTtlSeconds).catch(() => undefined);
  return taste;
}

/** "Reset my recommendations": forgets the cached taste vectors of a profile (the next request rebuilds them from the signals that remain). */
export async function resetTaste(ctx: Pick<Ctx, 'kv'>, profileId: string): Promise<void> {
  for (const k of await ctx.kv.keys(`reco:taste:${profileId}:`).catch(() => [] as string[])) await ctx.kv.del(k).catch(() => undefined);
}
