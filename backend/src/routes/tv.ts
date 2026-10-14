// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { FALLBACK_LANGUAGE, instanceLanguage, m, msg, userLanguage } from '../i18n.js';
import { notify } from '../notify.js';
import { COOKIE, newSession, rand, requireUser, saveSession, authenticate } from '../session.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: readable from across the room
const TTL = 600;
const TV_SESSION_SECONDS = 30 * 86400;
const TV_IDLE_SECONDS = 7 * 86400;

const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (s: string) => createHash('sha256').update(s).digest();
const newCode = () => Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const show = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** the subset of the ws socket we use */
interface Sock { readyState: number; send(data: string): void; close(code?: number, reason?: string): void }
interface Peer { ws: Sock; role: 'tv' | 'remote'; sid: string; msgs: number[] }
/** pair/claim read-modify-write the same kv key: serialise them per code (single backend replica) */
const busy = new Set<string>();
const peers = new Map<string, Set<Peer>>(); // userId -> sockets

const toTv = z.discriminatedUnion('t', [
  z.object({ t: z.literal('cast'), itemId: z.string().regex(/^[0-9a-f]{32}$/), startSec: z.number().int().min(0).max(86_400).optional() }),
  z.object({ t: z.literal('ctl'), action: z.enum(['play', 'pause', 'toggle', 'seekBy', 'stop', 'home', 'next', 'audio', 'sub']), value: z.number().min(-3600).max(3600).optional() }),
]);
const track = z.object({ i: z.number().int().min(0).max(200), t: z.string().max(40) });
const fromTv = z.object({
  t: z.literal('status'), itemId: z.string().regex(/^[0-9a-f]{32}$/).optional(), title: z.string().max(200).optional(),
  position: z.number().min(0).max(1e6).optional(),
  // track lists let the phone pick audio/subtitles (bounded: the socket payload limit is 4 KB)
  audio: z.array(track).max(10).optional(), subs: z.array(track).max(16).optional(), audioSel: z.number().int().min(0).max(200).optional(), subSel: z.number().int().min(-1).max(200).optional(),
  duration: z.number().min(0).max(1e6).optional(), paused: z.boolean().optional(),
});

/** Closes the sockets of revoked sessions (device removed, "log out everywhere", user disabled): a revoked TV must not stay connected. */
export function dropRemotePeers(userId: string, sids: Set<string>) {
  for (const p of [...(peers.get(userId) ?? [])]) if (sids.has(p.sid)) p.ws.close(4401, 'revoked');
}

/** A profile switch rotates the session id: keep the already connected sockets of the old sid alive under the new one. */
export function renamePeerSid(userId: string, oldSid: string, newSid: string) {
  for (const p of peers.get(userId) ?? []) if (p.sid === oldSid) p.sid = newSid;
}

export const tvOnline = (userId: string) => [...(peers.get(userId) ?? [])].some((p) => p.role === 'tv');

