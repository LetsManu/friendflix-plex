// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the gateway needs to know about the media server behind /media/: which upstream paths it may forward, which
 * query parameters carry credentials or caps, and how to authenticate as the user. One adapter per server kind
 * (./jellyfin.ts); ./index.ts picks it at startup from MEDIA_SERVER.
 */
export interface UpstreamCredentials { token: string; deviceId: string }

/** What an authorize() hook sees for one request (after the allowlist, session and direct-stream checks passed). */
export interface AuthorizeContext {
  /** normalized upstream path (public shape, before rewrite) and the request query */
  path: string;
  query: URLSearchParams;
  /** true on the Chromecast route (token-scoped to one item; checkItem compares with that scope) */
  cast: boolean;
  /**
   * May the session see this item? Cookie path: POST /internal/authz/item {sid, itemId, kind} on the backend (memoised 5 s here),
   * which answers with the visibility of the session's active profile. Cast path: the token's item scope.
   */
  checkItem(itemId: string, kind: 'media' | 'image' | 'subtitle'): Promise<boolean>;
}

/** What a playlist() hook sees for one HLS playlist response (status 200, before the cast sanitising). */
export interface PlaylistContext {
  /** normalized upstream path (public shape, before rewrite) and the request query */
  path: string;
  query: URLSearchParams;
  /** public path the client requested (/media/… or /media/c/<token>/…): relative URIs in the body resolve against it */
  requestPath: string;
  /** true on the Chromecast route; the result then still goes through the gateway's cast playlist sanitising */
  cast: boolean;
}

export interface Upstream {
  readonly kind: string;
  /** env var holding the upstream base URL (e.g. JELLYFIN_URL) */
  readonly urlEnv: string;
  /** allowlist for cookie requests; anything else is refused (the gateway is never a general proxy) */
  readonly paths: RegExp[];
  /** Chromecast subset (token in the URL path): playlists, segments, VTT subtitles, poster images */
  readonly castPaths: RegExp[];
  /** original (untranscoded) streams: refused for roles with a height cap or without download rights */
  readonly directStream: RegExp;
  /** images: cacheable per user; the only thing a cast 'img' token may fetch */
  readonly image: RegExp;
  /** lower-case query keys that carry credentials: never forwarded, stripped from cast playlists */
  readonly stripQuery: ReadonlySet<string>;
  /** lower-case query keys dropped on the cast path (stream/device identity comes from the token) */
  readonly castDropQuery: ReadonlySet<string>;
  /** lower-case query keys clamped to the height cap / its 16:9 width / the bitrate cap */
  readonly clampHeight: readonly string[];
  readonly clampWidth: readonly string[];
  readonly clampBitrate: readonly string[];
  /**
   * Bitrate params every request on `path` (the transcoded streams) must carry: a missing one is added, set to the bitrate cap
   * (present ones are clamped through clampBitrate). Without it the media server could pick the source bitrate and bypass the cap.
   * `params` are written exactly as the media server spells them.
   */
  readonly requireBitrate?: { readonly path: RegExp; readonly params: readonly string[] };
  /** headers that authenticate an upstream request as the user */
  authHeaders(cred: UpstreamCredentials): Record<string, string>;
  /**
   * Optional per-request access check, for servers where the gateway authenticates with one server-wide token (so the server
   * itself cannot enforce per-profile visibility). false = 403. Jellyfin: absent (the user's own token enforces access).
   */
  authorize?(c: AuthorizeContext): Promise<boolean>;
  /**
   * Optional mapping of the public path shape (/media/<path>?<query>, what the web and the backend's DTOs use) to the upstream
   * request, after query filtering/clamping. Must stay server-relative. Jellyfin: absent (identity).
   */
  rewrite?(path: string, query: URLSearchParams): { path: string; query: URLSearchParams };
  /**
   * Optional startup check of the gateway environment (e.g. settings the adapter needs besides urlEnv). Non-empty = the gateway
   * refuses to start and names the problems. Jellyfin: absent.
   */
  validateConfig?(env: NodeJS.ProcessEnv): string[];
  /**
   * Optional rewrite of HLS playlist bodies (*.m3u8, status 200) on the cookie path and the cast path, e.g. to drop a credential the
   * server put into segment URIs. Defining it makes those playlists buffered (no Range / conditional requests). A throw answers 502.
   * Jellyfin: absent, so cookie playlists stream through unchanged.
   */
  playlist?(body: string, ctx: PlaylistContext): string;
}
