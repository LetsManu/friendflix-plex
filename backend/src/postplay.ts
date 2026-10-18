// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 1.1 "Caught-up" post-play screen (spec §3): what comes after the title the viewer just finished, built on the EXISTING
 * recommendation building blocks (Jellyfin similar(), libraryBecause / libraryBecauseMore, friendsRatedFor, collections, hubs).
 *
 * State (spec §3.1):
 *   next             an unplayed follow-up exists (next available episode, next part of a film collection)
 *   gap              no next episode, but an earlier available episode is still unwatched ("Episode N is still unwatched")
 *   series_finished  last episode of a series whose status is known to be ENDED (never claimed when the status is unknown, fresh.ts rule)
 *   caught_up        last available episode of a continuing series, or of one whose status is unknown
 *   movie_end        a film without an unplayed later part
 *
 * Rows (spec §3.3, in this order, each left out when empty): continuation, [transition: R3], universe, because, friends, taste.
 * Every item is resolved with the viewer's own media-server identity (role libraries, kids age cap apply); kids profiles never get
 * the friends row (nor, later, the transition / co-watch sources). Nothing here logs or counts titles.
 */
import { createHash } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { continuingIds } from './fresh.js';
import { homeGens } from './homegen.js';
import { MediaError, type ItemDto, type MediaCollection, type SeriesStatus } from './media/types.js';
import { quota } from './requestlimit.js';
import { transitionsFor } from './reco/aggregates.js';
import { countFallback, rankHomeRows, recoProfileOf, v2Active, withReason, type EngineName } from './reco/engine.js';
import type { RecoProfile } from './reco/profile.js';
import { recommend } from './reco/recommend.js';
import type { RowKind as RecoRowKind } from './reco/rows.js';
import { friendsRatedFor, libraryBecause, libraryBecauseMore, BECAUSE_TTL } from './routes/discover.js';
import { portalStatus, requestsClient, requestsEnabled } from './seerr/client.js';
import type { JfUser } from './types.js';

export const POSTPLAY_STATES = ['next', 'movie_end', 'series_finished', 'caught_up', 'gap'] as const;
export type PostplayState = (typeof POSTPLAY_STATES)[number];
/** Row kinds in display order. 'transition' ("What people watch after X") is reserved for R3 (see ROW_SOURCES). */
export const ROW_KINDS = ['continuation', 'transition', 'universe', 'because', 'friends', 'taste'] as const;
export type RowKind = (typeof ROW_KINDS)[number];

/** Response cache lifetime (seconds); the key also carries the user-data version and the home generation (bumpHome). */
export const POSTPLAY_TTL = 60;
/** at most this many items per row */
export const ROW_MAX = 20;
/** a title that premiered within this many days counts as "current season" (anti-pattern: at most 1 in 3 per row) */
export const CURRENT_SEASON_DAYS = 91;
const DAY = 86_400_000;

export interface RowReason { seed?: { id: string; name: string }; traits?: string[] }
export interface Wish { mediaType: 'tv'; tmdbId: number; quota: { limit: number | null; used: number; remaining: number | null; resetsAt: string } }
export interface PostplayRow {
  kind: RowKind; /** the row's subject (seed, collection or hub name); the web builds the localized heading from kind + title */ title: string; reason: RowReason;
  /** items of a v2 row carry `reason` (seed + up to two shared traits, reco/explain.ts); the web turns it into the caption */
  items: ItemDto[]; wish?: Wish;
  /** which engine built the row (RECO_ENGINE=v2 rows that fell back to v1 say v1) */
  engine?: EngineName;
  /** the row kind the recommendation counters use for this row (reco/rows.ts); the web tags impressions, clicks, plays and dismisses with it */
  recoRow?: RecoRowKind;
}
/** The row kind the recommendation counters and the row ranker know this row by (reco/rows.ts ROW_KINDS). */
export const RECO_ROW_OF: Record<RowKind, RecoRowKind> = { continuation: 'continue', transition: 'transition', universe: 'universe', because: 'postplay', friends: 'friends', taste: 'top_picks' };
export interface Postplay {
  state: PostplayState;
  current: ItemDto;
  next: ItemDto | null;
  nextAirDate: string | null;
  sequel: ItemDto | null;
  canWish: boolean;
  /** "Remind me" target (an announced episode; existing reminders flow, POST /api/reminders {episodeId}); null on kids profiles */
  remind: { episodeId: string } | null;
  rows: PostplayRow[];
  hero: ItemDto | null;
  /** false: the profile turned "Show suggestions after the last episode" off (only the continuation row is sent) */
  suggestions: boolean;
  /** v2 when RECO_ENGINE=v2 built at least one row, else v1 */
  engine: EngineName;
}

