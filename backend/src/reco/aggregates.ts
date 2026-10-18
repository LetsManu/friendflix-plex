// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import type { JfUser } from '../types.js';
import type { RecoProfile } from './profile.js';
import { resolveVisible } from './candidates.js';
import type { Index } from './vectors.js';
import { loadIndex } from './vectors.js';
import { recoCoefficients, recoWeights, type RecoCoefficients } from './weights.js';

/**
 * Recommendation engine v2, R3: what other accounts did, as aggregates (spec 4.4 items 4 and 5, 4.8).
 *
 *  - co-occurrence: "accounts that watched X also watched Y", scored as cos = n(X and Y) / sqrt(n(X) n(Y)) over distinct accounts;
 *  - transition: "accounts that finished X started Y next, within 7 days", scored as n(X -> Y) / (n(finished X) + 1).
 *
 * Only accounts with `shareHistory` on feed it (same opt-in as "Diese Woche bei uns"); a pair counts only when at least `minSupport`
 * (>= 2, a floor no setting can lower) distinct accounts share it, and a viewer is shown a pair only when that many OTHER accounts
 * share it (the viewer's own contribution is subtracted at read time, ownTables); the tables keep counts per title pair and nothing else: no account,
 * no day, no time. They are rebuilt from play_seconds every 15 minutes, so an account that switches the opt-in off is gone at the next
 * rebuild. play_seconds is per account (not per profile) and has no "finished" flag, so "finished" is an approximation (docs/discovery.md).
 * Kids profiles never receive anything from here (the sources are social; transitionsFor refuses them as well).
 */

/** One account's viewing of one title (episodes rolled up into their series): first and last day (ms, UTC midnight) and seconds watched. */
export interface TitleSpan { acct: string; root: string; first: number; last: number; secs: number }

export interface PairTables {
  v: 1;
  builtAt: number;
  /** distinct opted-in accounts that watched at least `minSeconds` of a title / that finished it (the approximation above) */
  n: Record<string, number>;
  done: Record<string, number>;
  /** partner -> distinct accounts, strongest first, only pairs with support >= minSupport */
  cooc: Record<string, Array<[string, number]>>;
  trans: Record<string, Array<[string, number]>>;
}

export interface TableFacts {
  /** runtime of a film / of one episode of a series in seconds, null when unknown */
  runtimeSec(id: string): number | null;
  isSeries(id: string): boolean;
}

const DAY_MS = 86_400_000;
/** an account's most recent titles considered for pairs (pairs grow with the square of this) */
const MAX_TITLES_PER_ACCOUNT = 300;

/** Did the account finish the title? A film: viewing time >= finishRatio of its runtime. A series: >= finishEpisodes episodes' worth. */
export function finished(span: TitleSpan, f: TableFacts, c: RecoCoefficients): boolean {
  const rt = f.runtimeSec(span.root);
  if (!rt || rt <= 0) return span.secs >= (f.isSeries(span.root) ? c.social.finishEpisodes * 1500 : 3600); // unknown runtime: 25 min per episode, 1 hour per film
  return f.isSeries(span.root) ? span.secs >= c.social.finishEpisodes * rt : span.secs >= c.social.finishRatio * rt;
}

const top = (m: Map<string, Map<string, number>>, minSupport: number, keep: number): Record<string, Array<[string, number]>> => {
  const out: Record<string, Array<[string, number]>> = {};
  for (const [a, row] of m) {
    const list = [...row].filter(([, n]) => n >= minSupport).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, keep);
    if (list.length) out[a] = list;
  }
  return out;
};

const bump = (m: Map<string, Map<string, number>>, a: string, b: string) => {
  let r = m.get(a);
  if (!r) m.set(a, (r = new Map()));
  r.set(b, (r.get(b) ?? 0) + 1);
};

