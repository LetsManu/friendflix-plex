import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { hashPin, verifyPin } from '../crypto.js';
import { MAX_PROFILES, ProfileError, createProfile, deleteProfile, getProfile, listProfiles, publicProfile, setDeviceKids } from '../profiles.js';
import { COOKIE, rand, requireUser, saveSession, type Session } from '../session.js';
import type { ProfileRow } from '../types.js';
import { policyChanged } from '../hooks.js';
import { applyRole } from '../users.js';
import { forgetAuth } from './internal.js';
import { renamePeerSid } from './tv.js';

const PIN_FAIL_TTL = 15 * 60;
const PIN_MAX_FAILS = 5;
const ACCOUNT_MAX_FAILS = 15;
/** old sid stays valid this long after a profile switch so in-flight requests of the tab do not 401 */
const OLD_SID_GRACE = 15;

const name = z.string().trim().min(1).max(20);
const avatar = z.string().regex(/^[a-z0-9-]{1,20}$/);
const pin = z.string().regex(/^\d{4}$/);
const uuid = z.guid();
/** parental cap of a kids profile (KIDS_RATINGS) */
const maxRating = z.union([z.literal(0), z.literal(6), z.literal(12)]);

export function profileRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.cfg.PUBLIC_URL.startsWith('https://');
  const pre = { preHandler: requireUser(ctx, { allowNoProfile: true, skipProfileHeader: true }) };

  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ProfileError) return reply.code(e.status).send({ error: e.code });
    throw e;
  };
  /** Other sessions of the account that sit on this profile lose it (PIN changed / profile deleted) and re-resolve on their next request. */
  const dropProfile = async (userId: string, profileId: string, exceptSid?: string) => {
    for (const k of await ctx.kv.keys('sess:')) {
      const sid = k.slice('sess:'.length);
      if (sid === exceptSid) continue;
      const raw = await ctx.kv.get(k);
      if (!raw) continue;
      const sess = JSON.parse(raw) as Session;
      if (sess.userId !== userId || sess.profileId !== profileId) continue;
      delete sess.profileId;
      await saveSession(ctx, sid, sess, true);
      forgetAuth(sid);
    }
  };
  const ownerActive = (req: FastifyRequest) => Boolean(req.profile?.is_owner);

  /**
   * Leaving a kids profile (the active one; a fresh login on a kid's device resolves to it too, see resolveProfile):
   * every other profile needs its own PIN, a profile without one the owner profile's PIN. Without any PIN the switch is
   * allowed (nothing to check against), the profiles page asks the owner to set one.
   */
  const kidsLock = (req: FastifyRequest): ProfileRow | null => (req.profile?.kids ? req.profile : null);
  const unlockBy = (lock: ProfileRow | null, owner: ProfileRow | undefined, p: ProfileRow): 'owner' | null =>
    lock && p.id !== lock.id && !p.pin_hash && owner?.pin_hash ? 'owner' : null;

  app.get('/api/profiles', pre, async (req) => {
    const all = await listProfiles(ctx, req.user!.id);
    const owner = all.find((p) => p.is_owner), lock = kidsLock(req);
    return {
      profiles: all.map((p) => ({ ...publicProfile(p), hasPin: Boolean(p.pin_hash), active: p.id === req.profile?.id, ...(unlockBy(lock, owner, p) ? { unlock: 'owner' as const } : {}) })),
      max: MAX_PROFILES,
      activeId: req.profile?.id ?? null,
      /** the kids profile switching away from needs a PIN */
      kidsLock: lock?.id ?? null,
      /** there is a kids profile but no PIN at all guards leaving it (hint for the owner) */
      kidsUnguarded: all.some((p) => p.kids) && !owner?.pin_hash,
    };
  });

  app.post('/api/profiles', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = z.object({ name, avatar: avatar.optional(), pin: pin.nullish(), kids: z.boolean().optional(), maxRating: maxRating.optional() }).parse(req.body);
    if (!ownerActive(req)) return reply.code(403).send({ error: 'owner_required' });
    try {
      const p = await createProfile(ctx, req.user!, { name: b.name, avatar: b.avatar, pin: b.pin, kids: b.kids, maxRating: b.maxRating });
      await audit(ctx, req.user!.id, 'profile.create', p.id, { name: p.name, ...(p.kids ? { kids: true, maxRating: p.kids_max_rating } : {}) });
      return reply.code(201).send({ profile: { ...publicProfile(p), hasPin: Boolean(p.pin_hash), active: false } });
    } catch (e) {
      return send(reply, e);
    }
  });

  /** owner profile manages everyone, every other profile only itself */
  const manageable = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const p = await getProfile(ctx, req.user!.id, id);
    if (!p) { reply.code(404).send({ error: 'not_found' }); return null; }
    if (!ownerActive(req) && req.profile?.id !== p.id) { reply.code(403).send({ error: 'forbidden' }); return null; }
    return p;
  };

  app.patch('/api/profiles/:id', pre, async (req, reply) => {
    const b = z.object({ name: name.optional(), avatar: avatar.optional(), kids: z.boolean().optional(), maxRating: maxRating.optional() }).parse(req.body);
    const p = await manageable(req, reply);
    if (!p) return;
    const kidsChange = (b.kids !== undefined && b.kids !== p.kids) || (b.maxRating !== undefined && b.maxRating !== p.kids_max_rating);
    if (kidsChange) {
      // only the owner profile turns kids mode on/off or changes the cap (a kid cannot free itself); the owner profile is never a kids profile
      if (!ownerActive(req)) return reply.code(403).send({ error: 'owner_required' });
      if (p.is_owner || !p.jellyfin_user_id) return reply.code(400).send({ error: 'owner_not_kids' });
    }
    if (b.name && (await ctx.db.query('select 1 from profiles where user_id=$1 and lower(name)=lower($2) and id<>$3', [req.user!.id, b.name, p.id])).rowCount) {
      return reply.code(409).send({ error: 'name_taken' });
    }
    try {
      const r = await ctx.db.query(
        'update profiles set name=coalesce($2,name), avatar=coalesce($3,avatar), kids=coalesce($4,kids), kids_max_rating=coalesce($5,kids_max_rating) where id=$1 returning *',
        [p.id, b.name ?? null, b.avatar ?? null, kidsChange ? (b.kids ?? null) : null, kidsChange ? (b.maxRating ?? null) : null],
      );
      const u = r.rows[0] as typeof p;
      if (kidsChange) {
        // the cap lives in the Jellyfin policy of the profile's user (enforced by Jellyfin for every item, list, search and stream)
        try {
          await applyRole(ctx, u.jellyfin_user_id!, req.user!.role, req.user!.disabled, { IsHidden: true });
        } catch {
          await ctx.db.query('update profiles set kids=$2, kids_max_rating=$3 where id=$1', [p.id, p.kids, p.kids_max_rating]);
          return reply.code(502).send({ error: 'jellyfin' });
        }
        await policyChanged(ctx, u.jellyfin_user_id!); // cached rows / hubs / items of the old policy must not be served again
        await audit(ctx, req.user!.id, 'profile.kids', p.id, { kids: u.kids, maxRating: u.kids_max_rating });
      }
      return { profile: { ...publicProfile(u), hasPin: Boolean(u.pin_hash), active: u.id === req.profile?.id } };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'name_taken' });
      throw e;
    }
  });

  /**
   * Checks a PIN. The attempt is counted atomically BEFORE verifying (concurrent guesses cannot race past the limit):
   * 5 attempts per profile and 15 per account within 15 minutes; beyond that the PIN is not even verified.
   * The 5th wrong attempt already answers 429. A correct PIN resets the profile counter.
   */
  const checkPin = async (userId: string, p: { id: string; pin_hash: string | null }, given: string | undefined): Promise<'ok' | 'locked' | 'wrong' | 'missing'> => {
    if (!given) return Number((await ctx.kv.get(`pinfail:${p.id}`)) ?? 0) >= PIN_MAX_FAILS ? 'locked' : 'missing';
    const n = await ctx.kv.incr(`pinfail:${p.id}`, PIN_FAIL_TTL);
    const acct = await ctx.kv.incr(`pinfail-acct:${userId}`, PIN_FAIL_TTL);
    if (n > PIN_MAX_FAILS || acct > ACCOUNT_MAX_FAILS) return 'locked';
    if (verifyPin(given, p.pin_hash!)) {
      await ctx.kv.del(`pinfail:${p.id}`);
      return 'ok';
    }
    return n >= PIN_MAX_FAILS ? 'locked' : 'wrong';
  };
  /** `pinOf: 'owner'`: the owner profile's PIN was asked for (leaving a kids profile towards a profile without PIN) */
  const pinReply = (reply: FastifyReply, r: 'locked' | 'wrong' | 'missing', owner = false) =>
    r === 'locked' ? reply.code(429).send({ error: 'pin_locked', ...(owner ? { pinOf: 'owner' } : {}) })
      : reply.code(403).send({ error: r === 'wrong' ? 'pin_wrong' : 'pin_required', ...(owner ? { pinOf: 'owner' } : {}) });

  app.put('/api/profiles/:id/pin', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ pin: pin.nullable(), currentPin: pin.optional() }).parse(req.body);
    const p = await manageable(req, reply);
    if (!p) return;
    // changing a PIN needs the current one, except for the owner profile managing another profile
    const self = req.profile!.id === p.id;
    if (p.pin_hash && self) {
      const r = await checkPin(req.user!.id, p, b.currentPin);
      if (r !== 'ok') return pinReply(reply, r);
    }
    await ctx.db.query('update profiles set pin_hash=$2 where id=$1', [p.id, b.pin ? hashPin(b.pin) : null]);
    await dropProfile(req.user!.id, p.id, self ? req.sid : undefined);
    await audit(ctx, req.user!.id, b.pin ? 'profile.pin_set' : 'profile.pin_clear', p.id);
    return { ok: true, hasPin: Boolean(b.pin) };
  });

  app.delete('/api/profiles/:id', pre, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    if (!ownerActive(req)) return reply.code(403).send({ error: 'owner_required' });
    const p = await getProfile(ctx, req.user!.id, id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    try {
      await deleteProfile(ctx, p);
    } catch (e) {
      return send(reply, e);
    }
    await dropProfile(req.user!.id, p.id);
    await audit(ctx, req.user!.id, 'profile.delete', p.id, { name: p.name });
    return { ok: true };
  });

  app.post('/api/profiles/:id/select', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ pin: pin.optional() }).parse(req.body ?? {});
    const p = await getProfile(ctx, req.user!.id, id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.pin_hash) {
      const r = await checkPin(req.user!.id, p, b.pin);
      if (r !== 'ok') return pinReply(reply, r);
    } else if (kidsLock(req) && p.id !== kidsLock(req)!.id) {
      // leaving a kids profile towards a profile without its own PIN: the owner profile's PIN unlocks
      const owner = (await listProfiles(ctx, req.user!.id)).find((x) => x.is_owner);
      if (owner?.pin_hash) {
        const r = await checkPin(req.user!.id, owner, b.pin);
        if (r !== 'ok') return pinReply(reply, r, true);
      }
    }
    // The gateway caches the media token per sid: rotate the sid so the previous profile's token can never be served again.
    const oldSid = req.sid!;
    const newSid = rand();
    const s = { ...req.session!, profileId: p.id, touchedAt: Date.now() };
    await saveSession(ctx, newSid, s);
    // in-flight requests of the tab still carry the old sid: keep it alive for a few seconds, already acting as the new profile (never beyond that)
    await ctx.kv.replace(`sess:${oldSid}`, JSON.stringify(s), OLD_SID_GRACE);
    forgetAuth(oldSid);
    renamePeerSid(req.user!.id, oldSid, newSid);
    const maxAge = Math.max(60, Math.floor(((s.createdAt ?? Date.now()) + (s.ttl ?? ctx.cfg.SESSION_TTL_SECONDS) * 1000 - Date.now()) / 1000));
    reply.setCookie(COOKIE, newSid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge });
    // a device that picks a kids profile stays on it until a PIN-checked switch (a new login there lands on the kids profile again)
    await setDeviceKids(ctx, req.user!.id, s.deviceId, p.kids ? p.id : null);
    await audit(ctx, req.user!.id, 'profile.select', p.id);
    return { ok: true, profile: { ...publicProfile(p), hasPin: Boolean(p.pin_hash), active: true }, csrfToken: s.csrf };
  });
}