export interface Viewer {
  user: JfUser;
  userId: string;
  role: string;
  profileId: string;
  kids: boolean;
  /** per-profile prefs that shape the answer */
  suggestions: boolean;
  spoilerProtection: boolean;
}

// ---------------------------------------------------------------- pure helpers (unit-tested)

const ms = (v?: string): number | null => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** premiered within CURRENT_SEASON_DAYS before `now` (not in the future) */
export function isCurrentSeason(i: Pick<ItemDto, 'premiereDate'>, now: number): boolean {
  const p = ms(i.premiereDate);
  return p !== null && p <= now + DAY && now - p <= CURRENT_SEASON_DAYS * DAY;
}

/**
 * Anti-pattern (spec §2.3 lesson 11) "balance current season vs. back catalog": at most 1 in 3 items of a row is a current-season title.
 * Keeps the order of each group; current-season titles go to every third slot (3rd, 6th ...), the surplus is dropped.
 */
export function balanceSeason(items: ItemDto[], now: number): ItemDto[] {
  const cur = items.filter((i) => isCurrentSeason(i, now));
  const back = items.filter((i) => !isCurrentSeason(i, now));
  const k = Math.min(cur.length, Math.floor(back.length / 2)); // k <= (back + k) / 3
  const out: ItemDto[] = [];
  let c = 0, b = 0;
  while (b < back.length || c < k) {
    if (c < k && (out.length + 1) % 3 === 0) out.push(cur[c++]!);
    else if (b < back.length) out.push(back[b++]!);
    else break;
  }
  return out;
}

/** an already-watched title (a fully watched series counts too: spec §2.3 lesson 11 "no already-watched series") */
export const alreadyWatched = (i: Pick<ItemDto, 'type' | 'played' | 'unplayedCount' | 'childCount'>): boolean =>
  i.played || (i.type === 'Series' && i.unplayedCount === 0 && (i.childCount ?? 0) > 0);

/** stable per-profile order: the same candidates do not give every profile the same hero */
const salt = (profileId: string, id: string): number => createHash('sha256').update(`${profileId}:${id}`).digest().readUInt32BE(0);

/**
 * The hero: the strongest recommendation for THIS profile. Candidates are the first 8 of the "because" row; a title that also fits
 * the profile's taste row ranks first, then titles with artwork, then a per-profile stable shuffle.
 */
export function pickHero(candidates: ItemDto[], taste: Set<string>, profileId: string): ItemDto | null {
  const top = candidates.slice(0, 8);
  if (!top.length) return null;
  const score = (i: ItemDto) => (taste.has(i.id) ? 2 : 0) + (i.backdrop ? 1 : 0);
  return [...top].sort((a, b) => score(b) - score(a) || salt(profileId, a.id) - salt(profileId, b.id))[0]!;
}

/** next later part of a film in its collections that the viewer has not watched yet */
export function nextPart(cols: MediaCollection[], itemId: string): { item: ItemDto; collection: MediaCollection } | null {
  for (const c of cols) {
    const at = c.parts.findIndex((p) => p.item.id === itemId);
    if (at < 0) continue;
    const later = c.parts.slice(at + 1).find((p) => !p.item.played);
    if (later) return { item: later.item, collection: c };
  }
  return null;
}

/** unwatched episode with spoiler protection on: no description (the web also hides its thumbnail) */
const spoilerSafe = (i: ItemDto | null, v: Viewer): ItemDto | null =>
  i && v.spoilerProtection && i.type === 'Episode' && !i.played && !i.positionTicks ? { ...i, overview: undefined } : i;

// ---------------------------------------------------------------- state

