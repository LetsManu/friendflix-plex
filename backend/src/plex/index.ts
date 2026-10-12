/**
 * FriendFlix for Plex: builds the PlexMediaServer for media/index.ts (MEDIA_SERVER=plex). One admin token (PLEX_TOKEN /
 * PLEX_TOKEN_FILE), backend + gateway only. The mirror, policies and user data live in the FriendFlix database (own pool,
 * fork migrations in ./migrations.ts run once before the first query).
 */
import pg from 'pg';
import type { MediaDeps } from '../media/index.js';
import { PlexClient } from './client.js';
import { migratePlex } from './migrations.js';
import { PlexMediaServer, type PlexPlayback } from './service.js';

export { PlexMediaServer, type PlexPlayback } from './service.js';
export { PlexClient, PlexError } from './client.js';

export function createPlexMediaServer(d: MediaDeps, opts: { playback?: (svc: PlexMediaServer) => PlexPlayback } = {}): PlexMediaServer {
  const pool = new pg.Pool({ connectionString: d.cfg.DATABASE_URL, max: 4 });
  return new PlexMediaServer({
    client: new PlexClient(d.cfg.PLEX_URL!, d.cfg.PLEX_TOKEN!, d.fetchImpl),
    db: pool,
    kv: d.kv,
    migrate: () => migratePlex(pool),
    ...(opts.playback ? { playback: opts.playback } : {}),
  });
}
