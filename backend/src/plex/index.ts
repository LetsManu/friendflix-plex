/**
 * FriendFlix for Plex: builds the PlexMediaServer for media/index.ts (MEDIA_SERVER=plex). One admin token (PLEX_TOKEN /
 * PLEX_TOKEN_FILE), backend + gateway only. The mirror, policies and user data live in the FriendFlix database (own pool,
 * fork migrations in ./migrations.ts run once before the first query).
 */
import pg from 'pg';
import type { MediaDeps } from '../media/index.js';
import { PlexClient } from './client.js';
import { PlexLimits, withLimits } from './limits.js';
import { migratePlex } from './migrations.js';
import { plexPlaybackFactory } from './playback.js';
import { PlexMediaServer, type PlexPlayback } from './service.js';

export { PlexMediaServer, type PlexPlayback } from './service.js';
export { PlexClient, PlexError } from './client.js';
export { PlexLimitError } from './limits.js';

/**
 * The production playback delegate: P2's playback module (decision/transcode, direct play, subtitles, trickplay, downloads) behind
 * the role limits Plex cannot enforce itself (limits.ts: transcoding, maxStreams; 'stop' reports end the Plex transcode).
 */
export function plexPlayback(o: Parameters<typeof plexPlaybackFactory>[0]): (svc: PlexMediaServer) => PlexPlayback {
  const make = plexPlaybackFactory(o);
  return (svc) => withLimits(make(svc), new PlexLimits({ db: svc.db, kv: o.kv, ready: () => svc.ready() }), (u, r) => svc.recordReport(u, r));
}

export function createPlexMediaServer(d: MediaDeps, opts: { playback?: (svc: PlexMediaServer) => PlexPlayback } = {}): PlexMediaServer {
  const pool = new pg.Pool({ connectionString: d.cfg.DATABASE_URL, max: 4 });
  return new PlexMediaServer({
    client: new PlexClient(d.cfg.PLEX_URL!, d.cfg.PLEX_TOKEN!, d.fetchImpl),
    db: pool,
    kv: d.kv,
    migrate: () => migratePlex(pool),
    playback: opts.playback ?? plexPlayback({ kv: d.kv, secret: d.cfg.INTERNAL_SECRET }),
  });
}
