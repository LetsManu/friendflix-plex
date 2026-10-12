/**
 * Request validation for the /media path, used by the nginx auth_request endpoint (Plan B).
 * Mirrors gateway/src/gateway.ts; both are tested against test-vectors/media-paths.json.
 */
const ID = '[0-9a-fA-F]{32}';
export const ALLOWED_PATHS: RegExp[] = [
  new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`),
  new RegExp(`^/Videos/${ID}/(hls1?|hls)/[\\w.-]+/[\\w.-]+$`),
  new RegExp(`^/Videos/${ID}/stream(\\.\\w{2,5})?$`),
  new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d{1,3}/\\d{1,10}/Stream\\.(vtt|srt)$`),
  new RegExp(`^/Videos/${ID}/Trickplay/\\d{2,4}/\\d{1,5}\\.jpg$`),
  new RegExp(`^/Items/${ID}/Images/(Primary|Backdrop|Logo|Thumb|Banner)(/\\d{1,3})?$`),
];

const STREAM_PATH = new RegExp(`^/Videos/${ID}/stream(\\.\\w{2,5})?$`);
const STRIP_QUERY = new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token', 'token']);
const CLAMP_QUERY = new Set(['maxstreamingbitrate', 'videobitrate']);
const CLAMP_HEIGHT = new Set(['maxheight', 'height']);
const CLAMP_WIDTH = new Set(['maxwidth', 'width']);
export const MAX_QUERY_LENGTH = 2048;
export const MAX_QUERY_PARAMS = 40;

export function normalizePath(raw: string): string | null {
  if (/%2f|%5c|%00|%2e%2e/i.test(raw)) return null;
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes('..') || p.includes('\\') || p.includes('//') || /[\x00-\x1f]/.test(p)) return null;
  return ALLOWED_PATHS.some((re) => re.test(p)) ? p : null;
}

/**
 * Turns the browser's request URI (/media/<path>?<query>) into the URI nginx may request from Jellyfin:
 * validated path, token-like params removed, bitrate clamped to the role limit, query re-encoded.
 * Returns null for anything that is not allowed.
 */
export function upstreamUri(originalUri: string, maxBitrate: number, maxHeight?: number, canDownload = true): string | null {
  if (typeof originalUri !== 'string' || originalUri.length > 4096 || /[\r\n\x00]/.test(originalUri)) return null;
  const q = originalUri.indexOf('?');
  const rawPath = q === -1 ? originalUri : originalUri.slice(0, q);
  const rawQuery = q === -1 ? '' : originalUri.slice(q + 1);
  if (!rawPath.startsWith('/media/') || rawQuery.length > MAX_QUERY_LENGTH) return null;
  const path = normalizePath(rawPath.slice('/media'.length));
  if (!path) return null;
  // direct streams skip the transcoder: refused for height-capped roles and roles without download rights (same rule as the gateway)
  if (STREAM_PATH.test(path) && (maxHeight || !canDownload)) return null;
  const params = new URLSearchParams(rawQuery);
  if ([...params].length > MAX_QUERY_PARAMS) return null;
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    const lk = k.toLowerCase();
    if (STRIP_QUERY.has(lk)) continue;
    if (CLAMP_QUERY.has(lk)) {
      const n = Number(v);
      out.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, maxBitrate) : maxBitrate));
      continue;
    }
    if (maxHeight && (CLAMP_HEIGHT.has(lk) || CLAMP_WIDTH.has(lk))) {
      const lim = CLAMP_WIDTH.has(lk) ? Math.ceil((maxHeight * 16) / 9) : maxHeight; // widths: 16:9 equivalent of the height cap
      const n = Number(v);
      out.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, lim) : lim));
      continue;
    }
    out.append(k, v);
  }
  const s = out.toString();
  return s ? `${path}?${s}` : path;
}
