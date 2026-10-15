// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plex adapter (fork: FriendFlix for Plex). The gateway reaches Plex with ONE admin token (PLEX_TOKEN / PLEX_TOKEN_FILE from its own
 * env, else the one saved in the setup wizard / Admin -> Settings, fetched from the backend's /internal/gateway-config behind the
 * internal secret; sent as the X-Plex-Token header only: never in a URL, a log line, an error or to the client), so Plex cannot
 * enforce per-profile visibility:
 *  - authorize(): every path carries an item id; the gateway asks the backend (/internal/authz/item) whether the session's profile may
 *    see it. Plex part ids and transcode sessions are not item-scoped, so they must carry the backend's HMAC binding (INTERNAL_SECRET):
 *    a visible item id plus a foreign part / session never passes.
 *  - rewrite(): public /media shape -> Plex path; the query is rebuilt from scratch (client parameters never reach Plex).
 * Response headers: the gateway core relays only its fixed list (content-type/length/range, etag, ...), so X-Plex-* never leave.
 * Playlists: Plex session playlists contain relative segment names only (00000.ts), which resolve to /media/Videos/<item>/hls/<s>/…
 * Public shapes and signatures: backend/src/plex/mediapaths.ts (same tests: test-vectors/media-paths.plex.json).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AuthorizeContext, PlaylistContext, Upstream, UpstreamCredentials } from './types.js';

// ---- Plex id codec (copy of backend/src/plex/ids.ts, checked against test-vectors/plex-ids.json)
const PLEX_ID = /^9f1e([0-9a-f])([0-9a-f]{27})$/;
const KINDS = ['item', 'tag', 'section', 'part', 'stream'] as const;
export type PlexIdKind = (typeof KINDS)[number];
export function decodePlexId(id: string): { kind: PlexIdKind; value: string } | null {
  const m = PLEX_ID.exec(id);
  if (!m) return null;
  const kind = KINDS[parseInt(m[1]!, 16)];
  return kind ? { kind, value: BigInt('0x' + m[2]!).toString(10) } : null;
}
const keyOf = (id: string, kind: PlexIdKind) => {
  const d = decodePlexId(id);
  return d && d.kind === kind ? d.value : null;
};

// ---- signatures (copy of backend/src/plex/mediapaths.ts)
const mac = (secret: string, msg: string) => createHmac('sha256', secret).update(`friendflix-plex|${msg}`).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const verifyPartSig = (secret: string, item: string, part: string, sig: string) =>
  /^[0-9a-f]{32}$/.test(sig) && same(mac(secret, `part|${item}|${part}`).slice(0, 32), sig);
export const verifyTpSig = (secret: string, item: string, part: string, sig: string) =>
  /^[0-9a-f]{32}$/.test(sig) && same(mac(secret, `tp|${item}|${part}`).slice(0, 32), sig);
export const verifyChSig = (secret: string, item: string, media: string, sig: string) =>
  /^[0-9a-f]{32}$/.test(sig) && /^\d{1,18}$/.test(media) && same(mac(secret, `ch|${item}|${media}`).slice(0, 32), sig);
export const verifySession = (secret: string, item: string, s: string) =>
  /^[0-9a-f]{16}-[0-9a-f]{24}$/.test(s) && same(`${s.slice(0, 16)}-${mac(secret, `hls|${item}|${s.slice(0, 16)}`).slice(0, 24)}`, s);

