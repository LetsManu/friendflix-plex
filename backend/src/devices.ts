// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { revokeCasts } from './cast.js';
import type { Ctx } from './ctx.js';
import { revokeDownloads } from './downloads.js';
import { m, msg, userLanguage, type Language } from './i18n.js';
import { notify } from './notify.js';
import { deletePushSubscriptions } from './push.js';
import { forgetAuth } from './routes/internal.js';
import { dropPartyPeers } from './routes/party.js';
import { dropRemotePeers } from './routes/tv.js';

export const DEVICE_COOKIE = 'ff_dev';

/** Device name from the user agent, in the account's language (stored once, when the device registers). */
export const deviceLabel = (ua: string, lang: Language = 'de') => {
  const os = /Windows|Android|iPhone|iPad|Mac OS X|Linux/.exec(ua)?.[0] ?? msg(lang, 'device.unknownOs');
  const browser = /Edg|Firefox|Chrome|Safari/.exec(ua)?.[0] ?? 'Browser';
  return msg(lang, 'device.label', { browser, os }).slice(0, 60);
};

/** First device of a user is trusted automatically; every further device needs approval. */
export async function registerDevice(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, userId: string, secure: boolean) {
  let dev = req.cookies[DEVICE_COOKIE];
  if (!dev || !/^[\w-]{20,60}$/.test(dev)) dev = randomBytes(24).toString('base64url');
  reply.setCookie(DEVICE_COOKIE, dev, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
  const existing = await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [userId, dev]);
  if (existing.rows[0]) {
    await ctx.db.query('update devices set last_seen=now() where user_id=$1 and device_id=$2', [userId, dev]);
    return { deviceId: dev, approved: existing.rows[0].approved };
  }
  const name = deviceLabel(String(req.headers['user-agent'] ?? ''), await userLanguage(ctx, userId));
  // atomic (advisory lock inside the sql function): two simultaneous first logins cannot both be auto-approved; null = lost an insert race for the same device
  const ins = await ctx.db.query<{ a: boolean | null }>('select register_device($1,$2,$3) a', [userId, dev, name]);
  const approved = ins.rows[0]!.a ?? (await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [userId, dev])).rows[0]?.approved ?? false;
  // tell the user's already approved devices (bell + push) that a new one is waiting, with a link to the approval list
  if (!approved) await notify(ctx, { userId, kind: 'device_pending', title: m('device.pending.title'), body: m('device.pending.body', { name }), link: '/devices' }).catch(() => false);
  return { deviceId: dev, approved };
}

/** Deletes sessions of a user (optionally only one device, optionally keeping the current session). Returns the count. */
export async function revokeSessions(ctx: Ctx, userId: string, deviceId?: string, exceptSid?: string): Promise<number> {
  let n = 0;
  const gone = new Set<string>();
  // the session that stays logged in keeps its device's push subscriptions and cast tokens
  let keepDevice: string | undefined;
  if (exceptSid) {
    const raw = await ctx.kv.get(`sess:${exceptSid}`);
    const ks = raw ? (JSON.parse(raw) as { userId: string; deviceId?: string }) : null;
    if (ks?.userId === userId) keepDevice = ks.deviceId;
  }
  for (const k of await ctx.kv.keys('sess:')) {
    if (exceptSid && k === `sess:${exceptSid}`) continue;
    const raw = await ctx.kv.get(k);
    if (!raw) continue;
    const s = JSON.parse(raw) as { userId: string; deviceId?: string };
    if (s.userId === userId && (!deviceId || s.deviceId === deviceId)) {
      await ctx.kv.del(k);
      gone.add(k.slice('sess:'.length));
      n++;
    }
  }
  if (gone.size) {
    dropRemotePeers(userId, gone);
    dropPartyPeers(userId, gone);
    for (const sid of gone) forgetAuth(sid); // the media gateway must not keep serving a memoised identity
  }
  if (!(deviceId && deviceId === keepDevice)) {
    await revokeCasts(ctx, userId, deviceId, keepDevice);
    await deletePushSubscriptions(ctx, userId, deviceId, keepDevice);
    await revokeDownloads(ctx, userId, deviceId, keepDevice);
  }
  return n;
}

/**
 * Drops the media gateway's memoised identity of every session of the user, without signing anything out:
 * the next media request re-reads role and limits (e.g. after an admin changed the user's limits). Returns the count.
 */
export async function forgetUserAuth(ctx: Ctx, userId: string): Promise<number> {
  let n = 0;
  for (const k of await ctx.kv.keys('sess:')) {
    const raw = await ctx.kv.get(k);
    if (!raw || (JSON.parse(raw) as { userId: string }).userId !== userId) continue;
    forgetAuth(k.slice('sess:'.length));
    n++;
  }
  return n;
}

/** True if a live session of the user (other than `exceptSid`) still belongs to this device. */
export async function deviceHasSession(ctx: Ctx, userId: string, deviceId: string, exceptSid?: string): Promise<boolean> {
  for (const k of await ctx.kv.keys('sess:')) {
    if (exceptSid && k === `sess:${exceptSid}`) continue;
    const raw = await ctx.kv.get(k);
    if (!raw) continue;
    const s = JSON.parse(raw) as { userId: string; deviceId?: string };
    if (s.userId === userId && s.deviceId === deviceId) return true;
  }
  return false;
}
