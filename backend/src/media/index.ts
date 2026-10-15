// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { JellyfinClient } from '../jellyfin/client.js';
import { JellyfinService } from '../jellyfin/service.js';
import type { KV } from '../kv.js';
import { createPlexMediaServer } from '../plex/index.js';
import type { SettingDef } from '../settings/registry.js';
import { MEDIA_SETUP } from './setup.js';
import type { MediaServer } from './types.js';

/**
 * The one place that knows the implementations. A fork adds its kind to MEDIA_SERVERS, its fields to MEDIA_FIELDS, its settings to
 * mediaSettings() and a factory below, and its setup provider to MEDIA_SETUP (media/setup.ts); config.ts (MEDIA_SERVER, the fields), the
 * settings registry and server.ts pick them up from here.
 */
export const MEDIA_SERVERS = ['jellyfin', 'plex'] as const;
export type MediaServerKind = (typeof MEDIA_SERVERS)[number];

/**
 * The config fields of every media server kind (config.ts spreads them into its schema). They live here, not in config.ts, so a fork adds
 * its fields, settings and factory in this one file; config.ts imports this module, so nothing here may read config.ts at load time.
 */
export const MEDIA_FIELDS = {
  JELLYFIN_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()), // compose passes '' when unset
  JELLYFIN_ADMIN_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  /** FriendFlix for Plex: base URL of the existing Plex Media Server and its admin token (backend + gateway only) */
  PLEX_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  PLEX_TOKEN: z.string().optional().transform((v) => (v ? v : undefined)),
};

/** Registry entries of the media server settings (Admin -> Settings "media", wizard step 3); required once setup is complete for their kind. */
export function mediaSettings(): SettingDef[] {
  const jellyfin = (c: Config) => c.MEDIA_SERVER === 'jellyfin';
  const plex = (c: Config) => c.MEDIA_SERVER === 'plex';
  return [
    { key: 'JELLYFIN_URL', kind: 'url', group: 'media', schema: MEDIA_FIELDS.JELLYFIN_URL, apply: 'live', probe: 'media', runRequired: jellyfin },
    { key: 'JELLYFIN_ADMIN_API_KEY', kind: 'secret', group: 'media', schema: MEDIA_FIELDS.JELLYFIN_ADMIN_API_KEY, secret: true, apply: 'live', probe: 'media', runRequired: jellyfin },
    // fork: the Plex server's address and token (encrypted at rest, write-only in the UI; env / PLEX_TOKEN_FILE still win and show locked)
    { key: 'PLEX_URL', kind: 'url', group: 'media', schema: MEDIA_FIELDS.PLEX_URL, apply: 'live', probe: 'media', runRequired: plex },
    { key: 'PLEX_TOKEN', kind: 'secret', group: 'media', schema: MEDIA_FIELDS.PLEX_TOKEN, secret: true, apply: 'live', probe: 'media', runRequired: plex },
  ];
}

/** The media settings of cfg's kind: those it requires (registry runRequired), all of mediaSettings() when none says so. */
function kindSettings(cfg: Config): SettingDef[] {
  const all = mediaSettings();
  const mine = all.filter((d) => (typeof d.runRequired === 'function' ? d.runRequired(cfg) : d.runRequired));
  return mine.length ? mine : all;
}

/** The registry keys of cfg's kind in field order (the wizard's media step): its setup provider's, else the manual fields of mediaSettings(). */
export function mediaSetupKeys(cfg: Config): readonly string[] {
  return MEDIA_SETUP[cfg.MEDIA_SERVER]?.keys ?? kindSettings(cfg).map((d) => d.key);
}

/** The config key holding the media server URL of cfg's kind (the gateway's upstream, /internal/gateway-config): the one place that knows it. */
export function mediaUrlKey(cfg: Config): string {
  const key = MEDIA_SETUP[cfg.MEDIA_SERVER]?.urlKey ?? kindSettings(cfg).find((d) => d.kind === 'url')?.key;
  if (!key) throw new Error(`media server kind ${cfg.MEDIA_SERVER} has neither a setup provider nor a url setting`);
  return key;
}

/** fork: settings the gateway needs besides the URL (MediaSetupProvider.gatewayKeys; Plex: PLEX_TOKEN); none for a kind without. */
export function mediaGatewayKeys(cfg: Config): readonly string[] {
  return MEDIA_SETUP[cfg.MEDIA_SERVER]?.gatewayKeys ?? [];
}

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
