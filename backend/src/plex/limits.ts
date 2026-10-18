// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Role limits Plex cannot enforce for FriendFlix (one admin token for everybody), applied around the playback delegate:
 *
 *  - transcoding: plex_media_policies.transcoding = false (role template / admin "Gast-Wiedergabe" setting) means Direct Play only.
 *    playbackInfo() refuses when Direct Play is impossible (403 `transcoding_not_allowed`), preparePlayback() never starts a Plex
 *    transcode for such identities (so the session's HLS URL stays dead at Plex), transcoded downloads are refused the same way.
 *    Jellyfin's equivalent is EnableVideoPlaybackTranscoding=false.
 *  - maxStreams: plex_media_policies.max_streams counts the identity's active play sessions, enforced server-side:
 *      a) sessions whose Plex transcode FriendFlix started (kv `plexstarted:<identity>:<session>`, written in preparePlayback before
 *         the start) and that Plex still lists in GET /transcode/sessions (Plex reaps transcodes nobody fetches any more), plus
 *      b) sessions the player reported (kv `plexplay:<identity>:<session>`, start/progress, 60 s TTL; covers Direct Play).
 *    Both are dropped on stop / stopEncoding. playbackInfo() and preparePlayback() check the limit; clipTranscode (preview clips,
 *    health check) never takes a slot. If Plex cannot be asked, started sessions count (fail closed). A new playbackInfo() for another item beyond the
 *    limit answers 429 `max_streams`; re-requests for the same item (quality / audio switch, resume) never count twice.
 *    Jellyfin's equivalent is MaxActiveSessions (the routes additionally count FriendFlix live sessions per account).
 *  - fork (1.1 cast parity): a queued next episode's cast (PlaybackOptions.after = the predecessor's play session, resolved by
 *    routes/cast.ts castPredecessor, never by the client) may overlap exactly that one session of the identity: the predecessor does
 *    not count against it, every other session does. Its session is cast-only (mediapaths.ts `hlsq`, the gateway refuses it with a
 *    cookie) and its cast token is served only within NEXT_OVERLAP_MS while the predecessor still plays (cast.ts), so the overlap is
 *    bounded exactly as upstream's. One queued session per predecessor: an earlier one (`plexnext:<identity>:<session>` = the
 *    predecessor) is stopped at Plex before the new one starts. From its start on it counts for every later check like any session.
 *
 * Errors carry `statusCode` (not MediaError), so the app's error handler answers `{ error: <code> }` with that status instead of
 * the generic 502 for media server failures.
 */
import type { Db } from '../db.js';
import type { KV } from '../kv.js';
import type { MediaUser, PlaybackDto, PlaybackOptions, PlaybackReport } from '../media/types.js';
import { SESSION_RE } from './mediapaths.js';
import type { PlexPlayback } from './service.js';

export class PlexLimitError extends Error {
  constructor(readonly statusCode: 403 | 429, message: 'transcoding_not_allowed' | 'max_streams') {
    super(message);
    this.name = 'PlexLimitError';
  }
}

export const ACTIVE_TTL_S = 60;
const activeKey = (identity: string, session: string) => `plexplay:${identity}:${session}`;
const startedKey = (identity: string, session: string) => `plexstarted:${identity}:${session}`;
/** fork (1.1): a queued next episode's session -> the play session it follows */
const nextKey = (identity: string, session: string) => `plexnext:${identity}:${session}`;
/** FriendFlix play session id -> identity, from the limit bookkeeping (Block 22: who an active Plex session belongs to). */
export async function sessionIdentities(kv: Pick<KV, 'keys'>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const prefix of ['plexstarted:', 'plexplay:']) {
    for (const k of await kv.keys(prefix)) {
      const [identity, session] = k.slice(prefix.length).split(':');
      if (identity && session && SESSION_RE.test(session) && !out.has(session)) out.set(session, identity);
    }
  }
  return out;
}
/** a started transcode is counted at most this long (Plex reaps idle transcodes much earlier) */
export const STARTED_TTL_S = 6 * 3600;