interface Facts {
  state: PostplayState;
  /** the title the rows are about: the series of an episode, else the item */
  subject: ItemDto;
  next: ItemDto | null;
  sequel: ItemDto | null;
  nextAirDate: string | null;
  remind: { episodeId: string } | null;
  /** collection the continuation comes from (films / series sequels) */
  collection: MediaCollection | null;
  collections: MediaCollection[];
}

const soft = async <T>(p: Promise<T> | undefined, fallback: T): Promise<T> => { try { return (await p) ?? fallback; } catch { return fallback; } };

/** Series status: the optional media hook first; without it (or unknown) only a positive "continuing" from fresh.ts' list counts. */
async function statusOf(ctx: Ctx, user: JfUser, seriesId: string): Promise<SeriesStatus> {
  const st = ctx.jf.seriesStatus ? await soft(ctx.jf.seriesStatus(user, seriesId), null) : null;
  if (st) return st;
  const cont = await continuingIds(ctx, user).catch(() => null);
  return cont?.has(seriesId) ? 'continuing' : null; // absent from the list is NOT "ended": unknown stays unknown
}

/** next announced episode of a series (date + reminder target): the unavailable next episode, else the server's upcoming list */
async function announced(ctx: Ctx, user: JfUser, seriesId: string, candidate: ItemDto | null, now: number): Promise<{ date: string | null; id: string | null }> {
  const future = (i: ItemDto) => { const p = ms(i.premiereDate); return p !== null && p >= now - DAY; };
  if (candidate && future(candidate)) return { date: candidate.premiereDate!.slice(0, 10), id: candidate.id };
  const up = (await soft(ctx.jf.upcoming(user), [] as ItemDto[])).filter((e) => e.seriesId === seriesId && future(e));
  up.sort((a, b) => (ms(a.premiereDate) ?? 0) - (ms(b.premiereDate) ?? 0));
  const first = up[0] ?? null;
  if (first) return { date: first.premiereDate!.slice(0, 10), id: first.id };
  return { date: candidate?.premiereDate && future(candidate) ? candidate.premiereDate.slice(0, 10) : null, id: null };
}

/** the earliest still-unwatched available episode BEFORE `currentId` (specials left out) */
async function gapEpisode(ctx: Ctx, user: JfUser, seriesId: string, currentId: string | null): Promise<ItemDto | null> {
  const eps = await soft(ctx.jf.episodes(user, seriesId), [] as ItemDto[]);
  const at = currentId ? eps.findIndex((e) => e.id === currentId) : eps.length;
  const before = eps.slice(0, at < 0 ? eps.length : at).filter((e) => !e.played && e.parentIndexNumber !== 0 && e.id !== currentId).slice(0, 40);
  if (!before.length) return null;
  const real = await soft(ctx.jf.availableEpisodes(user, before.map((e) => e.id)), new Set<string>());
  return before.find((e) => real.has(e.id)) ?? null;
}

export async function factsFor(ctx: Ctx, v: Viewer, cur: ItemDto, now = Date.now()): Promise<Facts> {
  const user = v.user;
  const colsOf = (id: string) => (ctx.jf.itemCollections ? soft(ctx.jf.itemCollections(user, id), [] as MediaCollection[]) : Promise.resolve([] as MediaCollection[]));
  if (cur.type === 'Movie') {
    const cols = await colsOf(cur.id);
    const np = nextPart(cols, cur.id);
    return { state: np ? 'next' : 'movie_end', subject: cur, next: np?.item ?? null, sequel: null, nextAirDate: null, remind: null, collection: np?.collection ?? cols[0] ?? null, collections: cols };
  }
  const seriesId = cur.type === 'Series' ? cur.id : cur.seriesId;
  if (!seriesId) return { state: 'movie_end', subject: cur, next: null, sequel: null, nextAirDate: null, remind: null, collection: null, collections: [] };
  const series = cur.type === 'Series' ? cur : await ctx.jf.item(user, seriesId).catch(() => null);
  const subject = series ?? cur;
  // the episode after this one (also across seasons); a series opened directly: the server's "next up"
  const nx: ItemDto | null = cur.type === 'Episode'
    ? await soft(ctx.jf.nextEpisode(user, seriesId, cur.id), null)
    : (await soft(ctx.jf.nextUp(user, seriesId), [] as ItemDto[]))[0] ?? null;
  const nxReal = nx ? (await soft(ctx.jf.availableEpisodes(user, [nx.id]), new Set<string>())).has(nx.id) : false;
  const base = { subject, sequel: null, nextAirDate: null, remind: null, collection: null, collections: [] as MediaCollection[] };
  if (nx && nxReal) return { ...base, state: 'next', next: nx };
  const gap = await gapEpisode(ctx, user, seriesId, cur.type === 'Episode' ? cur.id : null);
  if (gap) return { ...base, state: 'gap', next: gap };
  const status = await statusOf(ctx, user, seriesId);
  if (status === 'ended') {
    const cols = await colsOf(seriesId);
    const sq = nextPart(cols, seriesId); // a later part of a collection the series belongs to (sequel / spin-off)
    return { ...base, state: 'series_finished', next: null, sequel: sq?.item ?? null, collection: sq?.collection ?? cols[0] ?? null, collections: cols };
  }
  // continuing or unknown: "You're caught up" (true in both cases); a next air date only when the server announces one
  const a = await announced(ctx, user, seriesId, nx, now);
  const cols = await colsOf(seriesId);
  return { ...base, state: 'caught_up', next: null, nextAirDate: a.date, remind: a.id && !v.kids ? { episodeId: a.id } : null, collection: cols[0] ?? null, collections: cols };
}

