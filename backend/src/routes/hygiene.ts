// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { CATEGORY, ISSUE_CODES, SEVERITY, type Category, type IssueCode, type StoredFacts } from '../hygiene/rules.js';
import { hygieneState, startHygieneScan, type HygieneState } from '../hygiene/scan.js';
import { normLang } from '../langindex.js';
import type { HygieneSource, HygieneStream } from '../media/types.js';
import { requireAdmin } from '../session.js';

/** Block 22: library hygiene admin API (admin role on the owner profile only). SQL only; never calls the media server except "refresh". */
export interface HygieneSummary {
  state: HygieneState;
  total: number; byCategory: Record<Category, number>; byIssue: Partial<Record<IssueCode, number>>; ignored: number; canRefresh: boolean;
}
export interface HygieneRow {
  itemId: string; type: 'Movie' | 'Series' | 'Episode'; name: string; seriesId: string | null; seriesName: string | null; year: number | null;
  issues: Array<{ code: IssueCode; severity: 'warn' | 'info' }>; versions: number; container: string | null; bitrate: number | null; sizeBytes: number | null;
  video: string | null; audio: string[]; subtitles: string[]; dupOf: string[];
}

const CATEGORIES: Category[] = ['info', 'language', 'duplicate', 'file'];
const codesOf = (c: Category) => ISSUE_CODES.filter((x) => CATEGORY[x] === c);
const SUMMARY_KEY = 'hygiene:summary';
const SUMMARY_TTL = 60;
const REFRESH_PER_MIN = 30;
const SCANS_PER_10_MIN = 2;
const itemIdRe = /^[\w-]{1,64}$/;

