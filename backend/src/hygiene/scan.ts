// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Ctx } from '../ctx.js';
import { recordError } from '../errorlog.js';
import { FALLBACK_LANGUAGE, instanceLanguage } from '../i18n.js';
import { normLang } from '../langindex.js';
import type { HygieneFacts } from '../media/types.js';
import { DUP_CODES, compactFacts, factsFromRow, itemIssues, keysOf, type IssueCode, type StoredFacts } from './rules.js';

/**
 * Block 22: library hygiene scan into hygiene_items. Background only (server.ts, BACKGROUND_JOBS), never inside a request.
 * Incremental every 30 min (items saved since the last successful start minus 5 min), a full sweep on the first run and every
 * 7 days; only a complete full sweep deletes rows of vanished items (itemRemoved events delete single rows at once). Pages of 200,
 * each upserted at once, a short pause in between (memory stays flat for 50k items). Never throws.
 */
const PAGE = 200;
const PAUSE_MS = 200;
const OVERLAP_MS = 5 * 60_000;
const FULL_EVERY_MS = 7 * 86400_000;
const EVERY_MS = 30 * 60_000;
const SOON_MS = 2 * 60_000;
/** safety cap per type (400 000 items) */
const MAX_PAGES = 2000;
const TYPES = ['Movie', 'Series', 'Episode'] as const;
const KEEP_S = 90 * 86400;
/** the running flag expires 5 min after the last heartbeat (refreshed every minute while a scan pages) */
const RUNNING_TTL_S = 300;
const HEARTBEAT_MS = 60_000;
const K = {
  lastStart: 'hygiene:lastStart', lastFull: 'hygiene:lastFull', lastDone: 'hygiene:lastDone', lastTry: 'hygiene:lastTry',
  langs: 'hygiene:langs', running: 'hygiene:running', soon: 'hygiene:soon', summary: 'hygiene:summary',
} as const;
/** UI languages (2 letters) → ISO 639-2/T as the media server reports tracks */
const UI_LANG: Record<string, string> = { de: 'deu', en: 'eng', fr: 'fra', es: 'spa', it: 'ita', tr: 'tur', pl: 'pol' };

let current: Promise<void> | null = null;
let stopping = false;

/** Stops a running scan after its current page (shutdown). */
export function stopHygiene(): void {
  stopping = true;
}
/** Resolves when no scan runs in this process (tests). */
export function hygieneIdle(): Promise<void> {
  return current ?? Promise.resolve();
}

/** Instance language plus every profile's UI, audio and subtitle preference, normalised (ger → deu). */
export async function householdLanguages(ctx: Pick<Ctx, 'db'>): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    if (!v) return;
    const l = normLang(UI_LANG[v] ?? v);
    if (l) out.add(l);
  };
  add((await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE);
  const r = await ctx.db.query<{ a: string | null; s: string | null; l: string | null }>(
    "select distinct data->>'audioLang' a, data->>'subtitleLang' s, data->>'language' l from profile_prefs",
  );
  for (const row of r.rows) { add(row.a); add(row.s); add(row.l); }
  return out;
}
const langsFp = (langs: ReadonlySet<string>) => [...langs].sort().join(',');

interface RowIn { item_id: string; type: string; name: string; series_id: string | null; series_name: string | null; year: number | null; facts: StoredFacts; issues: IssueCode[]; ids_key: string | null; title_key: string | null; episode_key: string | null }

function rowOf(f: HygieneFacts, langs: ReadonlySet<string>): RowIn {
  const keys = keysOf(f);
  return {
    item_id: f.id, type: f.type, name: (f.name ?? '').slice(0, 300), series_id: f.seriesId ?? null, series_name: f.seriesName?.slice(0, 300) ?? null,
    year: Number.isInteger(f.year) && f.year! > 0 && f.year! < 10000 ? f.year! : null,
    facts: compactFacts(f), issues: itemIssues(f, langs), ids_key: keys.ids, title_key: keys.title, episode_key: keys.episode,
  };
}

async function upsert(ctx: Pick<Ctx, 'db'>, items: HygieneFacts[], langs: ReadonlySet<string>, runStart: Date): Promise<void> {
  const byId = new Map<string, RowIn>();
  for (const f of items) if (typeof f.id === 'string' && f.id && f.id.length <= 64) byId.set(f.id, rowOf(f, langs));
  if (!byId.size) return;
  await ctx.db.query(
    `insert into hygiene_items(item_id, type, name, series_id, series_name, year, facts, issues, ids_key, title_key, episode_key, scanned_at)
     select x.item_id, x.type, x.name, x.series_id, x.series_name, x.year, x.facts, x.issues, x.ids_key, x.title_key, x.episode_key, $2
       from jsonb_to_recordset($1::jsonb) as x(item_id text, type text, name text, series_id text, series_name text, year int, facts jsonb,
                                               issues text[], ids_key text, title_key text, episode_key text)
     on conflict (item_id) do update set type = excluded.type, name = excluded.name, series_id = excluded.series_id, series_name = excluded.series_name,
       year = excluded.year, facts = excluded.facts, ids_key = excluded.ids_key, title_key = excluded.title_key, episode_key = excluded.episode_key,
       scanned_at = excluded.scanned_at,
       -- keep the duplicate codes until the recompute at the end of the run
       issues = excluded.issues || array(select c from unnest(hygiene_items.issues) c where c = any($3::text[]))`,
    [JSON.stringify([...byId.values()]), runStart, DUP_CODES],
  );
}

