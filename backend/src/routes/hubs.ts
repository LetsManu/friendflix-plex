// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { MediaError, type ItemDto } from '../media/types.js';
import { onPolicyChange } from '../hooks.js';
import { bumpHomeAll } from '../homegen.js';
import { requireAdmin, requireUser } from '../session.js';
import type { JfUser } from '../types.js';
import { id32, wrap, type WrapOptions } from './_shared.js';

/** Block 15: brand hubs (brand tiles from the owner's own studios / collections / tags / genres) and the Extras tab. */

const SOURCES = ['studio', 'collection', 'tag', 'genre'] as const;
type SourceKind = (typeof SOURCES)[number];
/** the home page shows a single row of tiles: more than this would not fit anyway */
export const MAX_HUBS = 8;
const ROW_LIMIT = 20;
/** per-user "does this hub contain anything I may see" memo; keeps GET /api/hubs cheap (one Jellyfin call per hub, once per TTL) */
const VISIBLE_TTL_MS = 120_000;
const VISIBLE_MAX = 1000;
const EXTRAS_TTL_MS = 60_000;
const EXTRAS_MAX = 500;

interface HubRow {
  id: string; name: string; source_kind: SourceKind; source_value: string; accent: string | null;
  image_item_id: string | null; image_kind: 'Primary' | 'Backdrop' | null; sort_order: number; enabled: boolean;
}

const hubCols = 'id, name, source_kind, source_value, accent, image_item_id, image_kind, sort_order, enabled';
const imageUrl = (h: HubRow) => (h.image_item_id && h.image_kind ? `/media/Items/${h.image_item_id}/Images/${h.image_kind}?maxWidth=${h.image_kind === 'Backdrop' ? 640 : 480}&quality=80` : undefined);
const publicHub = (h: HubRow) => ({
  id: h.id, name: h.name, source: h.source_kind, accent: h.accent ?? undefined, imageUrl: imageUrl(h),
});
const adminHub = (h: HubRow) => ({
  ...publicHub(h), sourceValue: h.source_value, imageItemId: h.image_item_id ?? undefined, sortOrder: h.sort_order, enabled: h.enabled,
});

/** Jellyfin treats `|` as the list separator of studios/genres/tags */
const sourceValue = z.string().trim().min(1).max(120).refine((s) => !s.includes('|'), 'no_pipe');
const accent = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const hubBody = z.object({
  name: z.string().trim().min(1).max(40),
  source: z.enum(SOURCES),
  sourceValue,
  accent: accent.nullish(),
  imageItemId: id32.nullish(),
  enabled: z.boolean().optional(),
});