export interface PlexLimitsDeps {
  db: Db;
  kv: KV;
  /** fork migrations (plex_media_policies) */
  ready: () => Promise<void>;
  /** keys (= FriendFlix session ids) of the transcodes Plex is running now (GET /transcode/sessions); throws when Plex is unreachable */
  transcodeSessions: () => Promise<Set<string>>;
}

/** GET /transcode/sessions -> the session keys. */
export async function plexTranscodeSessions(client: { container(path: string): Promise<Record<string, any>> }): Promise<Set<string>> {
  const c = await client.container('/transcode/sessions');
  return new Set((Array.isArray(c.TranscodeSession) ? c.TranscodeSession : []).map((t: { key?: unknown }) => String(t.key ?? '')).filter(Boolean));
}

export interface PlaybackPolicy { transcoding: boolean; maxStreams: number | null }

export class PlexLimits {
  constructor(private readonly d: PlexLimitsDeps) {}

  /** The identity's playback policy; no row = nothing visible anyway (item() is 404), so the most closed values. */
  async policy(user: MediaUser): Promise<PlaybackPolicy> {
    await this.d.ready();
    const r = await this.d.db.query<{ transcoding: boolean; max_streams: number | null }>(
      'select transcoding, max_streams from plex_media_policies where identity_id = $1', [user.jellyfin_user_id]);
    const row = r.rows[0];
    return row ? { transcoding: row.transcoding !== false, maxStreams: row.max_streams ?? null } : { transcoding: false, maxStreams: 0 };
  }

  private async entries(prefix: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const k of await this.d.kv.keys(prefix)) {
      const v = await this.d.kv.get(k);
      if (v) out.set(k.slice(prefix.length), v);
    }
    return out;
  }

  /** Active play sessions of the identity, as session -> item id (reported ones + started transcodes Plex still runs). */
  async active(user: MediaUser): Promise<Map<string, string>> {
    const id = user.jellyfin_user_id;
    const out = await this.entries(activeKey(id, ''));
    const started = await this.entries(startedKey(id, ''));
    if (started.size) {
      // Plex unreachable: count every started session (fail closed)
      const running = await this.d.transcodeSessions().catch(() => null);
      for (const [s, item] of started) {
        if (!running || running.has(s)) out.set(s, item);
        else await this.d.kv.del(startedKey(id, s)); // reaped / stopped by Plex
      }
    }
    return out;
  }

  /**
   * 429 when starting `itemId` would exceed max_streams (sessions of the same item do not count). `after` (a queued next episode,
   * server-resolved): that one predecessor session and an earlier queued session after it (stopped before the new one starts) do
   * not count either.
   */
  async checkStreams(user: MediaUser, itemId: string, pol: PlaybackPolicy, after?: string): Promise<void> {
    if (!pol.maxStreams || pol.maxStreams <= 0) return;
    const queued = after ? await this.queuedAfter(user, after) : new Set<string>();
    const others = [...(await this.active(user))].filter(([s, i]) => i !== itemId && s !== after && !queued.has(s)).length;
    if (others >= pol.maxStreams) throw new PlexLimitError(429, 'max_streams');
  }

  /** fork (1.1): the identity's queued sessions that follow `after` */
  async queuedAfter(user: MediaUser, after: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (!SESSION_RE.test(after)) return out;
    for (const [s, pred] of await this.entries(nextKey(user.jellyfin_user_id, ''))) if (pred === after && SESSION_RE.test(s)) out.add(s);
    return out;
  }

  /** fork (1.1): marks `session` as the queued next episode after `after` */
  async markQueued(user: MediaUser, session: string, after: string): Promise<void> {
    if (SESSION_RE.test(session) && SESSION_RE.test(after)) await this.d.kv.set(nextKey(user.jellyfin_user_id, session), after, STARTED_TTL_S);
  }

  async mark(user: MediaUser, session: string, itemId: string): Promise<void> {
    if (SESSION_RE.test(session)) await this.d.kv.set(activeKey(user.jellyfin_user_id, session), itemId, ACTIVE_TTL_S);
  }

  async markStarted(user: MediaUser, session: string, itemId: string): Promise<void> {
    if (SESSION_RE.test(session)) await this.d.kv.set(startedKey(user.jellyfin_user_id, session), itemId, STARTED_TTL_S);
  }

  async forget(user: MediaUser, session: string): Promise<void> {
    if (!SESSION_RE.test(session)) return;
    await this.d.kv.del(activeKey(user.jellyfin_user_id, session));
    await this.d.kv.del(startedKey(user.jellyfin_user_id, session));
    await this.d.kv.del(nextKey(user.jellyfin_user_id, session));
  }

  async track(user: MediaUser, r: PlaybackReport): Promise<void> {
    if (!SESSION_RE.test(r.playSessionId)) return;
    if (r.event === 'stop') await this.forget(user, r.playSessionId);
    else await this.mark(user, r.playSessionId, r.itemId);
  }
}