const issueEnum = z.enum(ISSUE_CODES as [IssueCode, ...IssueCode[]]);
const listQuery = z.object({
  category: z.enum(['info', 'language', 'duplicate', 'file']).optional(),
  issue: issueEnum.optional(),
  type: z.enum(['Movie', 'Series', 'Episode']).optional(),
  seriesId: z.string().regex(itemIdRe).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['name', 'issues', 'size', 'bitrate']).default('name'),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const ignoreBody = z.object({ itemId: z.string().regex(itemIdRe), code: issueEnum });
const itemParams = z.object({ itemId: z.string().regex(itemIdRe) });

/** issues minus the codes ignored for that item */
const EFFECTIVE = `array(select c from unnest(h.issues) c where not exists (select 1 from hygiene_ignored i where i.item_id = h.item_id and i.code = c))`;
const MAX_OF = (k: string) => `(select max((s->>'${k}')::float8) from jsonb_array_elements(coalesce(h.facts->'sources', '[]'::jsonb)) s)`;
const ORDER: Record<'name' | 'issues' | 'size' | 'bitrate', { exprs: string[]; dir: 'asc' | 'desc' }> = {
  // episodes sort under their series, then by season / episode number
  name: { exprs: ['lower(coalesce(h.series_name, h.name))', "(h.facts->>'season')::int", "(h.facts->>'episode')::int", 'lower(h.name)'], dir: 'asc' },
  issues: { exprs: ['cardinality(eff)', 'lower(h.name)'], dir: 'desc' },
  size: { exprs: [MAX_OF('sizeBytes')], dir: 'desc' },
  bitrate: { exprs: [MAX_OF('bitrate')], dir: 'desc' },
};

const IMAGE_SUBS: Record<string, string> = { pgssub: 'pgs', hdmv_pgs_subtitle: 'pgs', pgs: 'pgs', dvdsub: 'vobsub', dvd_subtitle: 'vobsub', vobsub: 'vobsub', dvbsub: 'dvb', dvb_subtitle: 'dvb' };
const lang = (l: string | undefined) => normLang(l) ?? (l ? l.slice(0, 8) : 'und');
const join = (parts: Array<string | number | null | undefined | false>) => parts.filter(Boolean).join(' ');

function videoText(v: HygieneStream | undefined): string | null {
  if (!v) return null;
  const s = join([v.codec, (v.bitDepth ?? 0) >= 10 && `${v.bitDepth}-bit`, v.height && `${v.height}p`, v.hdr && 'HDR']);
  return s || null;
}
const audioText = (a: HygieneStream) => join([lang(a.lang), a.codec, a.channels && `${a.channels}ch`]);
const subText = (s: HygieneStream) => join([lang(s.lang), s.text === false && (IMAGE_SUBS[s.codec ?? ''] ?? s.codec ?? 'image'), s.forced && 'forced']);

/** The version the row describes: the one with the highest video, else the first. */
function bestSource(sources: HygieneSource[]): HygieneSource | undefined {
  return sources.reduce<HygieneSource | undefined>((best, s) => (!best || (s.video?.[0]?.height ?? 0) > (best.video?.[0]?.height ?? 0) ? s : best), undefined);
}

interface DbRow { item_id: string; type: HygieneRow['type']; name: string; series_id: string | null; series_name: string | null; year: number | null; facts: StoredFacts; eff: string[]; total: number }

function toRow(r: DbRow, dupOf: string[]): HygieneRow {
  const sources = Array.isArray(r.facts?.sources) ? r.facts.sources : [];
  const src = bestSource(sources);
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const str = (s: unknown) => (typeof s === 'string' && s ? s.slice(0, 40) : null);
  return {
    itemId: r.item_id, type: r.type, name: r.name, seriesId: r.series_id, seriesName: r.series_name, year: r.year,
    issues: r.eff.filter((c): c is IssueCode => c in CATEGORY).map((code) => ({ code, severity: SEVERITY[code] })),
    versions: sources.length,
    container: str(src?.container), bitrate: num(src?.bitrate), sizeBytes: num(src?.sizeBytes),
    video: videoText(src?.video?.[0]),
    audio: (src?.audio ?? []).slice(0, 8).map(audioText),
    subtitles: (src?.subtitles ?? []).slice(0, 12).map(subText),
    dupOf,
  };
}

type Counts = Omit<HygieneSummary, 'state' | 'canRefresh'>;
async function counts(ctx: Ctx): Promise<Counts> {
  const cached = await ctx.kv.get(SUMMARY_KEY).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached) as Counts; } catch { /* rebuild */ }
  }
  const per = await ctx.db.query<{ c: string; n: number }>(
    `select c, count(*)::int n from hygiene_items h cross join unnest(${EFFECTIVE}) c group by c`);
  const cat = await ctx.db.query<Record<string, number>>(
    `select count(*) filter (where cardinality(eff) > 0)::int total,
            ${CATEGORIES.map((c, i) => `count(*) filter (where eff && $${i + 1}::text[])::int "${c}"`).join(', ')}
       from (select ${EFFECTIVE} eff from hygiene_items h where cardinality(h.issues) > 0) x`,
    CATEGORIES.map(codesOf));
  const ign = await ctx.db.query<{ n: number }>(
    'select count(*)::int n from hygiene_ignored i join hygiene_items h on h.item_id = i.item_id where i.code = any(h.issues)');
  const row = cat.rows[0] ?? {};
  const out: Counts = {
    total: row.total ?? 0,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, row[c] ?? 0])) as Record<Category, number>,
    byIssue: Object.fromEntries(per.rows.filter((x) => x.c in CATEGORY).map((x) => [x.c, x.n])),
    ignored: ign.rows[0]?.n ?? 0,
  };
  await ctx.kv.set(SUMMARY_KEY, JSON.stringify(out), SUMMARY_TTL).catch(() => undefined);
  return out;
}

