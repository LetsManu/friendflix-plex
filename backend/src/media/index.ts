import type { Config } from '../config.js';
import { JellyfinClient } from '../jellyfin/client.js';
import { JellyfinService } from '../jellyfin/service.js';
import type { KV } from '../kv.js';
import type { MediaServer } from './types.js';

/**
 * The one place that knows the implementations. A fork adds its kind to MEDIA_SERVERS and a factory below;
 * config.ts (MEDIA_SERVER) and server.ts pick them up from here.
 */
export const MEDIA_SERVERS = ['jellyfin'] as const;
export type MediaServerKind = (typeof MEDIA_SERVERS)[number];

export interface MediaDeps { cfg: Config; kv: KV; encKey: Buffer; fetchImpl?: typeof fetch }

const factories: Record<MediaServerKind, (d: MediaDeps) => MediaServer> = {
  jellyfin: (d) => new JellyfinService(new JellyfinClient(d.cfg.JELLYFIN_URL!, d.cfg.JELLYFIN_ADMIN_API_KEY!, d.fetchImpl), d.kv, d.encKey),
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