// ---- public shapes
const ITEM = '9f1e0[0-9a-f]{27}';
const PART = '9f1e3[0-9a-f]{27}';
const SESS = '[0-9a-f]{16}-[0-9a-f]{24}';
const HLS = new RegExp(`^/Videos/(${ITEM})/hls/(${SESS})/(index\\.m3u8|\\d{5,6}\\.ts)$`);
const STREAM = new RegExp(`^/Videos/(${ITEM})/stream(\\.\\w{2,5})?$`);
const TRICKPLAY = new RegExp(`^/Videos/(${ITEM})/(${PART})/Trickplay/(\\d{3,6})/(\\d{1,6})\\.jpg$`);
const IMAGE = new RegExp(`^/Items/(${ITEM})/Images/(Primary|Backdrop|Logo|Thumb|Banner)(?:/\\d{1,3})?$`);
/** chapter stills: Plex keeps them per media version (/library/media/<media>/chapterImages/<n>), bound to the item by `sig` */
const CHAPTER_IMAGE = new RegExp(`^/Items/(${ITEM})/Images/Chapter/(\\d{1,4})$`);
const CAST_IMAGE = new RegExp(`^/Items/(${ITEM})/Images/(Primary|Backdrop)$`);

const IMAGE_SOURCE: Record<string, string> = { Primary: 'thumb', Backdrop: 'art', Thumb: 'thumb', Logo: 'clearLogo', Banner: 'banner' };
export const TRANSCODE_SESSION = '/video/:/transcode/universal/session';

/** the single value of a query key (case-insensitive); null when absent or repeated */
function one(q: URLSearchParams, key: string): string | null {
  const vals = [...q].filter(([k]) => k.toLowerCase() === key).map(([, v]) => v);
  return vals.length === 1 ? vals[0]! : null;
}
const intIn = (v: string | null, min: number, max: number) => {
  if (v === null || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= min ? Math.min(n, max) : null;
};

/** Primary-image tag `m<item id32>` (a collection poster taken from a visible member): the member id, else null. */
function memberTag(kind: string, tag: string | null): string | null {
  const t = /^m(9f1e0[0-9a-f]{27})$/.exec(tag ?? '');
  return kind === 'Primary' && t ? t[1]! : null;
}

const CREDENTIAL_KEYS = new Set(['x-plex-token', 'token', 'api_key', 'apikey', 'access_token']);
/** One playlist URI without credential query parameters; null when it leaves the session directory (absolute / host / root path). */
function cleanUri(uri: string): string | null {
  const u = uri.trim();
  if (!u) return u;
  if (/^[a-z][\w+.-]*:/i.test(u) || u.startsWith('/') || u.startsWith('\\') || u.includes('..')) return null;
  const q = u.indexOf('?');
  if (q === -1) return u;
  const keep = u.slice(q + 1).split('&').filter((kv) => {
    let k = kv.split('=')[0] ?? '';
    try { k = decodeURIComponent(k); } catch { /* keep raw */ }
    return k !== '' && !CREDENTIAL_KEYS.has(k.toLowerCase()) && !k.toLowerCase().startsWith('x-plex-');
  });
  return keep.length ? `${u.slice(0, q)}?${keep.join('&')}` : u.slice(0, q);
}

/**
 * Playlist hook (defence in depth): Plex session playlists only name relative segments (00000.ts), and the gateway sends the token
 * as a header - but should a PMS version ever put X-Plex-Token (or any X-Plex-* parameter) into a URI, it is removed here, and a URI
 * pointing outside the session directory (absolute URL, /path, ..) fails the request (502) instead of exposing the Plex address.
 */
export function plexPlaylist(body: string, _ctx?: PlaylistContext): string {
  return body.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (_all, uri: string) => {
        const c = cleanUri(uri);
        if (c === null) throw new Error('plex playlist: URI outside the session');
        return `URI="${c}"`;
      });
    }
    const c = cleanUri(line);
    if (c === null) throw new Error('plex playlist: URI outside the session');
    return c;
  }).join('\n');
}

/**
 * Startup check (Upstream.validateConfig): a PLEX_URL that is set must be an http(s) URL, a PLEX_TOKEN_FILE that is set must be readable
 * and non-empty. Neither set is fine (remote mode, settings in the database): the gateway takes them from the backend and answers
 * /media with 503 until the setup saved them.
 */
