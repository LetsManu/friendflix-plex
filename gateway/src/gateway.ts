// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { jellyfinUpstream, type Upstream } from './upstream/index.js';

export { mediaBrowserHeader } from './upstream/jellyfin.js';

export interface GatewayOptions {
  /** media server adapter (allowlist, credential params, auth header); default Jellyfin */
  upstream?: Upstream;
  /** base URL of the media server */
  upstreamUrl?: string;
  /** @deprecated alias of upstreamUrl */
  jellyfinUrl?: string;
  backendUrl: string;
  internalSecret: string;
  metricsToken?: string;
  fetchImpl?: typeof fetch;
  /** directory holding prepared offline downloads (read-only mount); without it 'file' downloads answer 503 */
  downloadDir?: string;
}

/** Answer of the backend for {sid, dl}: the user's media credentials plus what to serve. Names/paths come from the backend only. */
export type DownloadTarget =
  | { kind: 'file'; file: string; size: number; etag: string }
  | { kind: 'static'; path: string; query?: Record<string, string> };
type DownloadAuthz = Authz & { download: DownloadTarget };

const DL_ROUTE = /^\/media\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Shared-vector helper: the download id of a public request path (no query, no fragment), or null. */
export const matchDownloadPath = (raw: string): string | null => DL_ROUTE.exec(raw)?.[1] ?? null;
const DL_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;
const DL_ETAG = /^[\w.-]{1,128}$/;
const DL_MAX_OPEN = 2;

interface Authz {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
  /** only present for Chromecast tokens: the one item / media source / play session the token may touch */
  scope?: { itemId: string; mediaSourceId: string; playSessionId: string };
  /** cast only: 'img' tokens may fetch poster images and nothing else (default 'media') */
  kind?: 'media' | 'img';
  /** resolution cap: role limit (cookie path, when the role has one) or cast token cap (role limit, at most 1080) */
  maxHeight?: number;
  /** role may download originals; anything but `true` (missing, older backend) counts as no, so direct streams fail closed */
  canDownload?: boolean;
}

/**
 * Allowlist of upstream paths (of the default Jellyfin adapter, see upstream/jellyfin.ts). Anything else is rejected, so the
 * gateway can never be used as a general proxy to the media server (or any other host: the upstream origin is fixed anyway).
 */
export const ALLOWED_PATHS: RegExp[] = jellyfinUpstream.paths;

/** Chromecast subset (token in the URL path, no cookie) of the default adapter. */
export const CAST_PATHS: RegExp[] = jellyfinUpstream.castPaths;
const CAST_ROUTE = /^\/media\/c\/([A-Za-z0-9_-]{43})(\/.*)$/;
const CAST_PREFIX = '/media/c/';
const CAST_PLAYLIST_MAX = 8 * 1024 * 1024; // very long films at short segment lengths reach several MB
const CAST_FAIL_LIMIT = 30; // DISTINCT failing tokens per minute and client address
const CAST_BLOCK_MS = 5 * 60_000;
const CAST_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
  'cross-origin-resource-policy': 'cross-origin',
};

/**
 * Direct (original) streams bypass the transcoder, so the resolution cap and the download flag cannot be enforced on them.
 * Roles with a height cap or without download rights get HLS only; every direct stream request is refused.
 */
export const blocksDirectStream = (path: string, auth: Pick<Authz, 'maxHeight' | 'canDownload'>, up: Upstream = jellyfinUpstream) =>
  up.directStream.test(path) && (Boolean(auth.maxHeight) || auth.canDownload !== true);

const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition'];

/** Returns a safe normalized path or null. Rejects traversal, encoded slashes, backslashes, control chars. */
export function normalizePath(raw: string, allow: RegExp[] = ALLOWED_PATHS): string | null {
  if (/%2f|%5c|%00|%2e%2e/i.test(raw)) return null;
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes('..') || p.includes('\\') || p.includes('//') || /[\x00-\x1f]/.test(p)) return null;
  return allow.some((re) => re.test(p)) ? p : null;
}

/**
 * Address sent as `ip` to /internal/authz (decides the remote bitrate cap): X-Real-IP, else the LAST X-Forwarded-For entry (clientKey rule).
 * Without a usable forwarding header only a loopback peer is passed on; any other peer (a docker bridge, say) is 'unknown' = remote.
 */