/** Duplicate codes from the keys (one statement; only rows whose duplicate state changes are written). */
async function recomputeDuplicates(ctx: Pick<Ctx, 'db'>): Promise<void> {
  await ctx.db.query(`
    with c as (
      select item_id,
        ids_key is not null and count(*) over (partition by ids_key) > 1 as di,
        title_key is not null and count(*) over (partition by title_key) > 1 as dt0,
        episode_key is not null and count(*) over (partition by episode_key) > 1 as de
      from hygiene_items
    ), d as (select item_id, di, dt0 and not di as dt, de from c)
    update hygiene_items h set issues = array_remove(array_remove(array_remove(h.issues, 'dup_ids'), 'dup_title'), 'dup_episode')
      || case when d.di then '{dup_ids}'::text[] else '{}'::text[] end
      || case when d.dt then '{dup_title}'::text[] else '{}'::text[] end
      || case when d.de then '{dup_episode}'::text[] else '{}'::text[] end
    from d
    where d.item_id = h.item_id
      and (('dup_ids' = any(h.issues)) <> d.di or ('dup_title' = any(h.issues)) <> d.dt or ('dup_episode' = any(h.issues)) <> d.de)`);
}

/** Re-evaluates every film / episode from its stored facts with the current household languages (no media server calls). */
async function recomputeLanguages(ctx: Pick<Ctx, 'db'>, langs: ReadonlySet<string>): Promise<void> {
  let after = '';
  for (;;) {
    const r = await ctx.db.query<{ item_id: string; type: HygieneFacts['type']; name: string; series_id: string | null; year: number | null; facts: StoredFacts; issues: string[] }>(
      `select item_id, type, name, series_id, year, facts, issues from hygiene_items where type <> 'Series' and item_id > $1 order by item_id limit 1000`, [after],
    );
    if (!r.rows.length) return;
    after = r.rows[r.rows.length - 1]!.item_id;
    const changed: Array<{ item_id: string; issues: string[] }> = [];
    for (const row of r.rows) {
      const next = [...itemIssues(factsFromRow(row), langs), ...row.issues.filter((c) => (DUP_CODES as readonly string[]).includes(c))];
      if (next.length !== row.issues.length || next.some((c, i) => c !== row.issues[i])) changed.push({ item_id: row.item_id, issues: next });
    }
    if (changed.length) {
      await ctx.db.query(
        `update hygiene_items h set issues = x.issues from jsonb_to_recordset($1::jsonb) as x(item_id text, issues text[]) where h.item_id = x.item_id`,
        [JSON.stringify(changed)],
      );
    }
    if (r.rows.length < 1000) return;
  }
}

const kvGet = (ctx: Pick<Ctx, 'kv'>, k: string) => ctx.kv.get(k).catch(() => null);
const kvSet = (ctx: Pick<Ctx, 'kv'>, k: string, v: string, ttl = KEEP_S) => ctx.kv.set(k, v, ttl).catch(() => undefined);

type ScanFn = NonNullable<Ctx['jf']['libraryHygiene']>;

