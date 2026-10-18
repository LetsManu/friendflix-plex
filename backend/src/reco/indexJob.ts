// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { bus } from '../bus.js';
import type { Ctx } from '../ctx.js';
import { recordError } from '../errorlog.js';
import { recoIndexRuns } from '../metrics.js';
import type { ItemFeatures, MediaEvent } from '../media/types.js';
import { documentFrequencies, normList, termCounts, tokenize, topTerms } from './tfidf.js';

/**
 * Recommendation engine v2, R1: the item feature index (item_features, item_feature_idf, item_feature_stats). Background only
 * (server.ts, BACKGROUND_JOBS), never inside a request; no recommendation reads it yet. Scheduling, locking and backoff follow the
 * library hygiene scan (hygiene/scan.ts):
 *  - a full pass on the first run and then nightly (3:00 local, or once the last one is 36 h old): pages of 200 sorted SortName,Id,
 *    each upserted at once, a short pause in between; TF-IDF terms are computed after the last page (document frequency needs the
 *    whole corpus). Only a complete full pass deletes rows of vanished items.
 *  - an incremental pass 30 s after library additions (media.event itemAdded; an episode refreshes its series) for just those ids.
 *    New items work at once because the index needs no interactions; their terms use the stored document frequencies.
 *  - the running flag in kv is the lock across replicas (setnx, short TTL refreshed while paging); a failed run backs off
 *    5 min, doubling up to 6 h; the failure is recorded by job name only (a message may carry a server URL). Never throws.
 */
const PAGE = 200;
const PAUSE_MS = 200;
/** safety cap (200 000 films and series) */
const MAX_PAGES = 1000;
const NIGHT_HOUR = 3;
const FULL_EVERY_MS = 24 * 3600_000;
const FULL_OVERDUE_MS = 36 * 3600_000;
const SETTLE_MS = 30_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const PENDING_MAX = 2000;
const KEEP_S = 90 * 86400;
const RUNNING_TTL_S = 300;
const HEARTBEAT_MS = 60_000;
/** per-item text kept for the full pass (overview + tagline) */
const TEXT_MAX = 2000;
const ID_RE = /^[0-9a-f]{32}$/;
/** person ids: whatever the server uses (Jellyfin: 32 hex), but a plain token */
const PERSON_RE = /^[\w-]{1,64}$/;
const K = { lastFull: 'reco:idx:lastFull', lastDone: 'reco:idx:lastDone', running: 'reco:idx:running', fails: 'reco:idx:fails', nextTry: 'reco:idx:nextTry' } as const;

let current: Promise<void> | null = null;
let stopping = false;
/** library ids announced since the last incremental pass: id -> first announcement (ms) */
const pending = new Map<string, number>();

/** Stops a running pass after its current page (shutdown). */
export function stopRecoIndex(): void {
  stopping = true;
}
/** Resolves when no pass runs in this process (tests). */
export function recoIndexIdle(): Promise<void> {
  return current ?? Promise.resolve();
}
/** Ids waiting for the next incremental pass (tests). */
export function recoIndexPending(): string[] {
  return [...pending.keys()];
}
/** Forgets announced ids (tests). */
export function resetRecoIndex(): void {
  pending.clear();
  stopping = false;
}

const kvGet = (ctx: Pick<Ctx, 'kv'>, k: string) => ctx.kv.get(k).catch(() => null);
const kvSet = (ctx: Pick<Ctx, 'kv'>, k: string, v: string, ttl = KEEP_S) => ctx.kv.set(k, v, ttl).catch(() => undefined);

type FeaturesFn = NonNullable<Ctx['jf']['libraryFeatures']>;
const featuresFn = (ctx: Pick<Ctx, 'jf'>): FeaturesFn | null =>
  ctx.jf.capabilities.libraryFeatures === true && typeof ctx.jf.libraryFeatures === 'function' ? ctx.jf.libraryFeatures.bind(ctx.jf) : null;

/** What the index stores for one item (values normalised and capped). Terms are added separately. */
interface Row {
  item_id: string; type: string; genres: string[]; tags: string[]; studios: string[]; people: string[]; year: number | null; runtime_min: number | null;
  community_rating: number | null; critic_rating: number | null; original_language: string | null; countries: string[]; collection_id: string | null;
  series_status: string | null;
}
const text = (f: ItemFeatures) => `${f.overview ?? ''}\n${f.tagline ?? ''}`.trim().slice(0, TEXT_MAX);
const int = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const rating = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

