// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { recordError } from './errorlog.js';
import type { ItemStreams } from './media/types.js';

/** ISO 639-2/B (bibliographic) -> 639-2/T, so "ger" and "deu" are one language. */
const B2T: Record<string, string> = {
  ger: 'deu', fre: 'fra', chi: 'zho', cze: 'ces', dut: 'nld', gre: 'ell', per: 'fas', rum: 'ron', slo: 'slk', ice: 'isl', alb: 'sqi',
  arm: 'hye', baq: 'eus', bur: 'mya', geo: 'kat', mac: 'mkd', mao: 'mri', may: 'msa', tib: 'bod', wel: 'cym',
};

/** Normalised 3-letter language code, or null for unknown/undetermined. */
export function normLang(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c) || c === 'und' || c === 'zxx' || c === 'mis' || c === 'mul') return null;
  return B2T[c] ?? c;
}

const INTERVAL_MS = 12 * 3600_000;
const PAGE = 200;
const MAX_MOVIES = 20_000;
const MAX_EPISODES = 100_000;
const KEY = 'langidx:last';
let busy = false;
let startedOnce = false;

interface Agg { type: 'Movie' | 'Series'; audio: Set<string>; subs: Set<string> }

function collect(into: Map<string, Agg>, id: string, type: 'Movie' | 'Series', item: ItemStreams) {
  let a = into.get(id);
  if (!a) into.set(id, (a = { type, audio: new Set(), subs: new Set() }));
  for (const [langs, set] of [[item.audio, a.audio], [item.subtitles, a.subs]] as const) {
    for (const raw of langs) {
      const l = normLang(raw);
      if (l) set.add(l);
    }
  }
}

/** Pages one item type; returns false when the cap cut the listing short. */
async function scan(ctx: Ctx, type: 'Movie' | 'Episode', cap: number, onItem: (i: ItemStreams) => void): Promise<boolean> {
  for (let start = 0; start < cap; start += PAGE) {
    const items = await ctx.jf.libraryStreams(type, start, Math.min(PAGE, cap - start));
    items.forEach(onItem);
    if (items.length < Math.min(PAGE, cap - start)) return true;
  }
  return false;
}

/**
 * Rebuilds item_langs from the whole library (admin key sees everything). At most every 12 h (and once after start).
 * Never throws; rows of vanished items are removed only after a complete run.
 */
export async function langIndexTick(ctx: Ctx, opts: { force?: boolean } = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const last = Number(await ctx.kv.get(KEY).catch(() => null)) || 0;
    if (!opts.force && Date.now() - last < INTERVAL_MS) {
      // first run after a process start: still honour the last-run stamp, but rebuild when the index table is empty
      if (startedOnce || (await ctx.db.query('select 1 from item_langs limit 1')).rowCount) return;
    }
    startedOnce = true;
    const runStart = new Date();
    const agg = new Map<string, Agg>();
    const moviesDone = await scan(ctx, 'Movie', MAX_MOVIES, (i) => { if (i.id) collect(agg, i.id, 'Movie', i); });
    const epsDone = await scan(ctx, 'Episode', MAX_EPISODES, (i) => { if (i.seriesId) collect(agg, i.seriesId, 'Series', i); });
    const rows = [...agg.entries()];
    for (let i = 0; i < rows.length; i += 1000) {
      const b = rows.slice(i, i + 1000);
      await ctx.db.query(
        `insert into item_langs(item_id, type, audio, subs, indexed_at)
         select id, t, string_to_array(a, ','), string_to_array(s, ','), $5 from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as x(id, t, a, s)
         on conflict (item_id) do update set type = excluded.type, audio = excluded.audio, subs = excluded.subs, indexed_at = excluded.indexed_at`,
        [b.map((x) => x[0]), b.map((x) => x[1].type), b.map((x) => [...x[1].audio].sort().join(',')), b.map((x) => [...x[1].subs].sort().join(',')), runStart],
      );
    }
    if (moviesDone && epsDone) await ctx.db.query('delete from item_langs where indexed_at < $1', [runStart]);
    await ctx.kv.set(KEY, String(Date.now()), 7 * 86400).catch(() => undefined);
    await ctx.kv.del('langs:summary').catch(() => undefined);
  } catch (e) {
    console.warn('language index failed', (e as Error).message);
    void recordError(ctx, { source: 'job', code: 'language-index' });
  } finally {
    busy = false;
  }
}