async function run(ctx: Ctx, scanFn: ScanFn, opts: { full?: boolean; now?: Date; pauseMs?: number }): Promise<void> {
  const runStart = opts.now ?? new Date();
  const pause = opts.pauseMs ?? PAUSE_MS;
  // the running flag is also the lock across replicas (setnx); a short TTL refreshed while scanning, so a killed process
  // blocks the next scan for minutes, not an hour. Without Redis the scan still runs (single backend).
  const token = randomUUID();
  if (!(await ctx.kv.setnx(K.running, token, RUNNING_TTL_S).catch(() => true))) return;
  let beat = Date.now();
  try {
    await kvSet(ctx, K.lastTry, String(runStart.getTime()));
    const lastFull = Date.parse((await kvGet(ctx, K.lastFull)) ?? '');
    const lastStart = Date.parse((await kvGet(ctx, K.lastStart)) ?? '');
    const full = Boolean(opts.full) || !Number.isFinite(lastFull) || !Number.isFinite(lastStart) || runStart.getTime() - lastFull >= FULL_EVERY_MS;
    const savedSince = full ? undefined : new Date(lastStart - OVERLAP_MS).toISOString();
    const langs = await householdLanguages(ctx);
    const fp = langsFp(langs);
    for (const type of TYPES) {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (stopping) return; // incomplete: nothing deleted, state unchanged, the next start retries
        const items = await scanFn(type, { start: page * PAGE, limit: PAGE, ...(savedSince ? { savedSince } : {}) });
        await upsert(ctx, items.filter((i) => i?.type === type), langs, runStart);
        if (Date.now() - beat >= HEARTBEAT_MS) {
          beat = Date.now();
          await kvSet(ctx, K.running, token, RUNNING_TTL_S);
        }
        if (items.length < PAGE) break;
        if (pause > 0) await sleep(pause);
        else await new Promise((r) => setImmediate(r)); // still yield between pages
      }
    }
    if (!full && fp !== (await kvGet(ctx, K.langs))) await recomputeLanguages(ctx, langs);
    await recomputeDuplicates(ctx);
    if (full) {
      await ctx.db.query('delete from hygiene_items where scanned_at < $1', [runStart]);
      await ctx.db.query('delete from hygiene_ignored i where not exists (select 1 from hygiene_items h where h.item_id = i.item_id)');
      // a deleted row may have been the other half of a duplicate
      await recomputeDuplicates(ctx);
    }
    await kvSet(ctx, K.langs, fp);
    await kvSet(ctx, K.lastStart, runStart.toISOString());
    if (full) await kvSet(ctx, K.lastFull, runStart.toISOString());
    await kvSet(ctx, K.lastDone, new Date().toISOString());
  } catch {
    // the message may carry a server URL: log and record only the job name
    console.warn('library hygiene scan failed');
    void recordError(ctx, { source: 'job', code: 'hygiene' });
  } finally {
    await ctx.kv.del(K.summary).catch(() => undefined);
    // only our own flag (another replica may have taken over after our TTL ran out)
    if ((await kvGet(ctx, K.running)) === token) await ctx.kv.del(K.running).catch(() => undefined);
  }
}

/** One scan (full or incremental, see above). One run per process; without `libraryHygiene` it returns at once. Never throws. */
export function hygieneTick(ctx: Ctx, opts: { full?: boolean; now?: Date; pauseMs?: number } = {}): Promise<void> {
  const scanFn = ctx.jf.libraryHygiene?.bind(ctx.jf);
  if (!scanFn || current) return current ?? Promise.resolve();
  stopping = false;
  const p = run(ctx, scanFn, opts).finally(() => { if (current === p) current = null; });
  current = p;
  return p;
}

/**
 * Called every minute by server.ts: runs a scan when the last try is ≥ 30 min old, or when a library addition was announced
 * ≥ 2 min ago (hygieneSoon; many additions within that window → one run). Returns whether a scan ran. Never throws.
 */
export async function hygieneDue(ctx: Ctx, opts: { now?: number; pauseMs?: number } = {}): Promise<boolean> {
  if (current || !ctx.jf.libraryHygiene) return false;
  const now = opts.now ?? Date.now();
  const soon = Number(await kvGet(ctx, K.soon)) || 0;
  const lastTry = Number(await kvGet(ctx, K.lastTry)) || 0;
  if (!(soon && now - soon >= SOON_MS) && now - lastTry < EVERY_MS) return false;
  if (await ctx.kv.get(K.running).catch(() => null)) return false; // another replica scans
  await ctx.kv.del(K.soon).catch(() => undefined);
  await hygieneTick(ctx, { now: new Date(now), pauseMs: opts.pauseMs });
  return true;
}

/** A library addition: schedule an early incremental scan (first announcement counts; picked up by hygieneDue). */
export async function hygieneSoon(ctx: Pick<Ctx, 'kv'>): Promise<void> {
  await ctx.kv.setnx(K.soon, String(Date.now()), 3600).catch(() => undefined);
}

/** A library removal: drop the item's row at once (and its episodes' rows for a series). Never throws. */
export async function hygieneRemoved(ctx: Pick<Ctx, 'db' | 'kv'>, itemId: string): Promise<void> {
  try {
    const r = await ctx.db.query('delete from hygiene_items where item_id = $1 or series_id = $1', [itemId]);
    if (r.rowCount) await ctx.kv.del(K.summary).catch(() => undefined);
  } catch {
    // the next full sweep removes it
  }
}

export interface HygieneState { supported: boolean; running: boolean; lastDone: string | null; lastFull: string | null }
export async function hygieneState(ctx: Pick<Ctx, 'jf' | 'kv'>): Promise<HygieneState> {
  return {
    supported: typeof ctx.jf.libraryHygiene === 'function',
    running: current !== null || Boolean(await kvGet(ctx, K.running)),
    lastDone: await kvGet(ctx, K.lastDone),
    lastFull: await kvGet(ctx, K.lastFull),
  };
}

/** "Jetzt prüfen": starts a full sweep in the background; false while one runs or without `libraryHygiene`. */
export function startHygieneScan(ctx: Ctx): boolean {
  if (current || !ctx.jf.libraryHygiene) return false;
  void hygieneTick(ctx, { full: true });
  return true;
}