export function rowOf(f: ItemFeatures): Row {
  return {
    item_id: f.id, type: f.type, genres: normList(f.genres, 10), tags: normList(f.tags, 20), studios: normList(f.studios, 6),
    people: [...new Set(f.people.filter((p) => PERSON_RE.test(p)))].slice(0, 8), year: int(f.year), runtime_min: int(f.runtimeMin),
    community_rating: rating(f.communityRating), critic_rating: rating(f.criticRating),
    original_language: f.originalLanguage?.trim().toLowerCase().slice(0, 8) || null, countries: normList(f.countries, 6),
    collection_id: f.collectionId && ID_RE.test(f.collectionId) ? f.collectionId : null,
    series_status: f.seriesStatus ?? null,
  };
}

async function upsertRows(ctx: Pick<Ctx, 'db'>, items: ItemFeatures[], runStart: Date): Promise<ItemFeatures[]> {
  const byId = new Map<string, ItemFeatures>();
  for (const f of items) if (f && typeof f.id === 'string' && ID_RE.test(f.id) && (f.type === 'Movie' || f.type === 'Series')) byId.set(f.id, f);
  if (!byId.size) return [];
  await ctx.db.query(
    `insert into item_features(item_id, type, genres, tags, studios, people, year, runtime_min, community_rating, critic_rating, original_language,
                               countries, collection_id, series_status, updated_at)
     select x.item_id, x.type, x.genres, x.tags, x.studios, x.people, x.year, x.runtime_min, x.community_rating, x.critic_rating, x.original_language,
            x.countries, x.collection_id, x.series_status, $2
       from jsonb_to_recordset($1::jsonb) as x(item_id text, type text, genres text[], tags text[], studios text[], people text[], year int, runtime_min int,
            community_rating real, critic_rating real, original_language text, countries text[], collection_id text, series_status text)
     on conflict (item_id) do update set type = excluded.type, genres = excluded.genres, tags = excluded.tags, studios = excluded.studios,
       people = excluded.people, year = excluded.year, runtime_min = excluded.runtime_min, community_rating = excluded.community_rating,
       critic_rating = excluded.critic_rating, original_language = excluded.original_language, countries = excluded.countries,
       collection_id = excluded.collection_id, series_status = excluded.series_status, updated_at = excluded.updated_at`,
    [JSON.stringify([...byId.values()].map(rowOf)), runStart],
  );
  return [...byId.values()];
}

async function writeTerms(ctx: Pick<Ctx, 'db'>, terms: Array<[string, Record<string, number>]>): Promise<void> {
  for (let i = 0; i < terms.length; i += 500) {
    const b = terms.slice(i, i + 500);
    await ctx.db.query(
      `update item_features f set overview_terms = x.t from jsonb_to_recordset($1::jsonb) as x(item_id text, t jsonb) where f.item_id = x.item_id`,
      [JSON.stringify(b.map(([item_id, t]) => ({ item_id, t })))],
    );
  }
}

/** IDF of genres, tags, studios and people from the whole index (one statement), and the numeric statistics. Rows no longer used are removed. */
async function refreshIdf(ctx: Pick<Ctx, 'db'>, now: Date): Promise<void> {
  await ctx.db.query(
    `with n as (select count(*)::int n from item_features),
     d as (
       select 'genre' kind, v value, count(*)::int df from item_features, unnest(genres) v group by v
       union all select 'tag', v, count(*)::int from item_features, unnest(tags) v group by v
       union all select 'studio', v, count(*)::int from item_features, unnest(studios) v group by v
       union all select 'person', v, count(*)::int from item_features, unnest(people) v group by v)
     insert into item_feature_idf(kind, value, df, idf, seen_at)
       select d.kind, d.value, d.df, (ln((n.n + 1.0) / (d.df + 1.0)) + 1)::real, $1 from d, n
     on conflict (kind, value) do update set df = excluded.df, idf = excluded.idf, seen_at = excluded.seen_at`,
    [now],
  );
  await ctx.db.query("delete from item_feature_idf where kind <> 'term' and seen_at < $1", [now]);
  await ctx.db.query(
    `insert into item_feature_stats(name, mean, std, n)
       select 'year', coalesce(avg(year), 0), coalesce(stddev_samp(year), 0), count(year)::int from item_features
       union all select 'runtime_min', coalesce(avg(runtime_min), 0), coalesce(stddev_samp(runtime_min), 0), count(runtime_min)::int from item_features
       union all select 'community_rating', coalesce(avg(community_rating), 0), coalesce(stddev_samp(community_rating), 0), count(community_rating)::int from item_features
       union all select 'critic_rating', coalesce(avg(critic_rating), 0), coalesce(stddev_samp(critic_rating), 0), count(critic_rating)::int from item_features
     on conflict (name) do update set mean = excluded.mean, std = excluded.std, n = excluded.n`,
  );
}