export function hygieneRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };
  const dropSummary = () => ctx.kv.del(SUMMARY_KEY).catch(() => undefined);

  app.get('/api/admin/hygiene/summary', admin, async (): Promise<HygieneSummary> => ({
    state: await hygieneState(ctx),
    ...(await counts(ctx)),
    canRefresh: typeof ctx.jf.refreshMetadata === 'function',
  }));

  app.get('/api/admin/hygiene', admin, async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const pre: string[] = [];
    const codes = q.issue ? [q.issue] : q.category ? codesOf(q.category) : null;
    const codesPh = codes ? p(codes) : null; // always $1 when present
    pre.push(codesPh ? `h.issues && ${codesPh}::text[]` : 'cardinality(h.issues) > 0');
    if (q.type) pre.push(`h.type = ${p(q.type)}`);
    if (q.seriesId) pre.push(`h.series_id = ${p(q.seriesId)}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const ph = p(like);
      pre.push(`(h.name ilike ${ph} escape '\\' or h.series_name ilike ${ph} escape '\\')`);
    }
    const order = ORDER[q.sort];
    const dir = q.dir ?? order.dir;
    const sql = `
      select * from (
        select h.item_id, h.type, h.name, h.series_id, h.series_name, h.year, h.facts, ${EFFECTIVE} eff from hygiene_items h where ${pre.join(' and ')}
      ) h
      where cardinality(eff) > 0 ${codesPh ? `and eff && ${codesPh}::text[]` : ''}
      order by ${order.exprs.map((e) => `${e} ${dir} nulls last`).join(', ')}, h.item_id
      limit ${p(q.limit)} offset ${p(q.offset)}`;
    const countSql = `
      select count(*)::int n from (select ${EFFECTIVE} eff from hygiene_items h where ${pre.join(' and ')}) h
      where cardinality(eff) > 0 ${codesPh ? `and eff && ${codesPh}::text[]` : ''}`;
    const [rows, total] = await Promise.all([
      ctx.db.query<DbRow>(sql, params),
      ctx.db.query<{ n: number }>(countSql, params.slice(0, params.length - 2)),
    ]);
    // other items with the same duplicate key (only for rows that have a duplicate code)
    const dupIds = rows.rows.filter((r) => r.eff.some((c) => c.startsWith('dup_'))).map((r) => r.item_id);
    const dups = new Map<string, string[]>();
    if (dupIds.length) {
      const d = await ctx.db.query<{ item_id: string; others: string[] }>(
        `select h.item_id, array(
           select o.item_id from hygiene_items o
            where o.item_id <> h.item_id and (o.ids_key = h.ids_key or o.title_key = h.title_key or o.episode_key = h.episode_key)
            order by o.item_id limit 5) others
           from hygiene_items h where h.item_id = any($1::text[])`, [dupIds]);
      for (const r of d.rows) dups.set(r.item_id, r.others);
    }
    return { items: rows.rows.map((r) => toRow(r, dups.get(r.item_id) ?? [])), total: total.rows[0]?.n ?? 0 };
  });

  app.post('/api/admin/hygiene/ignore', admin, async (req) => {
    const b = ignoreBody.parse(req.body);
    await ctx.db.query('insert into hygiene_ignored(item_id, code, by_user) values ($1, $2, $3) on conflict (item_id, code) do nothing', [b.itemId, b.code, req.user!.id]);
    await dropSummary();
    await audit(ctx, req.user!.id, 'hygiene.ignore', b.itemId, { code: b.code });
    return { ok: true };
  });

  app.delete('/api/admin/hygiene/ignore', admin, async (req) => {
    const b = ignoreBody.parse(req.body);
    await ctx.db.query('delete from hygiene_ignored where item_id = $1 and code = $2', [b.itemId, b.code]);
    await dropSummary();
    await audit(ctx, req.user!.id, 'hygiene.unignore', b.itemId, { code: b.code });
    return { ok: true };
  });

  app.post('/api/admin/hygiene/:itemId/refresh', admin, async (req, reply) => {
    const { itemId } = itemParams.parse(req.params);
    if (typeof ctx.jf.refreshMetadata !== 'function') return reply.code(501).send({ error: 'unsupported' });
    if ((await ctx.kv.incr(`rl:hygiene-refresh:${req.user!.id}`, 60)) > REFRESH_PER_MIN) return reply.code(429).send({ error: 'rate_limited' });
    try {
      await ctx.jf.refreshMetadata(itemId);
    } catch (e) {
      // never pass the server's message on (it may carry a URL)
      if ((e as { status?: number }).status === 404) return reply.code(404).send({ error: 'not_found' });
      return reply.code(502).send({ error: 'refresh_failed' });
    }
    await audit(ctx, req.user!.id, 'hygiene.refresh', itemId);
    return { ok: true };
  });

  app.post('/api/admin/hygiene/scan', admin, async (req, reply) => {
    if ((await ctx.kv.incr(`rl:hygiene-scan:${req.user!.id}`, 600)) > SCANS_PER_10_MIN) return reply.code(429).send({ error: 'rate_limited' });
    const started = startHygieneScan(ctx);
    await audit(ctx, req.user!.id, 'hygiene.scan', undefined, { started });
    return { started };
  });
}
