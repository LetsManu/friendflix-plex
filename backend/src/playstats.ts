// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { listErrors } from './errorlog.js';
import { playbackHooks } from './hooks.js';
import { listLive, type Live } from './live.js';
import type { ServerSession, TranscodeReason } from './media/types.js';

/**
 * Block 22: streams and transcodes per account, day and device (`play_daily`, aggregated, no titles) and the admin's view of
 * the active streams with play method, transcode reason, codecs and hardware flag.
 */
export type StreamMethod = 'direct' | 'remux' | 'transcode';

/** The client says Transcode for every HLS stream: it only counts as a transcode when the server gave a reason. */
export function methodOf(playMethod: string | undefined, reason: TranscodeReason | undefined): StreamMethod {
  if (playMethod === 'DirectPlay') return 'direct';
  if (playMethod === 'Transcode' && reason) return 'transcode';
  return 'remux';
}

/** One started stream for today: `transcodes` and `reasons[reason]` grow only for a transcode. */
export async function recordStream(ctx: Pick<Ctx, 'db'>, userId: string, deviceId: string, method: StreamMethod, reason?: TranscodeReason): Promise<void> {
  const tc = method === 'transcode';
  const r = tc && reason ? reason : null;
  await ctx.db.query(
    `insert into play_daily(user_id, day, device_id, streams, transcodes, reasons)
     values ($1, current_date, $2, 1, $3, case when $4::text is null then '{}'::jsonb else jsonb_build_object($4::text, 1) end)
     on conflict (user_id, day, device_id) do update set
       streams = play_daily.streams + 1,
       transcodes = play_daily.transcodes + excluded.transcodes,
       reasons = case when $4::text is null then play_daily.reasons
                 else jsonb_set(play_daily.reasons, array[$4::text], to_jsonb(coalesce((play_daily.reasons->>$4::text)::int, 0) + 1)) end`,
    [userId, deviceId, tc ? 1 : 0, r],
  );
}

const COUNTED_TTL = 6 * 3600;

/** Counts a play session at most once (a repeated start report or a second poll must not count again). */
export async function countStreamOnce(ctx: Pick<Ctx, 'db' | 'kv'>, userId: string, sessionKey: string, deviceId: string, method: StreamMethod, reason?: TranscodeReason): Promise<void> {
  if (!(await ctx.kv.setnx(`pstat:${userId}:${sessionKey}`, '1', COUNTED_TTL))) return;
  await recordStream(ctx, userId, deviceId, method, reason);
}

/** device id for streams of other apps: the client name only (cut, harmless characters) */
export function appDeviceId(client: string | undefined): string {
  return `app:${(client ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'unknown'}`;
}

let wired = false;
/** Registers the "Playing" hook next to the watch-time statistics (once per process). */
export function wirePlayStats() {
  if (wired) return;
  wired = true;
  playbackHooks.add(async (c, e) => {
    if (e.kind !== 'Playing' || e.live.source !== 'portal') return;
    await countStreamOnce(c, e.user.id, e.live.playSessionId, e.live.deviceId ?? '', e.live.playMethod ?? 'remux', e.live.transcodeReason);
  });
}

// ---- admin: active streams ----
export interface StreamRow {
  userId: string | null; userName: string | null; profileName: string | null; device: string | null; title: string; seriesName: string | null;
  source: 'portal' | 'app'; method: StreamMethod | null; reason: TranscodeReason | null;
  videoCodec: string | null; audioCodec: string | null; hardware: boolean | null; paused: boolean;
}
export interface StreamsView {
  streams: StreamRow[];
  totals: Record<StreamMethod, number>;
  details: boolean;
  failed: Array<{ itemId: string; title: string | null; count: number; lastAt: string; code: string }>;
}

const MEMO_MS = 5000;
const SESSIONS_TIMEOUT_MS = 3000;
let memo = new WeakMap<object, { at: number; p: Promise<ServerSession[] | null> }>();

/** Tests only. */
export function resetStreamsMemoForTests() {
  memo = new WeakMap();
}

/** One transcodeSessions() call per 5 s (3 s limit); null when absent or failing. */
function serverSessions(ctx: Ctx): Promise<ServerSession[] | null> {
  const fn = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  if (!fn) return Promise.resolve(null);
  const hit = memo.get(ctx);
  const now = Date.now();
  if (hit && now - hit.at < MEMO_MS) return hit.p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = Promise.race([
    fn(),
    new Promise<null>((res) => { timer = setTimeout(() => res(null), SESSIONS_TIMEOUT_MS); }),
  ]).catch(() => null).finally(() => clearTimeout(timer));
  memo.set(ctx, { at: now, p });
  return p;
}

const nid = (s: string) => s.replace(/-/g, '').toLowerCase();

