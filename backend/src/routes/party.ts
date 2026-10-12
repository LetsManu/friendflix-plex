import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { bus } from '../bus.js';
import type { Ctx } from '../ctx.js';
import { clientMsg, PartyRegistry } from '../party.js';
import { randomToken } from '../crypto.js';
import { authenticate } from '../session.js';
import { isKidsProfile, requireGrownUp } from '../kids.js';
import { m } from '../i18n.js';
import { notify } from '../notify.js';
import type { JfUser } from '../types.js';
import { itemsByIds } from './discover.js';

export const parties = new PartyRegistry();

export async function partyRoutes(app: FastifyInstance, ctx: Ctx) {
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const pre = { preHandler: requireGrownUp(ctx) }; // no watch parties on kids profiles
  const origin = new URL(ctx.cfg.PUBLIC_URL).origin;

  const roomInfo = (r: ReturnType<PartyRegistry['get']> & object) => ({
    id: r.id, itemId: r.itemId, title: r.title, hostId: r.hostId, members: r.members.size, startAt: r.startAt,
    hostName: r.members.get(r.hostId)?.name,
  });

  app.post('/api/party', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = z.object({ itemId: z.string().regex(/^[0-9a-f]{32}$/), startInMinutes: z.number().int().min(1).max(24 * 60).optional() }).parse(req.body);
    // Scheduled rooms (not yet started) per host are capped; admins are exempt. Instant rooms start at once and do not count.
    if (b.startInMinutes && req.user!.role !== 'admin') {
      const now = Date.now();
      const pending = [...parties.rooms.values()].filter((r) => r.hostId === req.user!.id && !r.started && r.startAt !== undefined && r.startAt > now).length;
      if (pending >= 3) return reply.code(429).send({ error: 'too_many_parties', max: 3 });
    }
    let item;
    try {
      item = await ctx.jf.item(req.jfUser!, b.itemId); // also proves the creator may access it
    } catch {
      return reply.code(404).send({ error: 'item_not_found' });
    }
    const title = item.seriesName ? `${item.seriesName} – ${item.name}` : item.name;
    const room = parties.create({ id: randomToken(9), itemId: item.id, title, hostId: req.user!.id, startAt: b.startInMinutes ? Date.now() + b.startInMinutes * 60_000 : undefined });
    await audit(ctx, req.user!.id, 'party.create', room.id, { title });
    return { id: room.id };
  });

  type Room = NonNullable<ReturnType<PartyRegistry['get']>>;
  const involved = (r: Room, userId: string) => r.hostId === userId || r.members.has(userId);
  /** Item visibility is always checked with the viewer's own token; host/members always keep access to their room. */
  const visibleRooms = async (jfUser: JfUser, userId: string, rooms: Room[]) => {
    const need = [...new Set(rooms.filter((r) => !involved(r, userId)).map((r) => r.itemId))];
    const seen = new Set((need.length ? await itemsByIds(ctx, jfUser, need) : []).map((i) => i.id));
    return rooms.filter((r) => involved(r, userId) || seen.has(r.itemId));
  };

  app.get('/api/party', pre, async (req) => ({ rooms: (await visibleRooms(req.jfUser!, req.user!.id, [...parties.rooms.values()])).map(roomInfo) }));
  // One tap invitation: friends get an in-app notification (and ntfy/Discord if configured) that opens the room.
  app.post('/api/party/:id/invite', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = parties.get((req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.members.has(req.user!.id)) return reply.code(403).send({ error: 'not_in_room' });
    const b = z.object({ userIds: z.array(z.guid()).min(1).max(15) }).parse(req.body);
    const targets = (await ctx.db.query<JfUser>('select id, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc from users where id = any($1) and id <> $2 and not disabled', [b.userIds, req.user!.id])).rows;
    let sent = 0;
    for (const t of targets) {
      // The notification text carries the title, so only invite users whose own Jellyfin account can see the item (fail closed).
      const canSee = (await itemsByIds(ctx, t, [r.itemId]).catch(() => [])).some((i) => i.id === r.itemId);
      if (!canSee) continue;
      if (await notify(ctx, { userId: t.id, kind: 'party_invite', title: m('party.invite', { name: req.user!.name, title: r.title }), link: `/party/${r.id}`, dedupe: `party-${r.id}-${t.id}`, external: true })) sent++;
    }
    return { sent };
  });
  app.get('/api/party/:id', pre, async (req, reply) => {
    const r = parties.get((req.params as { id: string }).id);
    if (!r || !(await visibleRooms(req.jfUser!, req.user!.id, [r])).length) return reply.code(404).send({ error: 'not_found' });
    return roomInfo(r);
  });

  app.get('/ws/party/:id', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (socket, req) => {
    // Cross-site WebSocket hijacking guard: browsers always send Origin on WS handshakes.
    if (req.headers.origin !== origin || !(await authenticate(ctx, req)) || !req.session!.deviceApproved) return socket.close(4401, 'unauthorized');
    if (isKidsProfile(req)) return socket.close(4403, 'kids profile');
    const room = parties.get((req.params as { id: string }).id);
    if (!room) return socket.close(4404, 'room not found');
    if (room.members.size >= 20 && !room.members.has(req.user!.id)) return socket.close(4409, 'room full');
    const user = req.user!;
    if (!req.jfUser || !(await visibleRooms(req.jfUser, user.id, [room])).length) return socket.close(4404, 'room not found'); // joiner must be able to see the item
    const send = (m: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(m));
    room.join(user.id, user.name, send);
    bus.emitT('party.join', { userId: user.id, roomId: room.id });

    let alive = true;
    socket.on('pong', () => (alive = true));
    const hb = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('message', (raw: Buffer) => {
      let parsed;
      try {
        parsed = clientMsg.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      room.handle(user.id, parsed.data);
      if (parsed.data.t === 'chat') bus.emitT('party.chat', { userId: user.id, roomId: room.id });
    });
    socket.on('close', () => {
      clearInterval(hb);
      // only remove if this socket is still the current one for the member
      const m = room.members.get(user.id);
      if (m && m.send === send) room.leave(user.id);
    });
  });
}