/** Pure: spans of opted-in accounts -> aggregate tables. Order of the input does not matter. */
export function buildPairTables(spans: readonly TitleSpan[], c: RecoCoefficients, f: TableFacts, now = Date.now()): PairTables {
  // one span per account and title (callers merge already; a repeated pair is merged here as well)
  const merged = new Map<string, TitleSpan>();
  for (const s of spans) {
    const k = `${s.acct}|${s.root}`, m = merged.get(k);
    if (m) { m.first = Math.min(m.first, s.first); m.last = Math.max(m.last, s.last); m.secs += s.secs; }
    else merged.set(k, { ...s });
  }
  const byAcct = new Map<string, TitleSpan[]>();
  for (const s of merged.values()) {
    if (s.secs < c.social.minSeconds) continue;
    let l = byAcct.get(s.acct);
    if (!l) byAcct.set(s.acct, (l = []));
    l.push(s);
  }
  const n: Record<string, number> = {}, done: Record<string, number> = {};
  const cooc = new Map<string, Map<string, number>>(), trans = new Map<string, Map<string, number>>();
  const window = c.social.transitionDays * DAY_MS;
  for (const list of byAcct.values()) {
    list.sort((a, b) => a.first - b.first || (a.root < b.root ? -1 : 1));
    const recent = list.length > MAX_TITLES_PER_ACCOUNT ? list.slice(-MAX_TITLES_PER_ACCOUNT) : list;
    const roots = [...new Set(recent.map((s) => s.root))];
    for (const r of roots) n[r] = (n[r] ?? 0) + 1;
    for (const a of roots) for (const b of roots) if (a !== b) bump(cooc, a, b);
    const counted = new Set<string>();
    for (let i = 0; i < recent.length; i++) {
      const x = recent[i]!;
      if (!finished(x, f, c)) continue;
      if (!counted.has(x.root)) { counted.add(x.root); done[x.root] = (done[x.root] ?? 0) + 1; }
      // the next title this account started after it stopped watching x, within the window
      const y = recent.find((s) => s.root !== x.root && s.first >= x.last && s.first - x.last <= window);
      if (y) bump(trans, x.root, y.root);
    }
  }
  return { v: 1, builtAt: now, n, done, cooc: top(cooc, c.social.minSupport, c.social.topPerItem), trans: top(trans, c.social.minSupport, c.social.topPerItem) };
}

/**
 * What the viewer's own account contributed to the tables (M4): built from that account's spans alone with buildPairTables, so every
 * count in it is 0 or 1. Subtracted at read time, so a pair the viewer is shown always rests on at least `minSupport` OTHER accounts:
 * a viewer who is one of only two accounts behind a pair can no longer read the other person's next title from it.
 */
export type OwnTables = PairTables;
export interface SignalOptions { own?: OwnTables | null; minSupport?: number }

const ownHas = (list: Array<[string, number]> | undefined, other: string): number => (list?.some(([o]) => o === other) ? 1 : 0);

/** Co-occurrence of `id` with every partner: cosine over the other accounts, 0..1. */
export function coocSignals(t: PairTables, id: string, o: SignalOptions = {}): Map<string, number> {
  const own = o.own ?? null, min = Math.max(2, o.minSupport ?? 2);
  const out = new Map<string, number>();
  const nId = (t.n[id] ?? 1) - (own?.n[id] ?? 0);
  for (const [other, total] of t.cooc[id] ?? []) {
    const count = total - ownHas(own?.cooc[id], other);
    if (count < min) continue;
    const d = Math.sqrt(Math.max(1, nId) * Math.max(1, (t.n[other] ?? 1) - (own?.n[other] ?? 0)));
    out.set(other, Math.min(1, count / d));
  }
  return out;
}