async function replaceTermDf(ctx: Pick<Ctx, 'db'>, n: number, df: Map<string, number>, runStart: Date): Promise<void> {
  const all = [...df.entries()];
  for (let i = 0; i < all.length; i += 2000) {
    const b = all.slice(i, i + 2000);
    await ctx.db.query(
      `insert into item_feature_idf(kind, value, df, idf, seen_at)
         select 'term', t, d, (ln(($4::int + 1.0) / (d + 1.0)) + 1)::real, $3 from unnest($1::text[], $2::int[]) as x(t, d)
       on conflict (kind, value) do update set df = excluded.df, idf = excluded.idf, seen_at = excluded.seen_at`,
      [b.map((x) => x[0]), b.map((x) => x[1]), runStart, n],
    );
  }
  await ctx.db.query("delete from item_feature_idf where kind = 'term' and seen_at < $1", [runStart]);
}

async function fullPass(ctx: Ctx, fn: FeaturesFn, runStart: Date, pause: number, beat: () => Promise<void>): Promise<boolean> {
  const docs = new Map<string, Map<string, number>>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (stopping) return false; // incomplete: nothing deleted, the next start retries
    const items = await fn(page * PAGE, PAGE);
    for (const f of await upsertRows(ctx, items, runStart)) docs.set(f.id, termCounts(tokenize(text(f))));
    await beat();
    if (items.length < PAGE) break;
    if (pause > 0) await sleep(pause);
    else await new Promise((r) => setImmediate(r)); // still yield between pages
  }
  const n = docs.size;
  const df = documentFrequencies(docs.values());
  const terms: Array<[string, Record<string, number>]> = [];
  for (const [id, counts] of docs) terms.push([id, topTerms(counts, n, (t) => df.get(t) ?? 0)]);
  await writeTerms(ctx, terms);
  await beat();
  await replaceTermDf(ctx, n, df, runStart);
  await beat();
  // offset pages can skip an item when the library changes during the pass (an addition sorting before the cursor shifts the later
  // pages): before anything is deleted, the rows the pass did not see are asked for by id, and those that still exist are kept
  if (!(await recheckUnseen(ctx, fn, runStart, beat))) return false;
  // a complete pass: rows of vanished items go, then the IDF counts what is left
  await ctx.db.query('delete from item_features where updated_at < $1', [runStart]);
  await refreshIdf(ctx, runStart);
  return true;
}

/** Rows a full pass did not touch: refetched by id; what the library still has is upserted (and so survives the delete). */
async function recheckUnseen(ctx: Ctx, fn: FeaturesFn, runStart: Date, beat: () => Promise<void>): Promise<boolean> {
  const unseen = (await ctx.db.query<{ item_id: string }>('select item_id from item_features where updated_at < $1', [runStart])).rows.map((r) => r.item_id);
  for (let i = 0; i < unseen.length; i += PAGE) {
    if (stopping) return false; // incomplete: nothing deleted
    const batch = unseen.slice(i, i + PAGE);
    const found = await upsertRows(ctx, await fn(0, batch.length, { ids: batch }), runStart);
    if (found.length) await refreshTermsOf(ctx, found);
    await beat();
  }
  return true;
}