export function authClientIp(headers: IncomingMessage['headers'], peer: string | undefined): string {
  const real = headers['x-real-ip'];
  const xff = headers['x-forwarded-for'];
  const fwd = (typeof real === 'string' ? real.trim() : '') || (typeof xff === 'string' ? xff : '').split(',').pop()?.trim() || '';
  if (fwd) return fwd.slice(0, 64);
  return peer && (peer === '::1' || /^(::ffff:)?127\./.test(peer)) ? peer.slice(0, 64) : 'unknown';
}

export const normalizeCastPath = (raw: string, up: Upstream = jellyfinUpstream) => normalizePath(raw, up.castPaths);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const lc = (v: string) => v.replace(/-/g, '').toLowerCase();

/** Removes token-like parameters from one playlist URI (relative, optionally with a query). */
export function stripUriTokens(uri: string, strip: ReadonlySet<string> = jellyfinUpstream.stripQuery): string {
  const q = uri.indexOf('?');
  if (q === -1) return uri;
  const keep = uri.slice(q + 1).split('&').filter((kv) => {
    let k = kv.split('=')[0] ?? '';
    try { k = decodeURIComponent(k); } catch { /* keep raw */ }
    return !strip.has(k.toLowerCase());
  });
  return keep.length ? `${uri.slice(0, q)}?${keep.join('&')}` : uri.slice(0, q);
}

