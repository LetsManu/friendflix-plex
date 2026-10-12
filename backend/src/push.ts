import webpush from 'web-push';
import type { Ctx } from './ctx.js';
import { broadcastLanguage, isLanguage, msg, renderNotice, type Language } from './i18n.js';
import type { Notice } from './notify.js';

type PushCtx = Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>;

type VapidCfg = Pick<Ctx['cfg'], 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT' | 'PUBLIC_URL'>;
const vapidChecked = new Map<string, boolean>();

/** Both keys set AND accepted by web-push (validated once per distinct config; an invalid pair logs one warning and disables push). */
export function pushEnabled(cfg: VapidCfg): boolean {
  if (!cfg.VAPID_PUBLIC_KEY || !cfg.VAPID_PRIVATE_KEY) return false;
  const subject = cfg.VAPID_SUBJECT ?? cfg.PUBLIC_URL;
  const key = `${subject}\n${cfg.VAPID_PUBLIC_KEY}\n${cfg.VAPID_PRIVATE_KEY}`;
  let ok = vapidChecked.get(key);
  if (ok === undefined) {
    try {
      webpush.setVapidDetails(subject, cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY);
      ok = true;
    } catch (e) {
      ok = false;
      console.warn(`web push disabled: invalid VAPID configuration (${e instanceof Error ? e.message : 'error'})`);
    }
    vapidChecked.set(key, ok);
  }
  return ok;
}

/** Push services we are willing to POST to (SSRF guard): https only, no IP literal, no port. */
export function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(':')) return false; // IPv4 / IPv6 literals
  return h === 'fcm.googleapis.com' || h === 'web.push.apple.com' || h.endsWith('.push.services.mozilla.com') || h.endsWith('.notify.windows.com') || h.endsWith('.push.apple.com');
}

export interface PushPayload { title: string; body: string; link?: string; tag: string; ts: number }

const SAFE_LINK = /^\/(?!\/)[^\s\\]{0,300}$/;

/** Payload in `lang` (the subscribing profile's language). Non-owner profiles only get a neutral text (the lock screen is shared). */
export function buildPayload(n: Pick<Notice, 'kind' | 'title' | 'body' | 'link' | 'pushBody'>, isOwner: boolean, lang: Language = 'de'): PushPayload {
  if (!isOwner) return { title: 'FriendFlix', body: msg(lang, 'push.generic'), link: '/', tag: n.kind, ts: Date.now() };
  const r = renderNotice(n, lang);
  const p: PushPayload = { title: r.title.slice(0, 120), body: (r.pushBody ?? r.body ?? '').slice(0, 300), tag: n.kind, ts: Date.now() };
  if (n.link && SAFE_LINK.test(n.link)) p.link = n.link;
  return p;
}

interface SubRow { id: string; endpoint: string; p256dh: string; auth: string; is_owner: boolean; fail_count: number; lang: string | null }
const SUB_COLS = "s.id, s.endpoint, s.p256dh, s.auth, s.fail_count, p.is_owner, pp.data->>'language' as lang";
const SUB_FROM = 'push_subscriptions s join profiles p on p.id = s.profile_id left join profile_prefs pp on pp.profile_id = s.profile_id';

/** Sends a notice to the matching subscriptions (user's own; or all broadcast=true ones when userId is null). Awaitable; never throws. */
export async function sendWebPush(ctx: PushCtx, n: Notice, only?: { endpoint: string }): Promise<Array<number | null>> {
  if (!pushEnabled(ctx.cfg)) return [];
  const vapidDetails = { subject: ctx.cfg.VAPID_SUBJECT ?? ctx.cfg.PUBLIC_URL, publicKey: ctx.cfg.VAPID_PUBLIC_KEY!, privateKey: ctx.cfg.VAPID_PRIVATE_KEY! };
  const rows = only && n.userId
    ? await ctx.db.query<SubRow>(`select ${SUB_COLS} from ${SUB_FROM} where s.user_id = $1 and s.endpoint = $2`, [n.userId, only.endpoint])
    : n.userId
    ? await ctx.db.query<SubRow>(`select ${SUB_COLS} from ${SUB_FROM} where s.user_id = $1`, [n.userId])
    : await ctx.db.query<SubRow>(`select ${SUB_COLS} from ${SUB_FROM} where s.broadcast`, []);
  if (!rows.rows.length) return [];
  // each subscription in its profile's language; profiles without a choice get the instance default
  const fallback = await broadcastLanguage(ctx);
  const out = await Promise.allSettled(rows.rows.map((s) => deliver(ctx, s, JSON.stringify(buildPayload(n, s.is_owner, isLanguage(s.lang) ? s.lang : fallback)), vapidDetails, n.userId ? 'high' : 'normal')));
  return out.map((o) => (o.status === 'fulfilled' ? o.value : null));
}

async function deliver(ctx: PushCtx, s: SubRow, payload: string, vapidDetails: { subject: string; publicKey: string; privateKey: string }, urgency: 'high' | 'normal'): Promise<number | null> {
  let d: ReturnType<typeof webpush.generateRequestDetails>;
  try {
    d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { vapidDetails, TTL: 86400, urgency });
  } catch (e) {
    // our own side (bad keys / config) failed before any request: not the subscription's fault, never counts towards its removal
    console.warn(`web push: could not build request (${e instanceof Error ? e.message : 'error'})`);
    return null;
  }
  try {
    // redirect: 'error' - a push service never legitimately redirects, and the endpoint allowlist must not be bypassable via 3xx
    const res = await ctx.fetchImpl(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body as unknown as BodyInit, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (res.status >= 200 && res.status < 300) {
      await ctx.db.query('update push_subscriptions set last_ok_at = now(), fail_count = 0 where id = $1', [s.id]);
    } else if (res.status === 404 || res.status === 410) {
      await ctx.db.query('delete from push_subscriptions where id = $1', [s.id]);
    } else if (res.status === 413) {
      console.warn('web push: payload too large (413)');
    } else {
      await fail(ctx, s.id);
    }
    return res.status;
  } catch {
    await fail(ctx, s.id).catch(() => undefined);
    return null;
  }
}

async function fail(ctx: PushCtx, id: string) {
  await ctx.db.query('update push_subscriptions set fail_count = fail_count + 1 where id = $1', [id]);
  await ctx.db.query("delete from push_subscriptions where id = $1 and fail_count >= 10 and coalesce(last_ok_at, created_at) < now() - interval '7 days'", [id]);
}

/** Deletes a user's subscriptions: all, only one device, or all except `exceptDeviceId` (the device of a session that stays logged in). */
export async function deletePushSubscriptions(ctx: Pick<Ctx, 'db'>, userId: string, deviceId?: string, exceptDeviceId?: string): Promise<void> {
  if (deviceId) await ctx.db.query('delete from push_subscriptions where user_id = $1 and device_id = $2', [userId, deviceId]);
  else if (exceptDeviceId) await ctx.db.query('delete from push_subscriptions where user_id = $1 and device_id is distinct from $2', [userId, exceptDeviceId]);
  else await ctx.db.query('delete from push_subscriptions where user_id = $1', [userId]);
}
