// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { optional } from '../env.js';
import { jellyfinUpstream } from './jellyfin.js';
import { plexUpstream } from './plex.js';
import type { Upstream } from './types.js';

export type { AuthorizeContext, PlaylistContext, Upstream, UpstreamCredentials, UpstreamRuntime } from './types.js';
export { jellyfinUpstream };

/** Known adapters by MEDIA_SERVER value (same values as the backend's MEDIA_SERVER). A fork adds its adapter here. */
export const UPSTREAMS: Record<string, Upstream> = { jellyfin: jellyfinUpstream, plex: plexUpstream };

/** The adapter for MEDIA_SERVER (default jellyfin); throws on an unknown value so a typo never starts a gateway. */
export function selectUpstream(kind: string | undefined): Upstream {
  const k = (kind ?? '').trim().toLowerCase() || 'jellyfin';
  const u = Object.hasOwn(UPSTREAMS, k) ? UPSTREAMS[k] : undefined;
  if (!u) throw new Error(`unknown MEDIA_SERVER "${kind}" (known: ${Object.keys(UPSTREAMS).join(', ')})`);
  return u;
}

/** Startup check: throws (gateway does not start) when the adapter's validateConfig() reports problems with `env`. */
export function checkUpstreamConfig(up: Upstream, env: NodeJS.ProcessEnv): void {
  const problems = up.validateConfig?.(env) ?? [];
  if (problems.length) throw new Error(`MEDIA_SERVER=${up.kind}: invalid gateway configuration: ${problems.join('; ')}`);
}

/** fork: the adapter's gatewayKeys the env (VAR or VAR_FILE) does not pin: remoteConfig asks the backend for these. */
export function remoteKeys(up: Upstream, env: NodeJS.ProcessEnv): string[] {
  return (up.gatewayKeys ?? []).filter((k) => !optional(env, k));
}

/**
 * fork: the adapter bound to the running gateway (Upstream.bind): `secret` is the INTERNAL_SECRET server.ts resolved (env, _FILE or the
 * bootstrap volume), each gatewayKeys value is the env pin (read once, here) or else `remote.value(key)` (the backend's live settings).
 */
export function bindUpstream(up: Upstream, env: NodeJS.ProcessEnv, secret: string, remote: { value(key: string): string | null }): Upstream {
  if (!up.bind) return up;
  const pinned = new Map((up.gatewayKeys ?? []).map((k) => [k, optional(env, k)] as const));
  return up.bind({ secret: () => secret, value: (k) => pinned.get(k) ?? remote.value(k) });
}
