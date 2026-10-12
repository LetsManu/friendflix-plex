/**
 * Public /media URL shapes of the Plex implementation and the signatures that bind them to an item.
 *
 * The gateway reaches Plex with ONE server-wide admin token, so Plex cannot tell which FriendFlix profile asks. The gateway therefore
 * checks every item-bearing path itself (backend /internal/authz/item for the item id in the path) and – because Plex part ids and
 * transcode sessions are not item-scoped – the backend binds them to the item with an HMAC (key: INTERNAL_SECRET, which backend and
 * gateway share anyway). A visible item id plus a foreign part id / session therefore never verifies.
 *
 *   HLS (player + cast)   /media/Videos/<item>/hls/<session>/index.m3u8   session = <16 hex nonce>-<24 hex mac(item, nonce)>
 *                         Plex playlists are relative (NNNNN.ts) and resolve to /media/Videos/<item>/hls/<session>/NNNNN.ts
 *   direct play           /media/Videos/<item>/stream?MediaSourceId=<part id32>&sig=<mac(item, part)>
 *   trickplay (BIF)       /media/Videos/<item>/<part id32>/Trickplay/<interval ms>/{n}.jpg?sig=<mac(item, part)>
 *   images                /media/Items/<item>/Images/<Primary|Backdrop|Logo|Thumb|Banner>  (the web builds these itself)
 *
 * The gateway keeps its own copy of the verification (gateway/src/upstream/plex.ts); both are checked against
 * test-vectors/media-paths.plex.json. Never put the Plex token into any of these.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const mac = (secret: string, msg: string) => createHmac('sha256', secret).update(`friendflix-plex|${msg}`).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** sig binding a media part (id32) to an item (id32): 32 hex */
export const partSig = (secret: string, itemId: string, partId: string) => mac(secret, `part|${itemId}|${partId}`).slice(0, 32);
export const verifyPartSig = (secret: string, itemId: string, partId: string, sig: string) => /^[0-9a-f]{32}$/.test(sig) && same(partSig(secret, itemId, partId), sig);

export const SESSION_RE = /^[0-9a-f]{16}-[0-9a-f]{24}$/;
/** Plex transcode session id bound to an item (no 32-hex run, so the gateway's cast scope check sees the item id only). */
export function sessionFor(secret: string, itemId: string, nonce = randomBytes(8).toString('hex')): string {
  return `${nonce}-${mac(secret, `hls|${itemId}|${nonce}`).slice(0, 24)}`;
}
export function verifySession(secret: string, itemId: string, session: string): boolean {
  if (!SESSION_RE.test(session)) return false;
  return same(sessionFor(secret, itemId, session.slice(0, 16)), session);
}

export const hlsUrl = (itemId: string, session: string) => `/media/Videos/${itemId}/hls/${session}/index.m3u8`;
export const directUrl = (secret: string, itemId: string, partId: string) =>
  `/media/Videos/${itemId}/stream?${new URLSearchParams({ MediaSourceId: partId, sig: partSig(secret, itemId, partId) })}`;
export const trickplayUrl = (secret: string, itemId: string, partId: string, intervalMs: number) =>
  `/media/Videos/${itemId}/${partId}/Trickplay/${intervalMs}/{n}.jpg?sig=${partSig(secret, itemId, partId)}`;
/** Served by the backend itself (capabilities.subtitleExtract): GET /api/items/:id/subtitle/:ms/:index/stream.vtt */
export const subtitleUrl = (itemId: string, partId: string, index: number) => `/api/items/${itemId}/subtitle/${partId}/${index}/stream.vtt`;

// ---- Plex (upstream) paths used by the backend
export const TRANSCODE = '/video/:/transcode/universal';
export const sessionPath = (session: string, file: string) => `${TRANSCODE}/session/${session}/base/${file}`;
/** server-relative paths mediaFetch() forwards to Plex: the files of a transcode session only */
export const SESSION_FILE_RE = /^\/video\/:\/transcode\/universal\/session\/([0-9a-f]{16}-[0-9a-f]{24})\/base\/(index\.m3u8|\d{1,6}\.ts)$/;