/** Overview terms of a few items against the stored document frequencies (the item counted once when it is new). */
async function refreshTermsOf(ctx: Pick<Ctx, 'db'>, items: ItemFeatures[], known: ReadonlySet<string> = new Set(items.map((f) => f.id))): Promise<void> {
  const n = Number((await ctx.db.query<{ n: string }>('select count(*) n from item_features')).rows[0]?.n ?? 0);
  const docs = items.map((f) => [f, termCounts(tokenize(text(f)))] as const);
  const wanted = [...new Set(docs.flatMap(([, c]) => [...c.keys()]))];
  const stored = new Map((await ctx.db.query<{ value: string; df: number }>("select value, df from item_feature_idf where kind = 'term' and value = any($1::text[])", [wanted])).rows.map((r) => [r.value, r.df]));
  await writeTerms(ctx, docs.map(([f, counts]) => [f.id, topTerms(counts, n, (t) => (stored.get(t) ?? 0) + (known.has(f.id) ? 0 : 1))]));
}

/** Terms for items fetched incrementally: stored document frequencies, this item counted once when it is new. */
async function incrementalPass(ctx: Ctx, fn: FeaturesFn, ids: string[], runStart: Date): Promise<void> {
  for (let i = 0; i < ids.length; i += PAGE) {
    const batch = ids.slice(i, i + PAGE);
    const known = new Set((await ctx.db.query<{ item_id: string }>('select item_id from item_features where item_id = any($1::text[])', [batch])).rows.map((r) => r.item_id));
    const items = await upsertRows(ctx, await fn(0, batch.length, { ids: batch }), runStart);
    if (items.length) await refreshTermsOf(ctx, items, known);
  }
  await refreshIdf(ctx, runStart);
}

async function run(ctx: Ctx, fn: FeaturesFn, opts: { full: boolean; ids: string[]; now?: Date; pauseMs?: number }): Promise<void> {
  const runStart = opts.now ?? new Date();
  const mode = opts.full ? 'full' : 'incremental';
  const token = randomUUID();
  // the running flag is also the lock across replicas; a killed process blocks the next pass for minutes, not longer
  if (!(await ctx.kv.setnx(K.running, token, RUNNING_TTL_S).catch(() => true))) return;
  let last = Date.now();
  // only while the lock is still ours: a pass that stalled past the TTL must not take back a lock another replica holds by now
  const beat = async () => {
    if (Date.now() - last >= HEARTBEAT_MS) {
      last = Date.now();
      await ctx.kv.refreshIfEquals(K.running, token, RUNNING_TTL_S).catch(() => false);
    }
  };
  try {
    if (opts.full) {
      if (!(await fullPass(ctx, fn, runStart, opts.pauseMs ?? PAUSE_MS, beat))) return;
      await kvSet(ctx, K.lastFull, runStart.toISOString());
    } else {
      await incrementalPass(ctx, fn, opts.ids, runStart);
    }
    await kvSet(ctx, K.lastDone, new Date().toISOString());
    await ctx.kv.del(K.fails).catch(() => undefined);
    await ctx.kv.del(K.nextTry).catch(() => undefined);
    recoIndexRuns.inc({ mode, result: 'ok' });
  } catch {
    // the message may carry a server URL: log and record only the job name
    console.warn('recommendation index pass failed');
    void recordError(ctx, { source: 'job', code: 'reco-index' });
    recoIndexRuns.inc({ mode, result: 'error' });
    if (!opts.full) for (const id of opts.ids) pending.set(id, Date.now()); // retried after the backoff (or covered by the nightly pass)
    const fails = (Number(await kvGet(ctx, K.fails)) || 0) + 1;
    await kvSet(ctx, K.fails, String(fails), 86400);
    await kvSet(ctx, K.nextTry, String(Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_MAX_MS)), 86400);
  } finally {
    // only our own flag (another replica may have taken over after our TTL ran out)
    if ((await kvGet(ctx, K.running)) === token) await ctx.kv.del(K.running).catch(() => undefined);
  }
}

