import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { MediaError } from '../media/types.js';
import { MAX_FEATURED, MAX_FEATURED_ITEMS, MAX_ITEMS, MAX_MEMBERS, MAX_OWNED, canEdit, isFeatured, listRole, type ListAccess, type ListRole } from '../lists.js';
import { m } from '../i18n.js';
import { notify } from '../notify.js';
import { requireGrownUp } from '../kids.js';
import { itemsByIds } from './discover.js';
import { id32 } from './_shared.js';

const uuid = z.string().uuid();

export function listRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireGrownUp(ctx) }; // shared lists are social: kids profiles get 403 kids_profile
  const limited = { ...pre, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  /** Parses :id and resolves the caller's role; unknown id / non-member -> 404 (never reveals existence). */
  async function access(req: any, reply: any): Promise<{ id: string; role: ListRole } | null> {
    const parsed = uuid.safeParse(req.params.id);
    const role = parsed.success ? await listRole(ctx, parsed.data, req.user!.id) : null;
    if (!parsed.success || !role) { reply.code(404).send({ error: 'not_found' }); return null; }
    return { id: parsed.data, role };
  }

  app.get('/api/lists/featured', pre, async (req) => {
    const ls = (await ctx.db.query<{ id: string; name: string; description: string | null; owner_name: string }>(
      `select l.id, l.name, l.description, o.name as owner_name from lists l join users o on o.id = l.owner_id
        where l.featured_at is not null order by l.featured_at desc limit $1`, [MAX_FEATURED])).rows;
    const ids = new Map<string, string[]>();
    for (const l of ls) {
      ids.set(l.id, (await ctx.db.query<{ item_id: string }>('select item_id from list_items where list_id = $1 order by added_at desc limit 80', [l.id])).rows.map((x) => x.item_id));
    }
    const byId = new Map((await itemsByIds(ctx, req.jfUser!, [...new Set([...ids.values()].flat())]).catch(() => [])).map((i) => [i.id, i]));
    const lists = ls.map((l) => ({
      id: l.id, name: l.name, description: l.description, owner: { name: l.owner_name },
      items: ids.get(l.id)!.map((i) => byId.get(i)).filter((x): x is NonNullable<typeof x> => Boolean(x)).slice(0, MAX_FEATURED_ITEMS),
    })).filter((l) => l.items.length > 0);
    return { lists };
  });

  app.get('/api/lists', pre, async (req) => {
    const uid = req.user!.id;
    const rows = (await ctx.db.query<{ id: string; name: string; description: string | null; owner_id: string; owner_name: string; role: ListRole; item_count: string; member_count: string; updated_at: Date }>(
      `select l.id, l.name, l.description, l.owner_id, o.name as owner_name,
              case when l.owner_id = $1 then 'owner' else m.role end as role,
              (select count(*) from list_items i where i.list_id = l.id) as item_count,
              (select count(*) from list_members x where x.list_id = l.id) + 1 as member_count,
              l.updated_at
         from lists l join users o on o.id = l.owner_id left join list_members m on m.list_id = l.id and m.user_id = $1
        where l.owner_id = $1 or m.user_id = $1
        order by l.updated_at desc`, [uid])).rows;
    const cand = new Map<string, string[]>();
    for (const r of rows) {
      cand.set(r.id, (await ctx.db.query<{ item_id: string }>('select item_id from list_items where list_id = $1 order by added_at desc limit 8', [r.id])).rows.map((x) => x.item_id));
    }
    const visible = new Set((await itemsByIds(ctx, req.jfUser!, [...new Set([...cand.values()].flat())]).catch(() => [])).map((i) => i.id));
    return {
      lists: rows.map((r) => ({
        id: r.id, name: r.name, description: r.description, owner: { id: r.owner_id, name: r.owner_name }, role: r.role,
        itemCount: Number(r.item_count), memberCount: Number(r.member_count), updatedAt: r.updated_at,
        coverIds: (cand.get(r.id) ?? []).filter((i) => visible.has(i)).slice(0, 4),
      })),
    };
  });

  app.post('/api/lists', limited, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(280).optional() }).parse(req.body);
    const n = Number((await ctx.db.query<{ c: string }>('select count(*) c from lists where owner_id = $1', [req.user!.id])).rows[0]!.c);
    if (n >= MAX_OWNED) return reply.code(409).send({ error: 'too_many_lists' });
    const id = randomUUID();
    await ctx.db.query('insert into lists(id, owner_id, name, description) values ($1,$2,$3,$4)', [id, req.user!.id, b.name, b.description || null]);
    return { id };
  });

  app.get('/api/lists/:id', pre, async (req, reply) => {
    // members see everything; anyone else may read a featured list (read-only, 'guest'); otherwise 404
    const parsed = uuid.safeParse((req.params as { id: string }).id);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const role: ListAccess | null = (await listRole(ctx, parsed.data, req.user!.id)) ?? ((await isFeatured(ctx, parsed.data)) ? 'guest' : null);
    if (!role) return reply.code(404).send({ error: 'not_found' });
    const a = { id: parsed.data, role };
    const l = (await ctx.db.query<{ id: string; name: string; description: string | null; owner_id: string; owner_name: string }>(
      'select l.id, l.name, l.description, l.owner_id, o.name as owner_name from lists l join users o on o.id = l.owner_id where l.id = $1', [a.id])).rows[0]!;
    const members = (await ctx.db.query<{ id: string; name: string; role: ListRole }>(
      'select u.id, u.name, m.role from list_members m join users u on u.id = m.user_id where m.list_id = $1 order by m.added_at', [a.id])).rows;
    const rows = (await ctx.db.query<{ item_id: string; note: string | null; added_at: Date; by_id: string | null; by_name: string | null }>(
      `select i.item_id, i.note, i.added_at, u.id as by_id, u.name as by_name from list_items i left join users u on u.id = i.added_by
        where i.list_id = $1 order by i.added_at desc`, [a.id])).rows;
    let items;
    try {
      items = await itemsByIds(ctx, req.jfUser!, rows.map((r) => r.item_id), true);
    } catch {
      return reply.code(502).send({ error: 'jellyfin_unavailable' }); // not "everything hidden"
    }
    const meta = new Map(rows.map((r) => [r.item_id, r]));
    return {
      list: { id: l.id, name: l.name, description: l.description, owner: { id: l.owner_id, name: l.owner_name }, role: a.role },
      members: a.role === 'guest' ? [{ id: l.owner_id, name: l.owner_name, role: 'owner' }] : [{ id: l.owner_id, name: l.owner_name, role: 'owner' }, ...members],
      items: items.map((i) => {
        const m = meta.get(i.id)!;
        return { ...i, addedBy: m.by_id ? { id: m.by_id, name: m.by_name! } : null, addedAt: m.added_at, note: m.note };
      }),
      hiddenCount: rows.length - items.length,
    };
  });

  app.patch('/api/lists/:id', pre, async (req, reply) => {
    const a = await access(req, reply);
    if (!a) return;
    if (a.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(280).nullable().optional() }).parse(req.body);
    await ctx.db.query(
      `update lists set name = coalesce($2, name), description = case when $3::boolean then $4 else description end, updated_at = now() where id = $1`,
      [a.id, b.name ?? null, b.description !== undefined, b.description || null],
    );
    return { ok: true };
  });

  app.delete('/api/lists/:id', pre, async (req, reply) => {
    const a = await access(req, reply);
    if (!a) return;
    if (a.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
    await ctx.db.query('delete from lists where id = $1', [a.id]);
    return { ok: true };
  });

  app.put('/api/lists/:id/members/:userId', pre, async (req, reply) => {
    const a = await access(req, reply);
    if (!a) return;
    if (a.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
    const target = uuid.safeParse((req.params as { userId: string }).userId);
    const { role } = z.object({ role: z.enum(['editor', 'viewer']) }).parse(req.body);
    if (!target.success || target.data === req.user!.id) return reply.code(400).send({ error: 'bad_member' });
    const u = (await ctx.db.query('select 1 from users where id = $1 and not disabled', [target.data])).rowCount;
    if (!u) return reply.code(400).send({ error: 'bad_member' });
    const existing = (await ctx.db.query('select 1 from list_members where list_id = $1 and user_id = $2', [a.id, target.data])).rowCount;
    if (!existing) {
      const n = Number((await ctx.db.query<{ c: string }>('select count(*) c from list_members where list_id = $1', [a.id])).rows[0]!.c);
      if (n + 1 >= MAX_MEMBERS) return reply.code(409).send({ error: 'too_many_members' });
    }
    await ctx.db.query(
      'insert into list_members(list_id, user_id, role) values ($1,$2,$3) on conflict (list_id, user_id) do update set role = excluded.role',
      [a.id, target.data, role],
    );
    const name = (await ctx.db.query<{ name: string }>('select name from lists where id = $1', [a.id])).rows[0]!.name;
    await notify(ctx, { userId: target.data, kind: 'list_invite', title: m('list.invite', { name: req.user!.name, list: name }), link: `/lists/${a.id}`, dedupe: `list-inv-${a.id}-${target.data}` });
    return { ok: true };
  });

  app.delete('/api/lists/:id/members/:userId', pre, async (req, reply) => {
    const a = await access(req, reply);
    if (!a) return;
    const target = uuid.safeParse((req.params as { userId: string }).userId);
    if (!target.success) return reply.code(400).send({ error: 'bad_member' });
    if (a.role !== 'owner' && target.data !== req.user!.id) return reply.code(403).send({ error: 'forbidden' });
    if (target.data === req.user!.id && a.role === 'owner') return reply.code(400).send({ error: 'owner_cannot_leave' });
    await ctx.db.query('delete from list_members where list_id = $1 and user_id = $2', [a.id, target.data]);
    return { ok: true };
  });

  app.post('/api/lists/:id/items', limited, async (req, reply) => {
    const a = await access(req, reply);
    if (!a) return;
    if (!canEdit(a.role)) return reply.code(403).send({ error: 'forbidden' });
    const b = z.object({ itemId: id32, note: z.string().trim().max(140).optional() }).parse(req.body);
    let item;
    try {
      item = await ctx.jf.item(req.jfUser!, b.itemId); // proves the caller can see it
      if (item.type === 'Episode' && item.seriesId) item = await ctx.jf.item(req.jfUser!, item.seriesId);
    } catch (e) {
      if (e instanceof MediaError) return reply.code(404).send({ error: 'not_found' });
      throw e;
    }
    if (item.type !== 'Movie' && item.type !== 'Series') return reply.code(400).send({ error: 'bad_type' });
    const n = Number((await ctx.db.query<{ c: string }>('select count(*) c from list_items where list_id = $1', [a.id])).rows[0]!.c);
    if (n >= MAX_ITEMS) return reply.code(409).send({ error: 'list_full' });
    const r = await ctx.db.query(
      'insert into list_items(list_id, item_id, item_name, note, added_by) values ($1,$2,$3,$4,$5) on conflict do nothing returning item_id',
      [a.id, item.id, item.name, b.note || null, req.user!.id],
    );
    if (!r.rowCount) return reply.code(409).send({ error: 'exists' });
    await ctx.db.query('update lists set updated_at = now() where id = $1', [a.id]);
    return { ok: true, itemId: item.id };
  });

  app.delete('/api/lists/:id/items/:itemId', pre, async (req, reply) => {
    const a = await access(req, reply);
    if (!a) return;
    if (!canEdit(a.role)) return reply.code(403).send({ error: 'forbidden' });
    const itemId = id32.parse((req.params as { itemId: string }).itemId);
    const r = await ctx.db.query('delete from list_items where list_id = $1 and item_id = $2', [a.id, itemId]);
    if (r.rowCount) await ctx.db.query('update lists set updated_at = now() where id = $1', [a.id]);
    return { ok: true };
  });

  app.get('/api/items/:id/lists', pre, async (req) => {
    const itemId = id32.parse((req.params as { id: string }).id);
    const rows = (await ctx.db.query<{ id: string; name: string; role: ListRole; contains: boolean }>(
      `select l.id, l.name, case when l.owner_id = $1 then 'owner' else m.role end as role,
              exists(select 1 from list_items i where i.list_id = l.id and i.item_id = $2) as contains
         from lists l left join list_members m on m.list_id = l.id and m.user_id = $1
        where l.owner_id = $1 or m.role = 'editor' order by l.updated_at desc`, [req.user!.id, itemId])).rows;
    return { lists: rows.map((r) => ({ id: r.id, name: r.name, contains: r.contains, canEdit: true })) };
  });
}