export function tvRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.cfg.PUBLIC_URL.startsWith('https://');
  const origin = new URL(ctx.cfg.PUBLIC_URL).origin;

  // 1) The TV asks for a code (unauthenticated, rate limited) and polls with a secret it alone knows.
  app.post('/api/tv/code', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    const code = newCode();
    const pollToken = rand();
    await ctx.kv.set(`tvpair:${code}`, JSON.stringify({ poll: hash(pollToken).toString('hex'), userId: null }), TTL);
    // defaultLanguage: a fresh TV without a stored UI language shows the pairing screen in the instance language (or the browser's)
    return { code: show(code), pollToken, expiresIn: TTL, defaultLanguage: (await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE };
  });

  // 2) A logged-in user confirms the code shown on the TV.
  app.post('/api/tv/pair', { preHandler: requireUser(ctx), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { code } = z.object({ code: z.string().min(8).max(12) }).parse(req.body);
    const key = `tvpair:${norm(code)}`;
    if (busy.has(key)) return reply.code(409).send({ error: 'code_already_used' });
    busy.add(key);
    try {
      const raw = await ctx.kv.get(key);
      if (!raw) return reply.code(404).send({ error: 'code_invalid_or_expired' });
      const rec = JSON.parse(raw) as { poll: string; userId: string | null };
      if (rec.userId) return reply.code(409).send({ error: 'code_already_used' });
      // a kids profile pairs a kids TV: the new device is locked to it (it must never fall back to the owner profile)
      const kidsProfileId = req.profile?.kids ? req.profile.id : null;
      await ctx.kv.set(key, JSON.stringify({ ...rec, userId: req.user!.id, kidsProfileId }), 120);
      await audit(ctx, req.user!.id, 'tv.pair', undefined);
      return { ok: true };
    } finally { busy.delete(key); }
  });

  // 3) The TV claims its session once the code is confirmed.
  app.post('/api/tv/claim', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ code: z.string().min(8).max(12), pollToken: z.string().min(20).max(100) }).parse(req.body);
    const key = `tvpair:${norm(b.code)}`;
    const raw = await ctx.kv.get(key);
    if (!raw) return reply.code(404).send({ error: 'code_invalid_or_expired' });
    const rec = JSON.parse(raw) as { poll: string; userId: string | null; kidsProfileId?: string | null };
    const a = Buffer.from(hash(b.pollToken).toString('hex')), c = Buffer.from(rec.poll);
    if (a.length !== c.length || !timingSafeEqual(a, c)) return reply.code(403).send({ error: 'forbidden' });
    if (!rec.userId) return reply.code(202).send({ status: 'pending' });
    // single use, atomically: of several concurrent valid claims only one takes the code (checked only after the pollToken matched, so a wrong token never burns it)
    if (!(await ctx.kv.take(key))) return reply.code(404).send({ error: 'code_invalid_or_expired' });
    const user = (await ctx.db.query<{ id: string; disabled: boolean }>('select id, disabled from users where id=$1', [rec.userId])).rows[0];
    if (!user || user.disabled) return reply.code(403).send({ error: 'forbidden' });
    const deviceId = `tv-${randomBytes(18).toString('base64url')}`;
    // the kids profile must still exist and still be a kids profile of this account, else the pairing is void (no owner fallback)
    const kid = rec.kidsProfileId
      ? (await ctx.db.query<{ id: string }>('select id from profiles where id=$1 and user_id=$2 and kids', [rec.kidsProfileId, user.id])).rows[0]
      : undefined;
    if (rec.kidsProfileId && !kid) return reply.code(403).send({ error: 'forbidden' });
    await ctx.db.query('insert into devices(user_id, device_id, label, approved, kids_profile_id) values ($1,$2,$3,true,$4)',
      [user.id, deviceId, msg(await userLanguage(ctx, user.id), 'device.tv'), kid?.id ?? null]);
    const sid = rand();
    await saveSession(ctx, sid, newSession({ userId: user.id, csrf: rand(), deviceId, deviceApproved: true, ttl: TV_SESSION_SECONDS, idle: TV_IDLE_SECONDS, ...(kid ? { profileId: kid.id } : {}) }));
    reply.setCookie(COOKIE, sid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: TV_SESSION_SECONDS });
    await audit(ctx, user.id, 'tv.claim', user.id, { deviceId });
    // somebody could have talked the user into confirming a stranger's code: make a new TV visible and easy to revoke
    await notify(ctx, { userId: user.id, kind: 'tv_paired', title: m('tv.paired.title'), body: m('tv.paired.body'), link: '/devices' });
    return { status: 'ok' };
  });

  app.get('/api/tv/status', { preHandler: requireUser(ctx) }, async (req) => ({ tvOnline: tvOnline(req.user!.id) }));

  // Remote-control hub: phone <-> TV of the SAME user (never across users).
  app.get('/ws/remote', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (socket, req) => {
    if (req.headers.origin !== origin || !(await authenticate(ctx, req)) || !req.session!.deviceApproved) return socket.close(4401, 'unauthorized');
    const role = (req.query as { role?: string }).role === 'tv' ? 'tv' : 'remote';
    // only a paired television may register as the TV: a laptop must not be able to evict the real one
    if (role === 'tv' && !req.session!.deviceId?.startsWith('tv-')) return socket.close(4403, 'not_a_tv');
    const uid = req.user!.id;
    const peer: Peer = { ws: socket as unknown as Sock, role, sid: req.sid!, msgs: [] };
    const set = peers.get(uid) ?? new Set<Peer>();
    peers.set(uid, set);
    if (role === 'tv') for (const p of [...set]) if (p.role === 'tv') p.ws.close(4000, 'replaced'); // one TV per user
    if (role === 'remote' && [...set].filter((p) => p.role === 'remote').length >= 8) return socket.close(4429, 'too_many'); // a user needs a handful of phones, not hundreds
    set.add(peer);
    const send = (p: Peer, m: unknown) => p.ws.readyState === 1 && p.ws.send(JSON.stringify(m));
    const announce = () => { const on = [...set].some((p) => p.role === 'tv'); for (const p of set) if (p.role === 'remote') send(p, { t: 'peers', tvOnline: on }); };
    announce();
    send(peer, { t: 'hello', role, tvOnline: [...set].some((p) => p.role === 'tv') });

    socket.on('message', (raw: Buffer) => {
      const now = Date.now();
      peer.msgs = peer.msgs.filter((x) => now - x < 1000);
      if (peer.msgs.length >= 20) return; // flood protection
      peer.msgs.push(now);
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return; }
      if (peer.role === 'remote') {
        const m = toTv.safeParse(json);
        if (m.success) for (const p of set) if (p.role === 'tv') send(p, m.data);
      } else {
        const m = fromTv.safeParse(json);
        if (m.success) for (const p of set) if (p.role === 'remote') send(p, m.data);
      }
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => { set.delete(peer); if (!set.size) peers.delete(uid); else announce(); });
  });
}