export function validatePlexEnv(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const url = (env.PLEX_URL ?? '').trim();
  if (url) {
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) problems.push('PLEX_URL must be an http(s) URL');
    } catch {
      problems.push('PLEX_URL is not a valid URL');
    }
  }
  const file = (env.PLEX_TOKEN_FILE ?? '').trim();
  if (file) {
    try {
      if (!readFileSync(file, 'utf8').trim()) problems.push('PLEX_TOKEN_FILE is empty');
    } catch {
      problems.push('PLEX_TOKEN_FILE cannot be read');
    }
  }
  return problems;
}

/** Reads VAR or the file named by VAR_FILE (Docker secrets), once. */
function envSecret(name: string): () => string {
  let v: string | undefined;
  return () => {
    if (v) return v;
    const f = process.env[`${name}_FILE`];
    const val = (f ? readFileSync(f, 'utf8') : process.env[name] ?? '').trim();
    if (!val) throw new Error(`missing env ${name}`);
    return (v = val);
  };
}

export interface PlexUpstreamOptions {
  /** the Plex admin token (default: PLEX_TOKEN / PLEX_TOKEN_FILE; bind(): the env pin, else the backend's) */
  token?: () => string;
  /** the shared signing secret (default: INTERNAL_SECRET / INTERNAL_SECRET_FILE; bind(): the gateway's resolved one, bootstrap volume included) */
  secret?: () => string;
}

/** Plex photo transcoder query for a server-relative image path; only size + quality are taken from the client. */
function photoQuery(src: string, query: URLSearchParams): URLSearchParams {
  const w = intIn(one(query, 'maxwidth') ?? one(query, 'width'), 16, 3840);
  const h = intIn(one(query, 'maxheight') ?? one(query, 'height'), 16, 3840);
  const q = new URLSearchParams({ url: src, width: String(w ?? (h ? h * 4 : 1920)), height: String(h ?? (w ? w * 4 : 1920)), minSize: '0', upscale: '0' });
  const quality = intIn(one(query, 'quality'), 1, 100);
  if (quality) q.set('quality', String(quality));
  return q;
}

