import { jellyfinUpstream } from './jellyfin.js';
import type { Upstream } from './types.js';

export type { AuthorizeContext, Upstream, UpstreamCredentials } from './types.js';
export { jellyfinUpstream };

/** Known adapters by MEDIA_SERVER value (same values as the backend's MEDIA_SERVER). A fork adds its adapter here. */
export const UPSTREAMS: Record<string, Upstream> = { jellyfin: jellyfinUpstream };

/** The adapter for MEDIA_SERVER (default jellyfin); throws on an unknown value so a typo never starts a gateway. */
export function selectUpstream(kind: string | undefined): Upstream {
  const k = (kind ?? '').trim().toLowerCase() || 'jellyfin';
  const u = Object.hasOwn(UPSTREAMS, k) ? UPSTREAMS[k] : undefined;
  if (!u) throw new Error(`unknown MEDIA_SERVER "${kind}" (known: ${Object.keys(UPSTREAMS).join(', ')})`);
  return u;
}