export async function activeStreams(ctx: Ctx): Promise<StreamsView> {
  const [live, sessions, errors] = await Promise.all([
    listLive(ctx),
    serverSessions(ctx),
    listErrors(ctx, { source: 'playback', since: new Date(Date.now() - 24 * 3600_000), limit: 300 }),
  ]);
  const details = sessions !== null;
  const portal = live.filter((l) => l.source === 'portal').sort((a, b) => b.updatedAt - a.updatedAt);

  // FriendFlix device labels of the portal streams
  const labels = new Map<string, string>();
  const withDevice = portal.filter((l) => l.deviceId);
  if (withDevice.length) {
    const r = await ctx.db.query<{ user_id: string; device_id: string; label: string | null }>(
      'select user_id, device_id, label from devices where (user_id, device_id) in (select * from unnest($1::uuid[], $2::text[]))',
      [withDevice.map((l) => l.userId), withDevice.map((l) => l.deviceId!)]);
    for (const x of r.rows) if (x.label) labels.set(`${x.user_id}|${x.device_id}`, x.label);
  }

  const used = new Set<ServerSession>();
  const match = (l: Live): ServerSession | undefined => {
    if (!sessions) return undefined;
    const s = sessions.find((x) => !used.has(x) && x.playSessionId && x.playSessionId === l.playSessionId)
      ?? sessions.find((x) => !used.has(x) && String(x.deviceId ?? '').startsWith('ff-') && x.item.id === l.itemId && (!l.serverUserId || nid(x.serverUserId) === nid(l.serverUserId)));
    if (s) used.add(s);
    return s;
  };
  const rows: StreamRow[] = portal.map((l) => {
    const s = match(l);
    const method = l.playMethod ?? (s ? methodOf(s.playMethod, s.reasons[0]) : null);
    const reason = method === 'transcode' ? (l.transcodeReason ?? s?.reasons[0] ?? null) : null;
    return {
      userId: l.userId, userName: l.userName, profileName: l.profileName ?? null, device: l.deviceId ? (labels.get(`${l.userId}|${l.deviceId}`) ?? null) : null,
      title: l.title, seriesName: l.seriesName ?? null, source: 'portal', method, reason,
      videoCodec: s?.videoCodec ?? null, audioCodec: s?.audioCodec ?? null, hardware: s?.hardware ?? null, paused: l.isPaused,
    };
  });

  if (sessions) {
    const foreign = sessions.filter((s) => !used.has(s) && !String(s.deviceId ?? '').startsWith('ff-'));
    const ids = [...new Set(foreign.map((s) => nid(s.serverUserId)))];
    const who = new Map<string, { userId: string; userName: string; profileName: string | null }>();
    if (ids.length) {
      const r = await ctx.db.query<{ jf: string; user_id: string; user_name: string; profile_name: string | null }>(
        `select replace(lower(u.jellyfin_user_id), '-', '') jf, u.id user_id, u.name user_name, null profile_name from users u where replace(lower(u.jellyfin_user_id), '-', '') = any($1)
         union all
         select replace(lower(p.jellyfin_user_id), '-', ''), u.id, u.name, p.name from profiles p join users u on u.id = p.user_id
          where not p.is_owner and p.jellyfin_user_id is not null and replace(lower(p.jellyfin_user_id), '-', '') = any($1)`, [ids]);
      for (const x of r.rows) who.set(x.jf, { userId: x.user_id, userName: x.user_name, profileName: x.profile_name });
    }
    for (const s of foreign) {
      const u = who.get(nid(s.serverUserId));
      const method = methodOf(s.playMethod, s.reasons[0]);
      rows.push({
        userId: u?.userId ?? null, userName: u?.userName ?? null, profileName: u?.profileName ?? null,
        device: [s.client, s.deviceName].filter(Boolean).join(' · ') || null,
        title: s.item.name, seriesName: s.item.seriesName ?? null, source: 'app', method, reason: method === 'transcode' ? (s.reasons[0] ?? null) : null,
        videoCodec: s.videoCodec ?? null, audioCodec: s.audioCodec ?? null, hardware: s.hardware ?? null, paused: s.paused,
      });
    }
  } else {
    for (const l of live.filter((x) => x.source === 'jellyfin').sort((a, b) => b.updatedAt - a.updatedAt)) {
      rows.push({
        userId: l.userId, userName: l.userName, profileName: l.profileName ?? null, device: null, title: l.title, seriesName: l.seriesName ?? null,
        source: 'app', method: null, reason: null, videoCodec: null, audioCodec: null, hardware: null, paused: l.isPaused,
      });
    }
  }

  const totals: Record<StreamMethod, number> = { direct: 0, remux: 0, transcode: 0 };
  for (const r of rows) if (r.method) totals[r.method]++;

  // failed playbacks of the last 24 h, grouped by title
  const byItem = new Map<string, { itemId: string; count: number; lastAt: string; code: string }>();
  for (const e of errors.entries) {
    if (!e.itemId) continue;
    const g = byItem.get(e.itemId);
    if (!g) byItem.set(e.itemId, { itemId: e.itemId, count: e.count, lastAt: e.lastAt, code: e.code });
    else {
      g.count += e.count;
      if (e.lastAt > g.lastAt) Object.assign(g, { lastAt: e.lastAt, code: e.code });
    }
  }
  const groups = [...byItem.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  const names = new Map<string, string>();
  if (groups.length) {
    const r = await ctx.db.query<{ item_id: string; name: string }>('select item_id, name from hygiene_items where item_id = any($1)', [groups.map((g) => g.itemId)]);
    for (const x of r.rows) names.set(x.item_id, x.name);
  }
  const failed = groups.map((g) => ({ itemId: g.itemId, title: names.get(g.itemId) ?? null, count: g.count, lastAt: g.lastAt, code: g.code }));
  return { streams: rows, totals, details, failed };
}