/** `#EXT-X-STREAM-INF` attributes the compatibility master keeps (AUDIO / VIDEO only while their EXT-X-MEDIA group is kept) */
const COMPAT_STREAM_ATTRS = new Set(['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'CODECS', 'RESOLUTION', 'FRAME-RATE']);
const COMPAT_GROUP_ATTRS = new Set(['AUDIO', 'VIDEO']);

/**
 * `KEY=value` pairs of an HLS attribute list (quoted values may contain commas). A single linear scan, no regex: the list comes
 * from the upstream playlist, and a backtracking pattern would be quadratic on hostile input (long runs without `=`).
 */
export function hlsAttrs(list: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < list.length) {
    const eq = list.indexOf('=', i);
    if (eq === -1) break;
    const key = list.slice(i, eq).trim();
    let end: number;
    if (list[eq + 1] === '"') {
      const close = list.indexOf('"', eq + 2);
      end = close === -1 ? list.length : close + 1;
    } else {
      const comma = list.indexOf(',', eq + 1);
      end = comma === -1 ? list.length : comma;
    }
    if (/^[A-Z0-9-]+$/.test(key)) out.push([key, list.slice(eq + 1, end)]);
    const next = list.indexOf(',', end);
    if (next === -1) break;
    i = next + 1;
  }
  return out;
}
const unquote = (v: string) => v.replace(/^"|"$/g, '');

/**
 * Cast / AirPlay compatibility master: the receivers (Apple TV, AirPlay 2 TVs from LG, Samsung, Sony, Vizio, Roku ..., Chromecast's
 * Default Media Receiver) get a strict, plain Apple-HLS master playlist. Field bug: an LG webOS TV fetched Jellyfin's master and then
 * nothing else (MEDIA_ERR_SRC_NOT_SUPPORTED) - the only non-Apple element in it was Jellyfin's trickplay line.
 * - `#EXT-X-IMAGE-*` (Roku-style trickplay image playlists, `#EXT-X-IMAGE-STREAM-INF ... CODECS="jpeg"`) is dropped, in any playlist;
 *   an image tag without a URI attribute takes the URI line after it along.
 * - `#EXT-X-MEDIA:TYPE=SUBTITLES` / `TYPE=CLOSED-CAPTIONS` groups are dropped (receivers have failed on subtitle groups; cast
 *   subtitles use their own side-loaded path), and with them the `SUBTITLES=` / `CLOSED-CAPTIONS=` references.
 * - `#EXT-X-STREAM-INF` keeps only BANDWIDTH, AVERAGE-BANDWIDTH, CODECS, RESOLUTION, FRAME-RATE, and AUDIO / VIDEO when that group
 *   is still declared. VIDEO-RANGE ruling (draft-pantos-hls-rfc8216bis-17): it carries NO EXT-X-VERSION requirement (section 8 ties
 *   versions only to IV, float EXTINF, BYTERANGE, MAP, INSTREAM-ID SERVICE, variable substitution, SKIP, QUERYPARAM and REQ-
 *   attributes), but it is a 2nd-edition attribute that RFC 8216 (1st edition) parsers in older TV firmware do not know, and
 *   "its absence implies a value of SDR". The cast stream is forced to H.264 8 bit (Level 41, MaxVideoBitDepth 8), i.e. SDR, so
 *   dropping it loses nothing and removes one more thing a strict receiver can choke on. HDCP-LEVEL, ALLOWED-CPC, PATHWAY-ID,
 *   SUPPLEMENTAL-CODECS, REQ-* and other newer attributes go for the same reason.
 * - Every other tag (EXTM3U, EXT-X-VERSION, EXT-X-INDEPENDENT-SEGMENTS, media playlist tags, EXT-X-I-FRAME-STREAM-INF ...) and all
 *   media playlists stay as they are.
 * Runs on the already URI-checked / token-stripped lines (sanitizePlaylist), so the hardening is unaffected.
 */
export function compatPlaylist(lines: string[]): string[] {
  const dropTypes = /^(SUBTITLES|CLOSED-CAPTIONS)$/;
  const groups = new Set<string>(); // `TYPE:GROUP-ID` of kept EXT-X-MEDIA renditions
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = new Map(hlsAttrs(line.slice(13)));
    const type = a.get('TYPE') ?? '';
    if (!dropTypes.test(type)) groups.add(`${type}:${unquote(a.get('GROUP-ID') ?? '')}`);
  }
  const out: string[] = [];
  let skipUri = false;
  for (const line of lines) {
    const t = line.trim();
    if (skipUri && t && !t.startsWith('#')) { skipUri = false; continue; }
    if (t.startsWith('#EXT-X-IMAGE-')) {
      if (/-INF:/.test(t) && !/URI\s*=/i.test(t)) skipUri = true;
      continue;
    }
    if (t.startsWith('#EXT-X-MEDIA:')) {
      if (dropTypes.test(new Map(hlsAttrs(t.slice(13))).get('TYPE') ?? '')) continue;
      out.push(line);
      continue;
    }
    if (t.startsWith('#EXT-X-STREAM-INF:')) {
      const kept = hlsAttrs(t.slice(18)).filter(([k, v]) => COMPAT_STREAM_ATTRS.has(k) || (COMPAT_GROUP_ATTRS.has(k) && groups.has(`${k}:${unquote(v)}`)));
      out.push(`#EXT-X-STREAM-INF:${kept.map(([k, v]) => `${k}=${v}`).join(',')}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Cast playlist hardening: strips api_key-like params from every URI and refuses (null) any URI that does not stay inside
 * /media/c/<token>/ on the same origin once resolved against the playlist's own URL (absolute URLs, //host, /abs paths,
 * ../ escapes, backslash tricks): the receiver would otherwise fetch from another host/path and leak or bypass the gateway.
 * `requestPath` is the public path the playlist was requested at (/media/c/<token>/Videos/<id>/main.m3u8).
 * Then the compatibility rewrite for the receivers (compatPlaylist). Every line is URI-checked, also the ones it drops.
 */
export function sanitizePlaylist(text: string, requestPath: string, strip: ReadonlySet<string> = jellyfinUpstream.stripQuery): string | null {
  const m = CAST_ROUTE.exec(requestPath);
  if (!m) return null;
  const prefix = `${CAST_PREFIX}${m[1]}/`;
  const base = `https://h${requestPath.slice(0, requestPath.lastIndexOf('/') + 1)}`;
  let bad = false;
  const check = (u: string) => {
    if (u.includes('\\')) return void (bad = true);
    try {
      const r = new URL(u, base);
      if (r.origin !== 'https://h' || !r.pathname.startsWith(prefix)) bad = true;
    } catch {
      bad = true;
    }
  };
  const out = text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) {
      return line.replace(/(URI\s*=\s*["']?)([^"',]*)/gi, (_m, pre: string, u: string) => {
        check(u);
        return `${pre}${stripUriTokens(u, strip)}`;
      });
    }
    const t = line.trim();
    if (!t) return line;
    check(t);
    return stripUriTokens(t, strip);
  });
  return bad ? null : compatPlaylist(out).join('\n');
}

export function createGateway(opts: GatewayOptions): { server: Server; metrics: () => string } {
  const f = opts.fetchImpl ?? fetch;
  const up = opts.upstream ?? jellyfinUpstream;
  const upstreamUrl = opts.upstreamUrl ?? opts.jellyfinUrl;
  if (!upstreamUrl) throw new Error('gateway: upstreamUrl missing');
  const base = new URL(upstreamUrl);
  const authCache = new Map<string, { exp: number; v: Authz | null }>();
  const castCache = new Map<string, { exp: number; v: Authz | null }>();
  const castFails = new Map<string, { start: number; hashes: Set<string>; blockedUntil: number }>();
  const dlOpen = new Map<string, number>();
  const dlCache = new Map<string, { exp: number; v: DownloadAuthz | 401 | 404 }>();
  const m = { dlBytes: 0, bytes: 0, active: 0, req: new Map<string, number>(), cast: new Map<string, number>() };
  const count = (k: string) => m.req.set(k, (m.req.get(k) ?? 0) + 1);

  const metrics = () =>
    [
      '# TYPE friendflix_gateway_bytes_total counter',
      `friendflix_gateway_bytes_total ${m.bytes}`,
      '# TYPE friendflix_gateway_download_bytes_total counter',
      `friendflix_gateway_download_bytes_total ${m.dlBytes}`,
      '# TYPE friendflix_gateway_active_streams gauge',
      `friendflix_gateway_active_streams ${m.active}`,
      '# TYPE friendflix_gateway_requests_total counter',
      ...[...m.req].map(([k, v]) => `friendflix_gateway_requests_total{code="${k}"} ${v}`),
      '# TYPE friendflix_gateway_cast_requests_total counter',
      ...[...m.cast].map(([k, v]) => `friendflix_gateway_cast_requests_total{code="${k}"} ${v}`),
    ].join('\n') + '\n';

  /**
   * Session -> media credentials, memoised 5 s (denials 2 s). Single flight: the ~30 image/segment requests a page fires right
   * after the memo expired share ONE backend call. Backend failures (network, 5xx) are not memoised, so the next request retries.
   */
  const authInflight = new Map<string, Promise<Authz | null>>();

  /** Upstream.authorize helper: item visibility of the session's active profile (backend /internal/authz/item), memoised 5 s. */
  const itemCache = new Map<string, { exp: number; v: boolean }>();
  async function checkItem(sid: string, itemId: string, kind: 'media' | 'image' | 'subtitle'): Promise<boolean> {
    const id = lc(itemId);
    if (!/^[0-9a-f]{32}$/.test(id)) return false;
    const key = `${sha256(sid)}|${id}`; // never keep the raw session id as a key; visibility does not depend on the kind
    const hit = itemCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const r = await f(new URL('/internal/authz/item', opts.backendUrl), {
      method: 'POST',
      headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ sid, itemId: id, kind }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 401) return false;
    if (!r.ok) throw new Error(`authz/item ${r.status}`); // backend trouble: 503, not cached
    const v = ((await r.json()) as { allow?: unknown }).allow === true;
    itemCache.set(key, { exp: Date.now() + 5_000, v });
    if (itemCache.size > 5000) itemCache.clear();
    return v;
  }
  /** The backend lowers maxBitrate for callers outside the home networks, so the answer depends on the client address (same rule as clientKey). */
  async function authorize(cookie: string | undefined, ip: string): Promise<Authz | null> {
    const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(cookie ?? '')?.[1];
    if (!sid) return null;
    const key = `${sid}|${ip}`;
    const hit = authCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const running = authInflight.get(key);
    if (running) return running;
    const p = (async () => {
      let v: Authz | null = null;
      let cacheable = true;
      try {
        const r = await f(new URL('/internal/authz', opts.backendUrl), {
          method: 'POST',
          headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
          body: JSON.stringify({ sid, ip }),
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) v = (await r.json()) as Authz;
        else if (r.status >= 500) cacheable = false;
      } catch {
        v = null;
        cacheable = false;
      }
      if (cacheable) {
        authCache.set(key, { exp: Date.now() + (v ? 5_000 : 2_000), v });
        if (authCache.size > 5000) authCache.clear();
      }
      return v;
    })().finally(() => authInflight.delete(key));
    authInflight.set(key, p);
    return p;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return end(res, 200, '{"status":"ok"}', 'application/json');
    if (url.pathname === '/metrics') {
      if (opts.metricsToken && req.headers.authorization !== `Bearer ${opts.metricsToken}`) return end(res, 401, 'unauthorized');
      return end(res, 200, metrics(), 'text/plain; version=0.0.4');
    }
    if (url.pathname.startsWith(CAST_PREFIX)) return handleCast(req, res, url);
    if (url.pathname.startsWith('/media/d/')) return handleDownload(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
    if (!url.pathname.startsWith('/media/')) return end(res, 404, 'not found');

    const path = normalizePath(url.pathname.slice('/media'.length), up.paths);
    if (!path) {
      count('403');
      return end(res, 403, 'forbidden');
    }
    if (tooLong(url)) {
      count('414');
      return end(res, 414, 'query too long');
    }
    const t0 = performance.now();
    const auth = await authorize(req.headers.cookie, authClientIp(req.headers, req.socket.remoteAddress));
    const authzMs = performance.now() - t0;
    if (!auth) {
      count('401');
      return end(res, 401, 'unauthorized');
    }
    if (blocksDirectStream(path, auth, up)) {
      count('403');
      return end(res, 403, 'forbidden');
    }
    if (up.authorize) {
      const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(req.headers.cookie ?? '')![1]!;
      const ok = await up.authorize({ path, query: url.searchParams, cast: false, checkItem: (id, kind) => checkItem(sid, id, kind) }).catch(() => 'error' as const);
      if (ok !== true) {
        count(ok === 'error' ? '503' : '403');
        return ok === 'error' ? end(res, 503, 'unavailable') : end(res, 403, 'forbidden');
      }
    }
    return forward(req, res, url, path, auth, count, false, false, authzMs);
  }

  /** 'error' = backend failing (not cached, 503). null = unknown/invalid session or licence. */
  async function authorizeDownload(sid: string, dl: string): Promise<DownloadAuthz | 401 | 404 | 'error'> {
    const key = `${sha256(sid)}|${dl}`; // never keep the raw session id as a key
    const hit = dlCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v: DownloadAuthz | 401 | 404 = 401;
    try {
      const r = await f(new URL('/internal/authz', opts.backendUrl), {
        method: 'POST',
        headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ sid, dl }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const j = (await r.json()) as DownloadAuthz;
        if (!j?.download || (j.download.kind !== 'file' && j.download.kind !== 'static')) return 'error';
        v = j;
      } else if (r.status === 404) v = 404;
      else if (r.status !== 401) return 'error';
    } catch {
      return 'error';
    }
    dlCache.set(key, { exp: Date.now() + (typeof v === 'object' ? 5_000 : 2_000), v });
    if (dlCache.size > 5000) dlCache.clear();
    return v;
  }

  /** GET/HEAD /media/d/<downloadId>: cookie auth + licence check; no query, no CORS, never cacheable. */
  async function handleDownload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const fail = (code: number, body: string, extra: Record<string, string> = {}) => {
      count(String(code));
      return end(res, code, body, 'text/plain', { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    };
    const mm = DL_ROUTE.exec(url.pathname);
    if (!mm) return fail(404, 'not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed', { allow: 'GET, HEAD' });
    if (url.search !== '') return fail(400, 'bad request'); // nothing in the query may influence what is served
    const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sid) return fail(401, 'unauthorized');
    const t0 = performance.now();
    const auth = await authorizeDownload(sid, mm[1]!);
    const authzMs = performance.now() - t0;
    if (auth === 'error') return fail(503, 'unavailable');
    if (auth === 401) return fail(401, 'unauthorized');
    if (auth === 404) return fail(404, 'not found');

    const head = req.method === 'HEAD';
    if (!head) {
      if ((dlOpen.get(auth.userId) ?? 0) >= DL_MAX_OPEN) return fail(429, 'too many downloads', { 'retry-after': '5' });
      dlOpen.set(auth.userId, (dlOpen.get(auth.userId) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (dlOpen.get(auth.userId) ?? 1) - 1;
        if (n <= 0) dlOpen.delete(auth.userId);
        else dlOpen.set(auth.userId, n);
      };
      res.once('close', release);
    }

    const t = auth.download;
    if (t.kind === 'static') {
      const path = normalizePath(t.path, up.paths);
      if (!path) return fail(403, 'forbidden');
      const target = new URL(path, 'http://x');
      for (const [k, v] of Object.entries(t.query ?? {})) target.searchParams.set(k, v);
      return forward(req, res, target, path, auth, count, false, true, authzMs);
    }
    return serveFile(req, res, t);
  }

  async function serveFile(req: IncomingMessage, res: ServerResponse, t: Extract<DownloadTarget, { kind: 'file' }>) {
    const fail = (code: number, body: string, extra: Record<string, string> = {}) => {
      count(String(code));
      return end(res, code, body, 'text/plain', { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    };
    if (!opts.downloadDir) return fail(503, 'unavailable');
    if (!DL_FILE.test(t.file) || !DL_ETAG.test(t.etag) || !Number.isSafeInteger(t.size) || t.size < 0) return fail(500, 'error');
    const root = await realpath(resolve(opts.downloadDir)).catch(() => null);
    if (!root) return fail(503, 'unavailable');
    const full = resolve(root, t.file);
    if (!full.startsWith(root + sep)) return fail(500, 'error');
    let fh;
    try {
      fh = await open(full, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    } catch {
      return fail(404, 'not found');
    }
    let handedOver = false;
    try {
      const st = await fh.stat();
      const real = await realpath(full).catch(() => null);
      if (!st.isFile() || real !== full) return fail(404, 'not found');
      if (st.size !== t.size) return fail(503, 'not ready', { 'retry-after': '30' });
      const size = st.size;
      const etag = `"${t.etag}"`;
      const base: Record<string, string> = {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        etag,
        vary: 'Cookie',
      };
      let start = 0;
      let endB = size - 1;
      let partial = false;
      const rh = req.headers.range;
      const ifRange = req.headers['if-range'];
      if (typeof rh === 'string' && (ifRange === undefined || ifRange === etag)) {
        const r = /^bytes=(\d*)-(\d*)$/.exec(rh.trim()); // exactly one range; lists and other units are refused
        let ok = false;
        if (r && (r[1] || r[2])) {
          if (!r[1]) {
            const n = Number(r[2]);
            if (n > 0) { start = Math.max(0, size - n); endB = size - 1; ok = size > 0; }
          } else {
            start = Number(r[1]);
            endB = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
            ok = start < size && start <= endB;
          }
        }
        if (!ok) return fail(416, 'range not satisfiable', { 'content-range': `bytes */${size}` });
        partial = true;
      }
      const len = size === 0 ? 0 : endB - start + 1;
      const hdr = { ...base, 'content-length': String(len), ...(partial ? { 'content-range': `bytes ${start}-${endB}/${size}` } : {}) };
      count(partial ? '206' : '200');
      res.writeHead(partial ? 206 : 200, hdr);
      if (req.method === 'HEAD' || len === 0) return void res.end();
      handedOver = true;
      m.active++;
      const rs = fh.createReadStream({ start, end: endB, autoClose: true });
      rs.on('data', (c) => (m.dlBytes += c.length));
      rs.on('error', () => res.destroy());
      res.once('close', () => {
        m.active--;
        rs.destroy();
      });
      rs.pipe(res);
    } finally {
      if (!handedOver) await fh.close().catch(() => {});
    }
  }

  const tooLong = (url: URL) => url.search.length > 2049 || [...url.searchParams].length > 40;

  // ---- Chromecast: /media/c/<token>/<jellyfin path> (token in the path because the receiver sends no cookies) ----
  const castCount = (k: string) => m.cast.set(k, (m.cast.get(k) ?? 0) + 1);
  const clientKey = (req: IncomingMessage) => {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    const last = (typeof xff === 'string' ? xff : '').split(',').pop()?.trim(); // the proxy appends the real peer last
    return (last || req.socket.remoteAddress || 'unknown').slice(0, 64);
  };
  const isBlocked = (ip: string) => (castFails.get(ip)?.blockedUntil ?? 0) > Date.now();
  /** counts DISTINCT failing token hashes per window: one stale/revoked token retried by a receiver is not an attack, guessing is */
  function noteFail(ip: string, tokenHash: string) {
    const now = Date.now();
    let e = castFails.get(ip);
    if (!e || now - e.start > 60_000) e = { start: now, hashes: new Set(), blockedUntil: e?.blockedUntil ?? 0 };
    if (e.hashes.size <= CAST_FAIL_LIMIT) e.hashes.add(tokenHash); // bounded memory
    if (e.hashes.size > CAST_FAIL_LIMIT) e.blockedUntil = now + CAST_BLOCK_MS;
    castFails.set(ip, e);
    if (castFails.size > 5000) castFails.clear();
  }

  /** 'error' = backend unreachable/failing (not the caller's fault: never counted as a failed auth). */
  async function authorizeCast(ct: string, client: string): Promise<Authz | null | 'error'> {
    const key = `${sha256(ct)}|${client}`; // the raw token is never used as a cache key; the answer depends on the client (first client pins the token)
    const hit = castCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v: Authz | null = null;
    try {
      const r = await f(new URL('/internal/authz', opts.backendUrl), {
        method: 'POST',
        headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ ct, client }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const j = (await r.json()) as Authz;
        if (!j.scope) return 'error'; // a cast answer without scope would be an unscoped token: never use it
        v = j;
      } else if (r.status !== 401) return 'error';
    } catch {
      return 'error';
    }
    castCache.set(key, { exp: Date.now() + (v ? 5_000 : 2_000), v });
    if (castCache.size > 5000) castCache.clear();
    return v;
  }

  /** item id (first 32-hex id of the path) and media source id (second one, subtitles only) must match the token's scope */
  function inScope(path: string, url: URL, scope: NonNullable<Authz['scope']>): boolean {
    const ids = path.match(/[0-9a-fA-F]{32}/g) ?? [];
    if (!ids[0] || lc(ids[0]) !== lc(scope.itemId)) return false;
    if (ids[1] && lc(ids[1]) !== lc(scope.mediaSourceId)) return false;
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (lk === 'mediasourceid' && lc(v) !== lc(scope.mediaSourceId)) return false;
      if (lk === 'playsessionid' && v !== scope.playSessionId) return false;
    }
    return true;
  }

  async function handleCast(req: IncomingMessage, res: ServerResponse, url: URL) {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    const mm = CAST_ROUTE.exec(url.pathname);
    if (!mm) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CAST_CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range, Content-Type', 'access-control-max-age': '600' });
      return void res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return cors(405, 'method not allowed');
    const ip = clientKey(req);
    if (isBlocked(ip)) {
      castCount('429');
      res.setHeader('retry-after', '300');
      return cors(429, 'too many requests');
    }
    const path = normalizeCastPath(mm[2]!, up);
    if (!path) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (tooLong(url)) {
      castCount('414');
      return cors(414, 'query too long');
    }
    const tokenHash = sha256(mm[1]!);
    const t0 = performance.now();
    const auth = await authorizeCast(mm[1]!, ip);
    const authzMs = performance.now() - t0;
    if (auth === 'error') {
      castCount('503');
      return cors(503, 'unavailable');
    }
    if (!auth || !auth.scope) {
      noteFail(ip, tokenHash);
      castCount('401');
      return cors(401, 'unauthorized');
    }
    if (auth.kind === 'img' && !up.image.test(path)) {
      castCount('403'); // poster tokens may fetch images only
      return cors(403, 'forbidden');
    }
    if (!inScope(path, url, auth.scope)) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (up.authorize) {
      const scope = auth.scope;
      const ok = await up.authorize({ path, query: url.searchParams, cast: true, checkItem: async (id) => lc(id) === lc(scope.itemId) }).catch(() => 'error' as const);
      if (ok !== true) {
        castCount(ok === 'error' ? '503' : '403');
        return cors(ok === 'error' ? 503 : 403, ok === 'error' ? 'unavailable' : 'forbidden');
      }
    }
    return forward(req, res, url, path, auth, castCount, true, false, authzMs);
  }

  async function forward(req: IncomingMessage, res: ServerResponse, url: URL, path: string, auth: Authz, countCode: (k: string) => void, cast = false, download = false, authzMs = 0) {
    let target = new URL(path, base);
    if (target.origin !== base.origin) return end(res, 403, 'forbidden'); // SSRF guard (defence in depth)
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (up.stripQuery.has(lk)) continue;
      if (cast && up.castDropQuery.has(lk)) continue; // stream/device identity comes from the token, never from the receiver's URL
      // resolution cap: always on the cast path (default 1080), on the cookie path when the role has one
      if ((cast || auth.maxHeight) && (up.clampHeight.includes(lk) || up.clampWidth.includes(lk))) {
        const cap = auth.maxHeight ?? 1080;
        const lim = up.clampWidth.includes(lk) ? Math.ceil((cap * 16) / 9) : cap; // widths: 16:9 equivalent of the height cap
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, lim) : lim));
        continue;
      }
      if (up.clampBitrate.includes(lk)) {
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, auth.maxBitrate) : auth.maxBitrate));
        continue;
      }
      target.searchParams.append(k, v);
    }
    // a transcoded stream without the bitrate params would run at the source bitrate: add the missing ones at the cap
    if (up.requireBitrate?.path.test(path)) {
      const have = new Set([...target.searchParams.keys()].map((k) => k.toLowerCase()));
      for (const p of up.requireBitrate.params) if (!have.has(p.toLowerCase())) target.searchParams.set(p, String(auth.maxBitrate));
    }
    if (up.rewrite) {
      const r = up.rewrite(target.pathname, target.searchParams);
      const q = r.query.toString();
      if (!r.path.startsWith('/') || r.path.startsWith('//') || r.path.includes('\\')) return end(res, 502, 'bad gateway');
      target = new URL(`${r.path}${q ? `?${q}` : ''}`, base);
      if (target.origin !== base.origin) return end(res, 502, 'bad gateway');
    }
    const requestUrl = `${base.origin}${target.pathname}${target.search}`;
    const m3u8 = /\.m3u8$/.test(path);
    // cast playlists are always sanitised; other playlists are only touched when the adapter has a playlist() hook (Jellyfin: none)
    const playlist = m3u8 && (cast || Boolean(up.playlist));
    const extra = cast ? CAST_CORS : undefined;

    // identity: keep upstream bytes as-is so content-length matches the body we relay
    const headers: Record<string, string> = { ...up.authHeaders(auth), 'accept-encoding': 'identity' };
    // rewritten playlists are always fetched whole and unconditionally
    for (const h of playlist ? ['accept'] : ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let upRes: Response;
    const tUp = performance.now();
    try {
      upRes = await f(requestUrl, { method: req.method, headers, signal: ac.signal, redirect: 'manual' });
    } catch {
      countCode('502');
      return end(res, 502, 'bad gateway', 'text/plain', extra);
    }
    countCode(String(upRes.status));
    if (upRes.status >= 300 && upRes.status < 400 && upRes.status !== 304) return end(res, 502, 'bad gateway', 'text/plain', extra);

    const out: Record<string, string> = {};
    for (const h of PASS_RESPONSE_HEADERS) {
      // fetch decodes content-encoding transparently, so the upstream length no longer describes the body
      if (h === 'content-length' && upRes.headers.get('content-encoding')) continue;
      const v = upRes.headers.get(h);
      if (v) out[h] = v;
    }
    out['x-content-type-options'] = 'nosniff';
    // authz = session check (memo hit ~0 ms), upstream = time until Jellyfin's response headers (transcoder start, image resize)
    out['server-timing'] = `authz;dur=${ms(authzMs)}, upstream;dur=${ms(performance.now() - tUp)}`;
    if (cast) {
      // the URL carries a credential: nothing may be cached (browser or shared), and CORS is open (the receiver has another origin)
      out['cache-control'] = 'no-store';
      Object.assign(out, CAST_CORS);
    } else if (download) {
      out['cache-control'] = 'no-store'; // licensed content behind a cookie: never stored by a cache, no CORS headers
      out['vary'] = 'Cookie';
    } else if (up.image.test(path) && upRes.status < 400) {
      // Images are static per `tag` (Jellyfin's image tag changes with the image): with a tag the URL is immutable, without one
      // the browser revalidates after a day. Always private: never in shared caches such as NPM (access is per user).
      // Everything else (playlists, segments, streams) stays uncacheable unless Jellyfin says otherwise.
      out['cache-control'] = hasImageTag(url) ? 'private, max-age=31536000, immutable' : 'private, max-age=86400, stale-while-revalidate=604800';
      out['vary'] = 'Cookie';
    } else {
      out['cache-control'] = (out['cache-control'] ?? 'no-store').replace(/\bpublic\b/i, 'private');
    }

    if (playlist && upRes.status === 200) {
      // buffered (<8 MB) so every URI can be checked: Jellyfin may emit api_key params or absolute URLs
      const len = Number(upRes.headers.get('content-length') ?? 0);
      if (len > CAST_PLAYLIST_MAX) return end(res, 502, 'bad gateway', 'text/plain', extra);
      if (req.method === 'HEAD') {
        delete out['content-length'];
        res.writeHead(200, out);
        return void res.end();
      }
      const buf = Buffer.from(await upRes.arrayBuffer());
      let text: string | null = buf.length > CAST_PLAYLIST_MAX ? null : buf.toString('utf8');
      if (text !== null && up.playlist) {
        try {
          text = up.playlist(text, { path, query: url.searchParams, requestPath: url.pathname, cast });
        } catch {
          text = null;
        }
      }
      const clean = text === null ? null : cast ? sanitizePlaylist(text, url.pathname, up.stripQuery) : text;
      if (clean === null) {
        countCode('502');
        return end(res, 502, 'bad gateway', 'text/plain', extra);
      }
      const body = Buffer.from(clean, 'utf8');
      out['content-length'] = String(body.length);
      delete out['etag'];
      res.writeHead(200, out);
      m.bytes += body.length;
      return void res.end(body);
    }

    res.writeHead(upRes.status, out);
    if (!upRes.body || req.method === 'HEAD') return void res.end();

    m.active++;
    const body = Readable.fromWeb(upRes.body as never);
    body.on('data', (c: Buffer) => { m.bytes += c.length; if (download) m.dlBytes += c.length; });
    const done = () => {
      m.active--;
    };
    res.once('close', done);
    body.on('error', () => res.destroy());
    body.pipe(res); // streamed, no buffering; backpressure handled by pipe
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) end(res, 500, 'error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  return { server, metrics };
}

const ms = (v: number) => (Math.round(v * 10) / 10).toString();
/** a non-empty `tag` query parameter (Jellyfin image tag, hex) marks a versioned image URL */
const hasImageTag = (url: URL) => /^[\w-]{1,64}$/.test(url.searchParams.get('tag') ?? '');

function end(res: ServerResponse, code: number, body: string, type = 'text/plain', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': type, ...extra });
  res.end(body);
}