/**
 * Wraps the playback delegate with the limits above. `recordReport` is the core's user-data report (service.ts); a 'stop' report
 * also stops the Plex transcode behind the session (Plex would otherwise keep encoding until its own idle timeout).
 */
export function withLimits(inner: PlexPlayback, limits: PlexLimits, recordReport: (user: MediaUser, r: PlaybackReport) => Promise<void>): PlexPlayback {
  return {
    mediaFetch: (u, p, i) => inner.mediaFetch(u, p, i),
    clipTranscode: (u, info, o) => inner.clipTranscode(u, info, o), // server-side preview clips / health check, not a viewer stream
    async stopEncoding(u, s) {
      await limits.forget(u, s);
      await inner.stopEncoding(u, s);
    },
    playMeta: (u, id) => inner.playMeta(u, id),
    subtitleStream: (u, id, ms, idx, f) => inner.subtitleStream(u, id, ms, idx, f),

    async playbackInfo(user: MediaUser, itemId: string, opts: PlaybackOptions): Promise<PlaybackDto> {
      const pol = await limits.policy(user);
      await limits.checkStreams(user, itemId, pol, opts.cast ? opts.after : undefined);
      const info = await inner.playbackInfo(user, itemId, opts);
      if (!pol.transcoding && (opts.cast || !info.directUrl)) throw new PlexLimitError(403, 'transcoding_not_allowed');
      return info;
    },

    async preparePlayback(user: MediaUser, info: PlaybackDto, opts: PlaybackOptions): Promise<PlaybackDto> {
      const pol = await limits.policy(user);
      if (!pol.transcoding) {
        if (!info.directUrl) throw new PlexLimitError(403, 'transcoding_not_allowed');
        return info; // Direct Play only: no Plex transcode is ever started for this session
      }
      if (!inner.preparePlayback) return info;
      // server-side stream limit: checked again right before the Plex transcode starts, and the session counts from now on
      const after = opts.cast && opts.after && opts.after !== info.playSessionId ? opts.after : undefined;
      await limits.checkStreams(user, info.itemId, pol, after);
      if (after) {
        // one queued next episode per predecessor (cast.ts keeps one queued token per device): the earlier one's transcode ends here
        for (const s of await limits.queuedAfter(user, after)) {
          if (s === info.playSessionId) continue;
          await limits.forget(user, s);
          await inner.stopEncoding(user, s);
        }
      }
      await limits.markStarted(user, info.playSessionId, info.itemId);
      if (after) await limits.markQueued(user, info.playSessionId, after);
      try {
        return await inner.preparePlayback(user, info, opts);
      } catch (e) {
        await limits.forget(user, info.playSessionId);
        throw e;
      }
    },

    async downloadSource(user, itemId, opts) {
      if (opts.quality !== 'original' && !(await limits.policy(user)).transcoding) throw new PlexLimitError(403, 'transcoding_not_allowed');
      return inner.downloadSource(user, itemId, opts);
    },

    async report(user: MediaUser, r: PlaybackReport): Promise<void> {
      await (inner.report ? inner.report(user, r) : recordReport(user, r));
      await limits.track(user, r);
      if (r.event === 'stop') await inner.stopEncoding(user, r.playSessionId); // never throws
    },
  };
}