/** One pass: full, or incremental for the announced ids (all that are pending). One per process; without `libraryFeatures` it returns at once. Never throws. */
export function recoIndexTick(ctx: Ctx, opts: { full?: boolean; now?: Date; pauseMs?: number } = {}): Promise<void> {
  const fn = featuresFn(ctx);
  if (!fn || current) return current ?? Promise.resolve();
  stopping = false;
  const full = Boolean(opts.full);
  const ids = full ? [] : [...pending.keys()].slice(0, PENDING_MAX);
  if (!full && !ids.length) return Promise.resolve();
  for (const id of ids) pending.delete(id);
  if (full) pending.clear(); // the full pass covers everything announced so far
  const p = run(ctx, fn, { full, ids, now: opts.now, pauseMs: opts.pauseMs }).finally(() => { if (current === p) current = null; });
  current = p;
  return p;
}

/**
 * Called every minute by server.ts: a full pass when none ever finished, at NIGHT_HOUR once the last one is a day old, or when it is
 * 36 h old; otherwise an incremental pass once announced additions have settled for 30 s. Skips while backing off or while another
 * replica runs. Returns whether a pass ran. Never throws.
 */
export async function recoIndexDue(ctx: Ctx, opts: { now?: number; pauseMs?: number } = {}): Promise<boolean> {
  try {
    if (current || !featuresFn(ctx)) return false;
    const now = opts.now ?? Date.now();
    if (now < (Number(await kvGet(ctx, K.nextTry)) || 0)) return false;
    if (await ctx.kv.get(K.running).catch(() => null)) return false; // another replica runs
    const lastFull = Date.parse((await kvGet(ctx, K.lastFull)) ?? '');
    const age = now - lastFull;
    const full = !Number.isFinite(lastFull) || age >= FULL_OVERDUE_MS || (age >= FULL_EVERY_MS && new Date(now).getHours() === NIGHT_HOUR);
    if (!full) {
      const oldest = Math.min(...pending.values());
      if (!pending.size || now - oldest < SETTLE_MS) return false;
    }
    await recoIndexTick(ctx, { full, now: new Date(now), pauseMs: opts.pauseMs });
    return true;
  } catch {
    return false;
  }
}

/** A library addition: the film or series (an episode: its series) is refreshed by the next incremental pass. */
export function recoIndexAnnounce(itemId: string, itemType: string, seriesId?: string, now = Date.now()): void {
  const id = itemType === 'Episode' ? seriesId : itemType === 'Movie' || itemType === 'Series' ? itemId : undefined;
  if (!id || !ID_RE.test(id) || pending.has(id) || pending.size >= PENDING_MAX) return;
  pending.set(id, now);
}

/** A library removal: the row goes at once (the next full pass corrects the IDF). Never throws. */
export async function recoIndexRemoved(ctx: Pick<Ctx, 'db'>, itemId: string): Promise<void> {
  pending.delete(itemId);
  try {
    await ctx.db.query('delete from item_features where item_id = $1', [itemId]);
  } catch {
    // the next full pass removes it
  }
}

/** Listens on the media.event bus (itemAdded / itemRemoved); returns the unsubscribe function. */
export function startRecoIndexListener(ctx: Pick<Ctx, 'db'>): () => void {
  const fn = (e: MediaEvent) => {
    if (e.type === 'itemAdded') recoIndexAnnounce(e.itemId, e.itemType, e.seriesId);
    else if (e.type === 'itemRemoved' && (e.itemType === 'Movie' || e.itemType === 'Series')) void recoIndexRemoved(ctx, e.itemId);
  };
  bus.onT('media.event', fn);
  return () => { bus.off('media.event', fn as (...a: unknown[]) => void); };
}

export interface RecoIndexState { supported: boolean; running: boolean; items: number; updatedAt: string | null; lastFull: string | null }
/** Size and age of the index for the admin status page and the metrics. Never throws. */
export async function recoIndexState(ctx: Pick<Ctx, 'jf' | 'kv' | 'db'>): Promise<RecoIndexState> {
  const r = await ctx.db.query<{ n: string; at: Date | null }>('select count(*) n, max(updated_at) at from item_features').then((x) => x.rows[0], () => undefined);
  return {
    supported: ctx.jf.capabilities.libraryFeatures === true && typeof ctx.jf.libraryFeatures === 'function',
    running: current !== null || Boolean(await kvGet(ctx, K.running)),
    items: Number(r?.n ?? 0),
    updatedAt: r?.at ? r.at.toISOString() : null,
    lastFull: await kvGet(ctx, K.lastFull),
  };
}
