// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import type { Config } from '../config.js';
import { JellyfinClient } from '../jellyfin/client.js';
import { JellyfinService } from '../jellyfin/service.js';
import type { KV } from '../kv.js';
import { createPlexMediaServer } from '../plex/index.js';
import type { MediaServer } from './types.js';

/**
 * The one place that knows the implementations. A fork adds its kind to MEDIA_SERVERS and a factory below;
 * config.ts (MEDIA_SERVER) and server.ts pick them up from here.
 */
export const MEDIA_SERVERS = ['jellyfin', 'plex'] as const;
export type MediaServerKind = (typeof MEDIA_SERVERS)[number];

/**
 * What a factory gets. `db` is the backend's shared Postgres pool: implementations that keep state (an id map, sync cursors …) use it
 * instead of opening a pool of their own. Jellyfin ignores it.
 */
export interface MediaDeps { cfg: Config; kv: KV; db: pg.Pool; encKey: Buffer; fetchImpl?: typeof fetch }

const factories: Record<MediaServerKind, (d: MediaDeps) => MediaServer> = {
  jellyfin: (d) => new JellyfinService(new JellyfinClient(d.cfg.JELLYFIN_URL!, d.cfg.JELLYFIN_ADMIN_API_KEY!, d.fetchImpl), d.kv, d.encKey),
  plex: (d) => createPlexMediaServer(d),
};

export function createMediaServer(d: MediaDeps): MediaServer {
  const make = factories[d.cfg.MEDIA_SERVER];
  if (!make) throw new Error(`unknown MEDIA_SERVER ${String(d.cfg.MEDIA_SERVER)}`);
  return make(d);
}

/** Settings a given server kind cannot work with (checked at startup); [] = fine. */
export function mediaConfigProblems(cfg: Config): string[] {
  void cfg; // Jellyfin supports every setting
  return [];
}
