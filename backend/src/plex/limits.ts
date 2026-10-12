/**
 * Role limits Plex cannot enforce for FriendFlix (one admin token for everybody), applied around the playback delegate:
 *
 *  - transcoding: media_policies.transcoding = false (role template / admin "Gast-Wiedergabe" setting) means Direct Play only.
 *    playbackInfo() refuses when Direct Play is impossible (403 `transcoding_not_allowed`), preparePlayback() never starts a Plex
 *    transcode for such identities (so the session's HLS URL stays dead at Plex), transcoded downloads are refused the same way.
 *    Jellyfin's equivalent is EnableVideoPlaybackTranscoding=false.
 *  - maxStreams: media_policies.max_streams counts the identity's active Plex play sessions (kv `plexplay:<identity>:<session>`,
 *    written by every start/progress report, dropped on stop / stopEncoding, 60 s TTL; playbackInfo() alone does not count, so
 *    preview clips and the health check never take a slot). A new playbackInfo() for another item beyond the
 *    limit answers 429 `max_streams`; re-requests for the same item (quality / audio switch, resume) never count twice.
 *    Jellyfin's equivalent is MaxActiveSessions (the routes additionally count FriendFlix live sessions per account).
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

export interface PlexLimitsDeps {
  db: Db;
  kv: KV;
  /** fork migrations (media_policies) */
  ready: () => Promise<void>;
}

export interface PlaybackPolicy { transcoding: boolean; maxStreams: number | null }

export class PlexLimits {
  constructor(private readonly d: PlexLimitsDeps) {}

  /** The identity's playback policy; no row = nothing visible anyway (item() is 404), so the most closed values. */
  async policy(user: MediaUser): Promise<PlaybackPolicy> {
    await this.d.ready();
    const r = await this.d.db.query<{ transcoding: boolean; max_streams: number | null }>(
      'select transcoding, max_streams from media_policies where identity_id = $1', [user.jellyfin_user_id]);
    const row = r.rows[0];
    return row ? { transcoding: row.transcoding !== false, maxStreams: row.max_streams ?? null } : { transcoding: false, maxStreams: 0 };
  }

  /** Active play sessions of the identity, as session -> item id. */
  async active(user: MediaUser): Promise<Map<string, string>> {
    const prefix = activeKey(user.jellyfin_user_id, '');
    const out = new Map<string, string>();
    for (const k of await this.d.kv.keys(prefix)) {
      const v = await this.d.kv.get(k);
      if (v) out.set(k.slice(prefix.length), v);
    }
    return out;
  }

  /** 429 when starting `itemId` would exceed max_streams (sessions of the same item do not count). */
  async checkStreams(user: MediaUser, itemId: string, pol: PlaybackPolicy): Promise<void> {
    if (!pol.maxStreams || pol.maxStreams <= 0) return;
    const others = [...(await this.active(user)).values()].filter((i) => i !== itemId).length;
    if (others >= pol.maxStreams) throw new PlexLimitError(429, 'max_streams');
  }

  async mark(user: MediaUser, session: string, itemId: string): Promise<void> {
    if (SESSION_RE.test(session)) await this.d.kv.set(activeKey(user.jellyfin_user_id, session), itemId, ACTIVE_TTL_S);
  }

  async track(user: MediaUser, r: PlaybackReport): Promise<void> {
    if (!SESSION_RE.test(r.playSessionId)) return;
    if (r.event === 'stop') await this.d.kv.del(activeKey(user.jellyfin_user_id, r.playSessionId));
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
      await limits.track(u, { event: 'stop', itemId: '', mediaSourceId: '', playSessionId: s, positionTicks: 0, paused: false });
      await inner.stopEncoding(u, s);
    },
    playMeta: (u, id) => inner.playMeta(u, id),
    subtitleStream: (u, id, ms, idx, f) => inner.subtitleStream(u, id, ms, idx, f),

    async playbackInfo(user: MediaUser, itemId: string, opts: PlaybackOptions): Promise<PlaybackDto> {
      const pol = await limits.policy(user);
      await limits.checkStreams(user, itemId, pol);
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
      return inner.preparePlayback ? inner.preparePlayback(user, info, opts) : info;
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