// ---------------------------------------------------------------- rows

interface SourceCtx {
  ctx: Ctx;
  v: Viewer;
  cur: ItemDto;
  facts: Facts;
  ver: string;
  now: number;
  /** filled by the taste source, read by the hero pick */
  taste: Set<string>;
  /** RECO_ENGINE=v2: the viewer's profile (recommend() input); undefined = v1 */
  profile?: RecoProfile;
}

type RowSource = (s: SourceCtx) => Promise<PostplayRow | null>;

const MOVIES_AND_SERIES = 'Movie,Series';

async function cachedSimilar(s: SourceCtx, seedId: string): Promise<ItemDto[]> {
  const key = `ppsim:${s.v.user.jellyfin_user_id}:${seedId}:${s.ver}`;
  const hit = await s.ctx.kv.get(key).catch(() => null);
  if (hit) { try { return JSON.parse(hit) as ItemDto[]; } catch { /* recompute */ } }
  const items = await soft(s.ctx.jf.similar(s.v.user, seedId, 30), [] as ItemDto[]);
  await s.ctx.kv.set(key, JSON.stringify(items), BECAUSE_TTL).catch(() => undefined);
  return items;
}

/** 1. Continuation: next part / sequel / the skipped episode; a missing season of a finished series offers a wish. */
const continuation: RowSource = async (s) => {
  const f = s.facts;
  const item = f.state === 'series_finished' ? f.sequel : f.state === 'next' || f.state === 'gap' ? f.next : null;
  const wish = f.state === 'series_finished' && !f.sequel ? await wishFor(s) : null;
  if (!item && !wish) return null;
  const name = f.collection && item && item.type !== 'Episode' ? f.collection.name : f.subject.name;
  return { kind: 'continuation', title: name, reason: { seed: { id: f.subject.id, name: f.subject.name }, traits: f.collection && item?.type !== 'Episode' ? [`collection:${f.collection.name}`] : [] }, items: item ? [spoilerSafe(item, s.v)!] : [], ...(wish ? { wish } : {}) };
};

/** A season of the finished series is missing from the library (request service says "partially available"): offer a wish. */
async function wishFor(s: SourceCtx): Promise<Wish | null> {
  if (s.v.kids || !requestsEnabled(s.ctx) || !s.ctx.jf.itemAbout || s.facts.subject.type !== 'Series') return null;
  try {
    const about = await s.ctx.jf.itemAbout(s.v.user, s.facts.subject.id);
    const tmdbId = Number(about.providerIds.tmdb);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    const d = await requestsClient(s.ctx).details('tv', tmdbId);
    if (portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status) !== 'teilweise') return null;
    const q = await quota(s.ctx, { id: s.v.userId, role: s.v.role });
    return { mediaType: 'tv', tmdbId, quota: { limit: q.limit, used: q.used, remaining: q.remaining, resetsAt: q.resetsAt } };
  } catch {
    return null;
  }
}

