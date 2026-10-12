/**
 * Plex adapter (fork: FriendFlix for Plex). The gateway reaches Plex with ONE admin token (PLEX_TOKEN / PLEX_TOKEN_FILE from its own
 * env, sent as the X-Plex-Token header only: never in a URL, never to the client), so Plex cannot enforce per-profile visibility:
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
import type { AuthorizeContext, Upstream, UpstreamCredentials } from './types.js';

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
  /** the Plex admin token (default: PLEX_TOKEN / PLEX_TOKEN_FILE) */
  token?: () => string;
  /** the shared signing secret (default: INTERNAL_SECRET / INTERNAL_SECRET_FILE) */
  secret?: () => string;
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
      if (!sig || !verifyPartSig(secret(), m[1]!, m[2]!, sig)) return false;
      return c.checkItem(m[1]!, 'media');
    }
    if ((m = IMAGE.exec(c.path))) return c.checkItem(m[1]!, 'image');
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
    if ((m = IMAGE.exec(path))) {
      const rk = keyOf(m[1]!, 'item')!;
      const tag = one(query, 'tag') ?? '';
      let src = `/library/metadata/${rk}/${IMAGE_SOURCE[m[2]!]}`;
      if (/^\d{1,12}$/.test(tag)) src += `/${tag}`;
      else if (m[2] === 'Primary' && /^c\d{1,12}$/.test(tag)) src = `/library/collections/${rk}/composite/${tag.slice(1)}`;
      const w = intIn(one(query, 'maxwidth') ?? one(query, 'width'), 16, 3840);
      const h = intIn(one(query, 'maxheight') ?? one(query, 'height'), 16, 3840);
      const q = new URLSearchParams({ url: src, width: String(w ?? (h ? h * 4 : 1920)), height: String(h ?? (w ? w * 4 : 1920)), minSize: '0', upscale: '0' });
      const quality = intIn(one(query, 'quality'), 1, 100);
      if (quality) q.set('quality', String(quality));
      return { path: '/photo/:/transcode', query: q };
    }
    throw new Error('plex: no rewrite for path'); // unreachable for allowlisted paths
  }

  return {
    kind: 'plex',
    urlEnv: 'PLEX_URL',
    paths: [HLS, STREAM, TRICKPLAY, IMAGE],
    // Chromecast: HLS + poster/backdrop only (no direct streams, no trickplay); subtitles are served by the backend
    castPaths: [HLS, CAST_IMAGE],
    directStream: STREAM,
    image: /^\/Items\//,
    stripQuery: new Set(['x-plex-token', 'token', 'api_key', 'apikey']),
    castDropQuery: new Set(['x-plex-client-identifier', 'deviceid']),
    clampHeight: ['maxheight', 'height'],
    clampWidth: ['maxwidth', 'width'],
    clampBitrate: [], // bitrate and resolution caps are applied by the backend when it starts the transcode
    // cred.token is the FriendFlix identity (no secret); the Plex token comes from this process' env only
    authHeaders: (_c: UpstreamCredentials) => ({ 'X-Plex-Token': token(), 'X-Plex-Client-Identifier': 'friendflix-gateway', 'X-Plex-Product': 'FriendFlix' }),
    authorize,
    rewrite,
  };
}

/** The registered adapter (env read lazily, on first use: a Jellyfin gateway never needs PLEX_TOKEN). */
export const plexUpstream: Upstream = createPlexUpstream();