export function createPlexUpstream(o: PlexUpstreamOptions = {}): Upstream {
  const token = o.token ?? envSecret('PLEX_TOKEN');
  const secret = o.secret ?? envSecret('INTERNAL_SECRET');

  async function authorize(c: AuthorizeContext): Promise<boolean> {
    let m: RegExpExecArray | null;
    if ((m = HLS.exec(c.path))) {
      if (!verifySession(secret(), m[1]!, m[2]!)) return false;
      return c.checkItem(m[1]!, 'media');
    }
    if ((m = STREAM.exec(c.path))) {
      const part = one(c.query, 'mediasourceid');
      const sig = one(c.query, 'sig');
      if (!part || !sig || !keyOf(part, 'part') || !verifyPartSig(secret(), m[1]!, part, sig)) return false;
      return c.checkItem(m[1]!, 'media');
    }
    if ((m = TRICKPLAY.exec(c.path))) {
      const sig = one(c.query, 'sig');
      if (!sig || !verifyTpSig(secret(), m[1]!, m[2]!, sig)) return false;
      return c.checkItem(m[1]!, 'media');
    }
    if ((m = CHAPTER_IMAGE.exec(c.path))) {
      const media = one(c.query, 'media');
      const sig = one(c.query, 'sig');
      if (!media || !sig || !verifyChSig(secret(), m[1]!, media, sig)) return false;
      return c.checkItem(m[1]!, 'image');
    }
    if ((m = IMAGE.exec(c.path))) {
      // a collection's poster may name one of its members (tag m<item id32>): the viewer must be allowed to see that member too
      const member = memberTag(m[2]!, one(c.query, 'tag'));
      if (member && !(await c.checkItem(member, 'image'))) return false;
      return c.checkItem(m[1]!, 'image');
    }
    return false; // fail closed for anything the allowlist may grow later
  }

  function rewrite(path: string, query: URLSearchParams): { path: string; query: URLSearchParams } {
    let m: RegExpExecArray | null;
    const none = new URLSearchParams();
    if ((m = HLS.exec(path))) return { path: `${TRANSCODE_SESSION}/${m[2]}/base/${m[3]}`, query: none };
    if (STREAM.test(path)) {
      // cookie requests passed authorize (signed part); offline 'original' downloads name the part from the backend's licence
      const part = keyOf(one(query, 'mediasourceid') ?? '', 'part');
      if (!part) throw new Error('plex: stream without media source');
      return { path: `/library/parts/${part}/0/file`, query: none };
    }
    if ((m = TRICKPLAY.exec(path))) {
      const part = keyOf(m[2]!, 'part')!;
      return { path: `/library/parts/${part}/indexes/sd/${Number(m[3]) * Number(m[4])}`, query: none };
    }
    if ((m = CHAPTER_IMAGE.exec(path))) {
      const media = one(query, 'media');
      if (!media || !/^\d{1,18}$/.test(media)) throw new Error('plex: chapter image without media');
      return { path: '/photo/:/transcode', query: photoQuery(`/library/media/${media}/chapterImages/${Number(m[2])}`, query) };
    }
    if ((m = IMAGE.exec(path))) {
      const rk = keyOf(m[1]!, 'item')!;
      const tag = one(query, 'tag') ?? '';
      const member = memberTag(m[2]!, tag);
      // collection composites (/library/collections/<rk>/composite/…) are never served: they show members the viewer may not see
      let src = member ? `/library/metadata/${keyOf(member, 'item')}/thumb` : `/library/metadata/${rk}/${IMAGE_SOURCE[m[2]!]}`;
      if (!member && /^\d{1,12}$/.test(tag)) src += `/${tag}`;
      return { path: '/photo/:/transcode', query: photoQuery(src, query) };
    }
    throw new Error('plex: no rewrite for path'); // unreachable for allowlisted paths
  }

  return {
    kind: 'plex',
    urlEnv: 'PLEX_URL',
    paths: [HLS, STREAM, TRICKPLAY, IMAGE, CHAPTER_IMAGE],
    // Chromecast: HLS + poster/backdrop only (no direct streams, no trickplay); subtitles are served by the backend
    castPaths: [HLS, CAST_IMAGE],
    directStream: STREAM,
    image: /^\/Items\//,
    stripQuery: new Set(['x-plex-token', 'token', 'api_key', 'apikey']),
    castDropQuery: new Set(['x-plex-client-identifier', 'deviceid']),
    clampHeight: ['maxheight', 'height'],
    clampWidth: ['maxwidth', 'width'],
    clampBitrate: [], // bitrate and resolution caps are applied by the backend when it starts the transcode
    // No requireBitrate (Block 20): rewrite() rebuilds every Plex query from scratch, so a bitrate param injected or clamped here would
    // never reach Plex. The transcode's maxVideoBitrate / videoResolution are fixed by the backend at start (decision + start.m3u8 with
    // the role / remote cap of POST /api/playback/info); the session URLs the client fetches carry no parameters Plex would read.
    // cred.token is the FriendFlix identity (no secret); the Plex token comes from this process' env or the backend, never the client
    authHeaders: (_c: UpstreamCredentials) => ({ 'X-Plex-Token': token(), 'X-Plex-Client-Identifier': 'friendflix-gateway', 'X-Plex-Product': 'FriendFlix' }),
    authorize,
    rewrite,
    validateConfig: validatePlexEnv,
    playlist: plexPlaylist,
    gatewayKeys: ['PLEX_TOKEN'],
    // the running gateway's adapter (server.ts via bindUpstream): signatures with the resolved INTERNAL_SECRET, the token from the env pin
    // or the backend. A missing token throws a message without any value; server.ts keeps /media at 503 until it is there.
    bind: (rt) => createPlexUpstream({
      secret: rt.secret,
      token: () => {
        const t = rt.value('PLEX_TOKEN');
        if (!t) throw new Error('plex: no token yet');
        return t;
      },
    }),
  };
}

/** The registered adapter (env read lazily, on first use: a Jellyfin gateway never needs PLEX_TOKEN). */
export const plexUpstream: Upstream = createPlexUpstream();