/**
 * 2b. Same universe: the other parts of the collection, else the first brand hub the title belongs to (studio / tag / collection
 * hubs), else its first tag. Only when there are at least 4 titles.
 */
const universe: RowSource = async (s) => {
  const f = s.facts;
  const col = f.collections.find((c) => c.parts.length > 1);
  if (col) {
    const items = col.parts.map((p) => p.item).filter((i) => i.id !== s.cur.id && i.id !== f.subject.id);
    if (items.length) return { kind: 'universe', title: col.name, reason: { seed: { id: f.subject.id, name: f.subject.name }, traits: [`collection:${col.name}`] }, items };
  }
  if (!s.ctx.jf.itemAbout) return null;
  const about = await soft(s.ctx.jf.itemAbout(s.v.user, f.subject.id), null);
  if (!about) return null;
  const hubs = (await s.ctx.db.query<{ name: string; source_kind: string; source_value: string }>(
    "select name, source_kind, source_value from brand_hubs where enabled and source_kind in ('studio','tag','collection') order by sort_order, created_at limit 40")).rows;
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const studios = lower(about.studios), tags = lower(about.tags), colIds = new Set(f.collections.map((c) => c.id));
  const hub = hubs.find((h) => (h.source_kind === 'studio' && studios.has(h.source_value.toLowerCase())) || (h.source_kind === 'tag' && tags.has(h.source_value.toLowerCase()))
    || (h.source_kind === 'collection' && colIds.has(h.source_value.replace(/-/g, '').toLowerCase())));
  const query = hub
    ? { types: MOVIES_AND_SERIES, limit: 40, sort: 'CommunityRating', desc: true, ...(hub.source_kind === 'studio' ? { studio: hub.source_value } : hub.source_kind === 'tag' ? { tag: hub.source_value } : { parentId: hub.source_value }) }
    : about.tags[0] ? { types: MOVIES_AND_SERIES, limit: 40, sort: 'CommunityRating', desc: true, tag: about.tags[0] } : null;
  if (!query) return null;
  const items = (await soft(s.ctx.jf.items(s.v.user, query), { items: [] as ItemDto[], total: 0 })).items;
  if (items.length < 4) return null;
  const traits = hub ? [`hub:${hub.name}`] : [`tag:${about.tags[0]}`];
  return { kind: 'universe', title: hub ? hub.name : about.tags[0]!, reason: { seed: { id: f.subject.id, name: f.subject.name }, traits }, items };
};

/** 3. Because you watched <X>: the existing similar() source, seeded with the title just finished (its series for an episode). */
const because: RowSource = async (s) => {
  const seed = s.facts.subject;
  if (s.profile) {
    try {
      const r = await recommend(s.ctx, s.v.user, s.profile, { seed: seed.id, surface: 'postplay', limit: ROW_MAX + 10, row: 'postplay' });
      const items = r.items.map(withReason).filter((i) => i.id !== seed.id);
      return items.length ? { kind: 'because', title: seed.name, reason: { seed: { id: seed.id, name: seed.name }, traits: [] }, items, engine: 'v2' } : null;
    } catch {
      countFallback('postplay'); // v1 below
    }
  }
  const items = (await cachedSimilar(s, seed.id)).filter((i) => i.id !== seed.id);
  if (!items.length) return null;
  return { kind: 'because', title: seed.name, reason: { seed: { id: seed.id, name: seed.name }, traits: seed.genres.slice(0, 2).map((g) => `genre:${g}`) }, items };
};

/** 4. Friends liked this: the existing friendsRatedFor (friends' shareRatings opt-in, >= 4 stars). Never on kids profiles. */
const friends: RowSource = async (s) => {
  if (s.v.kids) return null;
  const r = await soft(friendsRatedFor(s.ctx, s.v.user, s.v.userId, s.v.profileId), { items: [] as ItemDto[] });
  if (!r.items.length) return null;
  return { kind: 'friends', title: '', reason: { traits: ['friends:rated'] }, items: r.items.map(({ caption: _c, ...i }: ItemDto & { caption?: string }) => i) };
};