/** Transitions out of `id`: share of the other accounts that finished it who started the partner next (smoothed), plus the support. */
export function transitionSignals(t: PairTables, id: string, o: SignalOptions = {}): Map<string, { p: number; support: number }> {
  const own = o.own ?? null, min = Math.max(2, o.minSupport ?? 2);
  const out = new Map<string, { p: number; support: number }>();
  const d = Math.max(0, (t.done[id] ?? 0) - (own?.done[id] ?? 0)) + 1;
  for (const [other, total] of t.trans[id] ?? []) {
    const count = total - ownHas(own?.trans[id], other);
    if (count < min) continue;
    out.set(other, { p: Math.min(1, count / d), support: count });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------ loading

const ROOT_TTL = 30 * 86_400;
const NO_ROOT_TTL = 3600;
const ROOT_LOOKUPS = 300;

/**
 * Series (or film) behind play_seconds item ids, from library-level data only (never a viewer's token, so the tables do not depend on
 * whoever triggered the build): a kv cache, the hygiene scan's episode rows, and the media server's admin-side libraryRoots() hook.
 * Only that library-wide lookup may record "not in the library" (a short negative entry); without the hook unknown ids are simply skipped.
 */
async function resolveRoots(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const cached = await ctx.kv.mget(ids.map((i) => `reco:root:${i}`)).catch(() => ids.map(() => null));
  let todo: string[] = [];
  ids.forEach((id, n) => {
    const hit = cached[n];
    if (hit) out.set(id, hit);
    else if (hit === null || hit === undefined) todo.push(id);
  });
  const learned = new Map<string, string>();
  if (todo.length) {
    const rows = (await ctx.db.query<{ item_id: string; series_id: string }>('select item_id, series_id from hygiene_items where item_id = any($1) and series_id is not null', [todo]).catch(() => ({ rows: [] }))).rows;
    for (const r of rows) learned.set(r.item_id, r.series_id);
    todo = todo.filter((i) => !learned.has(i));
  }
  const ask = typeof ctx.jf.libraryRoots === 'function' ? todo.slice(0, ROOT_LOOKUPS) : [];
  const answered: string[] = [];
  for (let i = 0; i < ask.length; i += 40) {
    const batch = ask.slice(i, i + 40);
    const r = await ctx.jf.libraryRoots!(batch).then((m) => { answered.push(...batch); return m; }, () => new Map<string, string>());
    for (const [id, root] of r) if (batch.includes(id) && root) learned.set(id, root);
  }
  await Promise.all([...learned].map(([id, root]) => ctx.kv.set(`reco:root:${id}`, root, ROOT_TTL).catch(() => undefined)));
  await Promise.all(answered.filter((i) => !learned.has(i)).map((id) => ctx.kv.set(`reco:root:${id}`, '', NO_ROOT_TTL).catch(() => undefined)));
  for (const [id, root] of learned) out.set(id, root);
  return out;
}

export const tablesKey = (c: RecoCoefficients): string => `reco:pairs:${[c.social.minSupport, c.social.lookbackDays, c.social.transitionDays, c.social.minSeconds, c.social.finishRatio, c.social.finishEpisodes, c.social.topPerItem].join(':')}`;
export const lockKey = (c: RecoCoefficients): string => tablesKey(c).replace('reco:pairs:', 'reco:pairlock:');
/** a stale table is kept this many times the rebuild interval and served while one builder replaces it (stale-while-revalidate) */
const STALE_FACTOR = 4;
const LOCK_TTL_S = 120;

type SpanRow = { acct: string; item_id: string; first_day: string; last_day: string; secs: number };

/** play_seconds of the opted-in accounts (or of one of them) rolled up into film / series spans of the library index. */
async function spansOf(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, index: Index, c: RecoCoefficients, acct?: string): Promise<TitleSpan[]> {
  const rows = (await ctx.db.query<SpanRow>(
    `select p.user_id::text as acct, p.item_id, min(p.day)::text as first_day, max(p.day)::text as last_day, sum(p.seconds)::int as secs
       from play_seconds p join users u on u.id = p.user_id left join user_prefs pr on pr.user_id = p.user_id
      where p.day >= current_date - $1::int and not u.disabled and coalesce((pr.data->>'shareHistory')::boolean, false)
        and ($3::uuid is null or p.user_id = $3::uuid)
      group by p.user_id, p.item_id order by max(p.day) desc limit $2`, [c.social.lookbackDays, c.social.maxRows, acct ?? null])).rows;
  const unknown = [...new Set(rows.filter((r) => !index.rows.has(r.item_id)).map((r) => r.item_id))];
  const roots = await resolveRoots(ctx, unknown);
  const merged = new Map<string, TitleSpan>();
  for (const r of rows) {
    const root = index.rows.has(r.item_id) ? r.item_id : roots.get(r.item_id);
    if (!root || !index.rows.has(root)) continue; // not a film or series of the library index
    const first = Date.parse(`${r.first_day}T00:00:00Z`), last = Date.parse(`${r.last_day}T00:00:00Z`);
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    const k = `${r.acct}|${root}`;
    const s = merged.get(k);
    if (s) { s.first = Math.min(s.first, first); s.last = Math.max(s.last, last); s.secs += Number(r.secs); }
    else merged.set(k, { acct: r.acct, root, first, last, secs: Number(r.secs) });
  }
  return [...merged.values()];
}

const factsOf = (index: Index): TableFacts => ({
  runtimeSec: (id) => { const m = index.rows.get(id)?.runtime_min; return m ? m * 60 : null; },
  isSeries: (id) => index.rows.get(id)?.type === 'Series',
});

let builds = 0;
/** How many times this process built the aggregate tables (tests: concurrent callers share one build). */
export const pairTableBuilds = (): number => builds;
/** in-flight builds per kv store and table key: one builder per process */
const inflight = new WeakMap<object, Map<string, Promise<PairTables | null>>>();

const emptyTables = (now: number): PairTables => ({ v: 1, builtAt: now, n: {}, done: {}, cooc: {}, trans: {} });
const parse = (raw: string | null): PairTables | null => {
  if (!raw) return null;
  try { const t = JSON.parse(raw) as PairTables; return t.v === 1 ? t : null; } catch { return null; }
};

/**
 * One rebuild: a single builder per process (the in-flight promise is shared) and across replicas (a kv setnx lock). A caller that
 * finds the lock taken gets null and keeps what it has. The tables are library-level: no viewer's token is involved.
 */
function rebuild(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, index: Index, c: RecoCoefficients): Promise<PairTables | null> {
  const key = tablesKey(c);
  let mine = inflight.get(ctx.kv);
  if (!mine) inflight.set(ctx.kv, (mine = new Map()));
  const running = mine.get(key);
  if (running) return running;
  const p = (async () => {
    const token = randomUUID();
    if (!(await ctx.kv.setnx(lockKey(c), token, LOCK_TTL_S).catch(() => false))) return null; // another replica builds
    try {
      builds++;
      const t = buildPairTables(await spansOf(ctx, index, c), c, factsOf(index), Date.now());
      await ctx.kv.set(key, JSON.stringify(t), c.social.cacheSeconds * STALE_FACTOR).catch(() => undefined);
      return t;
    } finally {
      await ctx.kv.delIfEquals(lockKey(c), token).catch(() => undefined);
    }
  })().finally(() => { if (mine!.get(key) === p) mine!.delete(key); });
  mine.set(key, p);
  return p;
}

/**
 * The aggregate tables. Fresh (younger than social.cacheSeconds, wall clock): from kv. Stale: the stale copy is answered at once and one
 * builder replaces it in the background. None at all: the request waits for the single build (or, when another replica holds the
 * lock, gets empty tables for now). Never rebuilt by several requests in parallel.
 */
export async function loadPairTables(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, index: Index, c: RecoCoefficients): Promise<PairTables> {
  const stored = parse(await ctx.kv.get(tablesKey(c)).catch(() => null));
  if (stored && Date.now() - stored.builtAt < c.social.cacheSeconds * 1000) return stored;
  if (stored) {
    void rebuild(ctx, index, c).catch(() => undefined);
    return stored;
  }
  return (await rebuild(ctx, index, c)) ?? emptyTables(Date.now());
}

const OWN_TTL_MS = 60_000;
/** per loaded index (a reload starts afresh), per account and table build */
const ownCache = new WeakMap<Index, Map<string, { at: number; promise: Promise<OwnTables> }>>();

/**
 * The viewer's own contribution to `tables` (see OwnTables), from the account's own play_seconds with the same opt-in rule (an account
 * that does not share its history contributed nothing). Shared by concurrent callers, kept for a minute in this process only.
 */
export function ownTables(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, index: Index, c: RecoCoefficients, tables: PairTables, acct: string): Promise<OwnTables> {
  let m = ownCache.get(index);
  if (!m) ownCache.set(index, (m = new Map()));
  const key = `${acct}|${tablesKey(c)}|${tables.builtAt}`;
  const now = Date.now();
  const hit = m.get(key);
  if (hit && now - hit.at < OWN_TTL_MS) return hit.promise;
  if (m.size > 500) m.clear();
  const one = { ...c, social: { ...c.social, minSupport: 1, topPerItem: Number.MAX_SAFE_INTEGER } } as RecoCoefficients;
  const promise = spansOf(ctx, index, c, acct).then((spans) => buildPairTables(spans, one, factsOf(index), now));
  promise.catch(() => m!.delete(key));
  m.set(key, { at: now, promise });
  return promise;
}

/** The tables as one viewer may use them: the aggregate plus that account's own contribution, which the signals subtract. */
export async function tablesOfViewer(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, index: Index, c: RecoCoefficients, acct: string): Promise<{ tables: PairTables; own: OwnTables }> {
  const tables = await loadPairTables(ctx, index, c);
  return { tables, own: await ownTables(ctx, index, c, tables, acct) };
}

// ------------------------------------------------------------------------------------------------------------------ public helper

export interface Transition { item: ItemDto; /** distinct accounts that went from the given title to this one */ support: number; /** smoothed share of the accounts that finished it */ share: number }

/**
 * "What people watch after X" for the post-play screen (A1/A2, wired in R4): the titles opted-in accounts started right after finishing
 * `itemId` (an episode is rolled up to its series), strongest first, at least `minSupport` accounts each, resolved with the viewer's own
 * token, without what the profile thumbed down or has played. Aggregates only; a kids profile always gets an empty list.
 */
export async function transitionsFor(
  ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, itemId: string, viewer: { user: JfUser; profile: RecoProfile }, o: { limit?: number; now?: number } = {},
): Promise<Transition[]> {
  if (viewer.profile.kids) return [];
  const now = o.now ?? Date.now();
  const c = recoCoefficients(ctx.cfg);
  const item = await ctx.jf.item(viewer.user, itemId).catch(() => null);
  if (!item) return []; // invisible to the viewer: nothing is revealed
  const root = item.type === 'Episode' && item.seriesId ? item.seriesId : item.id;
  const index = await loadIndex(ctx, recoWeights(ctx.cfg), now);
  const { tables, own } = await tablesOfViewer(ctx, index, c, viewer.profile.user_id);
  const sig = transitionSignals(tables, root, { own, minSupport: c.social.minSupport });
  if (!sig.size) return [];
  const ranked = [...sig].sort((a, b) => b[1].support - a[1].support || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  const [found, down] = await Promise.all([
    resolveVisible(ctx, viewer.user, ranked),
    ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=-1', [viewer.profile.id]).then((r) => new Set(r.rows.map((x) => x.item_id))),
  ]);
  const out: Transition[] = [];
  for (const id of ranked) {
    const it = found.get(id);
    if (!it || it.played || down.has(id) || id === root) continue;
    out.push({ item: it, support: sig.get(id)!.support, share: Math.round(sig.get(id)!.p * 1000) / 1000 });
  }
  return out.slice(0, o.limit ?? 12);
}