/** Registers the hub routes; returns the viewer-side lookup GET /api/home reuses (same memo, same visibility rules). */
export function hubRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireAdmin(ctx) };
  const adminWrite = { ...admin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const guard: WrapOptions = { zod: 'issues', notFound: [400, 403, 404] };

  /** Everything a hub contains, queried as the given user (so access rules and parental ratings apply). */
  async function query(user: JfUser, h: Pick<HubRow, 'source_kind' | 'source_value'>, o: { types?: string; sort: string; desc?: boolean; limit: number; start?: number }) {
    const k = h.source_kind;
    const source = k === 'studio' ? { studio: h.source_value } : k === 'genre' ? { genre: h.source_value } : k === 'tag' ? { tag: h.source_value } : { parentId: h.source_value };
    return ctx.jf.items(user, { ...o, ...source });
  }

  const visible = new Map<string, { exp: number; p: Promise<boolean> }>();
  /** Does the user see at least one title in the hub? (A collection they cannot open counts as empty.) */
  function hasItems(user: JfUser, h: HubRow): Promise<boolean> {
    const key = `${user.jellyfin_user_id}|${h.id}|${h.source_kind}|${h.source_value}`;
    const hit = visible.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = query(user, h, { sort: 'SortName', limit: 1 }).then((r) => r.total > 0, (e) => {
      if (e instanceof MediaError && (e.status === 400 || e.status === 403 || e.status === 404)) return false;
      throw e;
    });
    visible.set(key, { exp: Date.now() + VISIBLE_TTL_MS, p });
    p.catch(() => { if (visible.get(key)?.p === p) visible.delete(key); });
    while (visible.size > VISIBLE_MAX) visible.delete(visible.keys().next().value!);
    return p;
  }

  /**
   * The hub as a viewer sees it: the tile image only when the viewer may see the image's item (a kids profile or a capped role
   * must not get the artwork of a title it cannot open); otherwise the client draws the gradient tile. ctx.jf.item is memoized.
   */
  async function viewerHub(user: JfUser, h: HubRow) {
    const pub = publicHub(h);
    if (!pub.imageUrl || !h.image_item_id) return pub;
    const ok = await ctx.jf.item(user, h.image_item_id).then(() => true, () => false);
    return ok ? pub : { ...pub, imageUrl: undefined };
  }

  const loadHub = async (id: string, onlyEnabled = true): Promise<HubRow | undefined> =>
    (await ctx.db.query<HubRow>(`select ${hubCols} from brand_hubs where id = $1 ${onlyEnabled ? 'and enabled' : ''}`, [id])).rows[0];
  const uuid = z.string().uuid();

  // ---- viewer ----
  /** Data of GET /api/hubs (also part of GET /api/home). */
  const viewerHubs = async (user: JfUser) => {
    const hubs = (await ctx.db.query<HubRow>(`select ${hubCols} from brand_hubs where enabled order by sort_order, created_at limit ${MAX_HUBS}`)).rows;
    const ok = await Promise.all(hubs.map((h) => hasItems(user, h).catch(() => false)));
    return { hubs: await Promise.all(hubs.filter((_, i) => ok[i]).map((h) => viewerHub(user, h))) };
  };
  app.get('/api/hubs', pre, wrap(async (req) => viewerHubs(req.jfUser!)));

  app.get('/api/hubs/:id', pre, wrap(async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const hub = id.success ? await loadHub(id.data) : undefined;
    if (!hub) return reply.code(404).send({ error: 'not_found' });
    const user = req.jfUser!;
    const [news, popular, movies, series] = await Promise.all([
      query(user, hub, { sort: 'DateCreated', desc: true, limit: ROW_LIMIT }),
      query(user, hub, { sort: 'PlayCount,CommunityRating', desc: true, limit: ROW_LIMIT }),
      query(user, hub, { types: 'Movie', sort: 'PremiereDate,SortName', desc: true, limit: ROW_LIMIT }),
      query(user, hub, { types: 'Series', sort: 'PremiereDate,SortName', desc: true, limit: ROW_LIMIT }),
    ]).catch((e) => {
      if (e instanceof MediaError && (e.status === 400 || e.status === 403 || e.status === 404)) return null;
      throw e;
    }) ?? [];
    if (!news || news.total === 0) return reply.code(404).send({ error: 'not_found' }); // nothing visible: same answer as a hub that does not exist
    const rows = [
      { key: 'new', items: news.items },
      { key: 'popular', items: popular!.items },
      { key: 'movies', items: movies!.items, total: movies!.total },
      { key: 'series', items: series!.items, total: series!.total },
    ].filter((r) => r.items.length);
    // the header billboard: a title with a backdrop (newest first)
    const featured = [...news.items, ...popular!.items].find((i) => i.backdrop) ?? news.items[0];
    return { hub: await viewerHub(user, hub), total: news.total, featured, rows };
  }, guard));

  /** A–Z paging */
  app.get('/api/hubs/:id/items', pre, wrap(async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const hub = id.success ? await loadHub(id.data) : undefined;
    if (!hub) return reply.code(404).send({ error: 'not_found' });
    const q = z.object({
      start: z.coerce.number().int().min(0).max(100_000).default(0),
      limit: z.coerce.number().int().min(1).max(60).default(40),
      types: z.enum(['Movie', 'Series', 'Movie,Series']).default('Movie,Series'),
    }).parse(req.query);
    return query(req.jfUser!, hub, { types: q.types, sort: 'SortName', limit: q.limit, start: q.start });
  }, guard));

  // ---- Extras tab: special features + local trailers (visibility = the user can open the item) ----
  const extrasMemo = new Map<string, { exp: number; p: Promise<Array<ItemDto & { kind: 'trailer' | 'extra' }>> }>();
  // a kids flag / age cap change: what this Jellyfin user may see is different now
  onPolicyChange(ctx, (jfId) => {
    for (const m of [visible, extrasMemo] as Array<Map<string, unknown>>) for (const k of [...m.keys()]) if (k.startsWith(`${jfId}|`)) m.delete(k);
  });
  app.get('/api/items/:id/extras/all', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const user = req.jfUser!;
    await ctx.jf.item(user, id); // 404/403 for items the user cannot see; shares the 10 s item memo of the detail page
    const key = `${user.jellyfin_user_id}|${id}`;
    let hit = extrasMemo.get(key);
    if (!hit || hit.exp <= Date.now()) {
      const p = Promise.all([ctx.jf.trailers(user, id), ctx.jf.extras(user, id)]).then(([trailers, extras]) => {
        const seen = new Set<string>();
        return [...trailers.map((i) => ({ ...i, kind: 'trailer' as const })), ...extras.map((i) => ({ ...i, kind: 'extra' as const }))]
          .filter((i) => i.id && !seen.has(i.id) && seen.add(i.id)).slice(0, 60);
      });
      hit = { exp: Date.now() + EXTRAS_TTL_MS, p };
      extrasMemo.set(key, hit);
      p.catch(() => { if (extrasMemo.get(key) === hit) extrasMemo.delete(key); });
      while (extrasMemo.size > EXTRAS_MAX) extrasMemo.delete(extrasMemo.keys().next().value!);
    }
    return { items: await hit.p };
  }, { notFound: [400, 403, 404] }));

  // ---- admin ----
  /** name of the Jellyfin object a hub is built on, plus its image (collections and any chosen item) */
  async function imageFor(req: any, h: { source: SourceKind; sourceValue: string; imageItemId?: string | null }): Promise<{ id: string | null; kind: 'Primary' | 'Backdrop' | null } | 'bad'> {
    let imageId: string | null = h.imageItemId ?? null;
    if (h.source === 'collection') {
      const c = await ctx.jf.item(req.jfUser!, h.sourceValue).catch(() => null);
      if (!c || c.type !== 'BoxSet') return 'bad';
      imageId ??= c.id;
    }
    if (!imageId) return { id: null, kind: null };
    const it = await ctx.jf.item(req.jfUser!, imageId).catch(() => null);
    if (!it) return 'bad';
    // wide tiles: the backdrop reads best, the poster is the fallback; neither = generated gradient
    return it.backdrop ? { id: it.id, kind: 'Backdrop' } : it.image ? { id: it.id, kind: 'Primary' } : { id: null, kind: null };
  }

  app.get('/api/admin/hubs', admin, async () => ({
    max: MAX_HUBS,
    hubs: (await ctx.db.query<HubRow>(`select ${hubCols} from brand_hubs order by sort_order, created_at`)).rows.map(adminHub),
  }));

  /** Ideas from the library: biggest studios / genres and the collections (nothing is created automatically). */
  app.get('/api/admin/hubs/suggestions', admin, wrap(async (req) => {
    const user = req.jfUser!;
    const counted = async (kind: 'studio' | 'genre') => (await ctx.jf.facets(user, kind).catch(() => [])).sort((a, b) => b.count - a.count).slice(0, 12);
    const [studios, genres, collections] = await Promise.all([counted('studio'), counted('genre'), ctx.jf.collections(user).catch(() => [])]);
    const used = new Set((await ctx.db.query<{ k: string }>(`select source_kind || ':' || lower(source_value) k from brand_hubs`)).rows.map((r) => r.k));
    const mark = <T extends { name: string }>(kind: SourceKind, list: T[], value: (x: T) => string) => list.map((x) => ({ ...x, source: kind, sourceValue: value(x), used: used.has(`${kind}:${value(x).toLowerCase()}`) }));
    return {
      suggestions: [
        ...mark('genre', genres, (x) => x.name),
        ...mark('studio', studios, (x) => x.name),
        ...mark('collection', collections.slice(0, 50).map((c) => ({ name: c.name, count: c.childCount ?? 0, id: c.id })), (x) => x.id),
      ],
    };
  }));

  app.post('/api/admin/hubs', adminWrite, wrap(async (req, reply) => {
    const b = hubBody.parse(req.body);
    const n = Number((await ctx.db.query<{ n: string }>('select count(*) n from brand_hubs')).rows[0]!.n);
    if (n >= MAX_HUBS) return reply.code(409).send({ error: 'too_many', max: MAX_HUBS });
    const value = b.source === 'collection' ? id32.parse(b.sourceValue) : b.sourceValue;
    const img = await imageFor(req, { source: b.source, sourceValue: value, imageItemId: b.imageItemId });
    if (img === 'bad') return reply.code(400).send({ error: 'bad_source' });
    const row = (await ctx.db.query<HubRow>(
      `insert into brand_hubs(name, source_kind, source_value, accent, image_item_id, image_kind, sort_order, enabled)
       values ($1,$2,$3,$4,$5,$6,(select coalesce(max(sort_order), -1) + 1 from brand_hubs),$7) returning ${hubCols}`,
      [b.name, b.source, value, b.accent ?? null, img.id, img.kind, b.enabled ?? true])).rows[0]!;
    await audit(ctx, req.user!.id, 'hub.create', row.id, { name: row.name, source: row.source_kind });
    await bumpHomeAll(ctx);
    return reply.code(201).send({ hub: adminHub(row) });
  }, guard));

  // before `/:id`: same method, static segment wins anyway
  app.put('/api/admin/hubs/order', adminWrite, wrap(async (req, reply) => {
    const b = z.object({ ids: z.array(uuid).min(1).max(MAX_HUBS) }).parse(req.body);
    const known = new Set((await ctx.db.query<{ id: string }>('select id from brand_hubs')).rows.map((r) => r.id));
    if (b.ids.some((i) => !known.has(i)) || new Set(b.ids).size !== b.ids.length) return reply.code(400).send({ error: 'bad_request' });
    await ctx.db.query('update brand_hubs h set sort_order = o.n from (select id, (ord - 1)::int n from unnest($1::uuid[]) with ordinality t(id, ord)) o where h.id = o.id', [b.ids]);
    await audit(ctx, req.user!.id, 'hub.order', undefined, { ids: b.ids });
    await bumpHomeAll(ctx);
    return { ok: true };
  }, guard));

  app.put('/api/admin/hubs/:id', adminWrite, wrap(async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const cur = id.success ? await loadHub(id.data, false) : undefined;
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const b = hubBody.parse(req.body);
    const value = b.source === 'collection' ? id32.parse(b.sourceValue) : b.sourceValue;
    const img = await imageFor(req, { source: b.source, sourceValue: value, imageItemId: b.imageItemId });
    if (img === 'bad') return reply.code(400).send({ error: 'bad_source' });
    const row = (await ctx.db.query<HubRow>(
      `update brand_hubs set name=$2, source_kind=$3, source_value=$4, accent=$5, image_item_id=$6, image_kind=$7, enabled=$8 where id=$1 returning ${hubCols}`,
      [cur.id, b.name, b.source, value, b.accent ?? null, img.id, img.kind, b.enabled ?? cur.enabled])).rows[0]!;
    visible.clear();
    await bumpHomeAll(ctx);
    await audit(ctx, req.user!.id, 'hub.update', row.id, { name: row.name, source: row.source_kind, enabled: row.enabled });
    return { hub: adminHub(row) };
  }, guard));

  app.delete('/api/admin/hubs/:id', adminWrite, async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const gone = id.success ? (await ctx.db.query('delete from brand_hubs where id = $1', [id.data])).rowCount : 0;
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    visible.clear();
    await bumpHomeAll(ctx);
    await audit(ctx, req.user!.id, 'hub.delete', id.success ? id.data : undefined);
    return { ok: true };
  });

  return { viewerHubs };
}