/** 5. Fits your taste: the profile-based rows of the existing engine (latest thumbs-up / last finished + recent distinct titles). */
const taste: RowSource = async (s) => {
  if (s.profile) {
    try {
      const r = await recommend(s.ctx, s.v.user, s.profile, { surface: 'taste', limit: ROW_MAX + 10, row: 'top_picks' });
      const items = r.items.map(withReason);
      items.forEach((i) => s.taste.add(i.id));
      return items.length ? { kind: 'taste', title: '', reason: { traits: [] }, items, engine: 'v2' } : null;
    } catch {
      countFallback('taste'); // v1 below
    }
  }
  const [main, more] = await Promise.all([
    soft(libraryBecause(s.ctx, s.v.user, s.v.profileId), { because: null, items: [] as ItemDto[] }),
    soft(libraryBecauseMore(s.ctx, s.v.user, s.v.profileId), { rows: [] as Array<{ because: { id: string; name: string }; items: ItemDto[] }> }),
  ]);
  // interleave the profile's rows so no single seed fills the row
  const lists = [main.items, ...more.rows.map((r) => r.items)].filter((l) => l.length);
  const items: ItemDto[] = [];
  for (let n = 0; lists.some((l) => n < l.length); n++) for (const l of lists) if (n < l.length) items.push(l[n]!);
  items.forEach((i) => s.taste.add(i.id));
  if (!items.length) return null;
  const seeds = [main.because, ...more.rows.map((r) => r.because)].filter((x): x is { id: string; name: string } => Boolean(x));
  return { kind: 'taste', title: '', reason: { ...(seeds[0] ? { seed: { id: seeds[0].id, name: seeds[0].name } } : {}), traits: seeds.slice(0, 3).map((x) => `seed:${x.name}`) }, items };
};

/**
 * 2a. What people watch after <X> (RECO_ENGINE=v2): the titles opted-in accounts started right after finishing this one (>= 2 accounts,
 * aggregates only, reco/aggregates.ts transitionsFor). Never on kids profiles (transitionsFor answers [] for them and the source is grown-ups only).
 */
const transition: RowSource = async (s) => {
  if (!s.profile) return null;
  try {
    const seed = { id: s.facts.subject.id, name: s.facts.subject.name };
    const reason = { seed, traits: ['next'] };
    const found = await transitionsFor(s.ctx, s.cur.id, { user: s.v.user, profile: s.profile }, { limit: 12 });
    return found.length ? { kind: 'transition', title: seed.name, reason: { seed }, items: found.map((t) => ({ ...t.item, reason })), engine: 'v2' } : null;
  } catch {
    countFallback('transition');
    return null;
  }
};

/**
 * Row sources in display order (spec §3.3). Extension point for R3: the "transition" source ("What people watch after <X>", only
 * from >= 2 opted-in accounts, never on kids profiles) goes between continuation and universe as `{ kind: 'transition', build, grownUp: true }`.
 * `suggestion: true` rows are left out when the profile turned post-play suggestions off.
 */
export const ROW_SOURCES: Array<{ kind: RowKind; build: RowSource; grownUp?: boolean; suggestion?: boolean }> = [
  { kind: 'continuation', build: continuation },
  { kind: 'transition', build: transition, grownUp: true, suggestion: true },
  { kind: 'universe', build: universe, suggestion: true },
  { kind: 'because', build: because, suggestion: true },
  { kind: 'friends', build: friends, grownUp: true, suggestion: true },
  { kind: 'taste', build: taste, suggestion: true },
];

/** ids the profile vetoed: dropped titles and thumbs-down */
async function vetoes(ctx: Ctx, profileId: string): Promise<Set<string>> {
  const r = await ctx.db.query<{ item_id: string }>(
    'select item_id from dropped where profile_id = $1 union select item_id from thumbs where profile_id = $1 and value = -1', [profileId]);
  return new Set(r.rows.map((x) => x.item_id));
}

export async function buildPostplay(ctx: Ctx, v: Viewer, cur: ItemDto, ver: string, now = Date.now()): Promise<Postplay> {
  const facts = await factsFor(ctx, v, cur, now);
  const s: SourceCtx = { ctx, v, cur, facts, ver, now, taste: new Set() };
  const profile = v2Active(ctx.cfg) ? await recoProfileOf(ctx, v.profileId) : undefined;
  if (profile) s.profile = profile;
  const sources = ROW_SOURCES.filter((r) => !(r.grownUp && v.kids) && !(r.suggestion && !v.suggestions));
  const [veto, built] = await Promise.all([vetoes(ctx, v.profileId), Promise.all(sources.map((r) => r.build(s).catch(() => null)))]);
  // never again: the title itself, its series, what follows it, anything watched, dropped or thumbed down; no row repeats a title
  const seen = new Set<string>([cur.id, facts.subject.id, ...(cur.seriesId ? [cur.seriesId] : [])]);
  const rows: PostplayRow[] = [];
  for (const r of built) {
    if (!r) continue;
    if (r.kind === 'continuation') {
      r.items.forEach((i) => seen.add(i.id));
      rows.push(r);
      continue;
    }
    const fresh = r.items.filter((i) => (i.type === 'Movie' || i.type === 'Series') && !seen.has(i.id) && !veto.has(i.id) && !alreadyWatched(i));
    const items = balanceSeason(fresh, now).slice(0, ROW_MAX);
    if (!items.length) continue;
    items.forEach((i) => seen.add(i.id));
    rows.push({ ...r, items });
  }
  // RECO_ENGINE=v2: the row ranker orders the suggestion rows by the profile's past click / play rate per row kind (continuation stays first)
  if (profile) {
    try {
      const head = rows.filter((r) => r.kind === 'continuation');
      const tail = rows.filter((r) => r.kind !== 'continuation');
      const ranked = await rankHomeRows(ctx, v.user, profile, tail.map((r) => ({ key: r.kind, kind: RECO_ROW_OF[r.kind], items: r.items })), now);
      const by = new Map(tail.map((r) => [r.kind as string, r]));
      rows.splice(0, rows.length, ...head, ...ranked.flatMap((r) => { const row = by.get(r.key); return row ? [{ ...row, items: r.items }] : []; }));
    } catch {
      countFallback('postplay'); // the display order of spec 3.3 stays
    }
  }
  const continuationItem = facts.state === 'series_finished' ? facts.sequel : facts.state === 'next' && facts.next?.type === 'Movie' ? facts.next : null;
  const recs = rows.find((r) => r.kind === 'because')?.items ?? rows.find((r) => r.kind === 'taste')?.items ?? [];
  const hero = continuationItem && !veto.has(continuationItem.id) ? continuationItem : v.suggestions ? pickHero(recs, s.taste, v.profileId) : null;
  const wish = rows.find((r) => r.wish)?.wish;
  return {
    state: facts.state,
    current: spoilerSafe(cur, v)!,
    next: spoilerSafe(facts.next, v),
    nextAirDate: facts.nextAirDate,
    sequel: facts.sequel,
    canWish: Boolean(wish),
    remind: facts.remind,
    rows: rows.map((r) => ({ ...r, engine: r.engine ?? 'v1', recoRow: RECO_ROW_OF[r.kind] })),
    hero,
    suggestions: v.suggestions,
    engine: rows.some((r) => r.engine === 'v2') ? 'v2' : 'v1',
  };
}

/**
 * Cached answer of GET /api/items/:id/postplay: 60 s per profile + item + user-data version + home generation (bumpHome drops it).
 * The visibility check comes first, on every request: a warm cache never answers for a title the profile can no longer see (an admin
 * narrowed its libraries or its age cap within the 60 s).
 */
export async function postplayFor(ctx: Ctx, v: Viewer, itemId: string): Promise<Postplay> {
  const [cur, ver, gens] = await Promise.all([
    ctx.jf.item(v.user, itemId), // 404/403: not visible to this profile
    ctx.jf.userDataVersion(v.user).catch(() => '0'),
    homeGens(ctx, v.profileId),
  ]);
  if (cur.type !== 'Movie' && cur.type !== 'Episode' && cur.type !== 'Series') throw new MediaError(404, 'not a playable title');
  const key = `postplay:${v.profileId}:${itemId}:${ver}:${gens}:${v.suggestions ? 1 : 0}${v.spoilerProtection ? 1 : 0}${v2Active(ctx.cfg) ? 'v2' : ''}`;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) { try { return JSON.parse(hit) as Postplay; } catch { /* recompute */ } }
  const out = await buildPostplay(ctx, v, cur, ver);
  await ctx.kv.set(key, JSON.stringify(out), POSTPLAY_TTL).catch(() => undefined);
  return out;
}

