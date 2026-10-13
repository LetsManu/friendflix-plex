/**
 * AirPlay stream probe (diagnosis): what does the TV get? After a token request the controller fetches the token's master playlist
 * (and the first variant playlist) the way the receiver does (no cookies) and logs a SANITIZED summary to the AirPlay event log.
 * Sanitizing is an allowlist: only the tag names and attributes below are ever emitted, values only when they look harmless
 * (word characters, dot, comma, dash, space), URIs only as kind + file extension, never a query string, token or id.
 */

const MASTER_ATTRS = new Set(['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'CODECS', 'RESOLUTION', 'FRAME-RATE', 'VIDEO-RANGE', 'TYPE', 'GROUP-ID', 'AUDIO', 'SUBTITLES', 'CLOSED-CAPTIONS', 'DEFAULT', 'AUTOSELECT', 'LANGUAGE']);
const SAFE_VALUE = /^[\w.,\- ]{0,80}$/;
const MAX_LINES = 400;

export type UriKind = 'rel' | 'abs' | 'root';

export function uriKind(u: string): UriKind {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u)) return 'abs';
  return u.startsWith('/') ? 'root' : 'rel';
}

/** `.m3u8` of `a/b/main.m3u8?x=1#y` (query and fragment never looked at beyond cutting them off) */
export function uriExt(u: string): string {
  const path = u.split(/[?#]/, 1)[0] ?? '';
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(path.slice(path.lastIndexOf('/') + 1));
  return m ? `.${m[1]!.toLowerCase()}` : '.none';
}

const uriItem = (u: string) => `uri:${uriKind(u)} ${uriExt(u)}`;

const safe = (v: string) => { const s = v.replace(/^"|"$/g, ''); return SAFE_VALUE.test(s) ? v : '?'; };

/** `KEY=value` pairs of a tag's attribute list (quoted values may contain commas) */
function attrs(list: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out.push([m[1]!, m[2]!]);
  return out;
}

const tagOf = (line: string): { name: string; rest: string } => {
  const m = /^#([A-Za-z0-9-]+)(?::(.*))?$/.exec(line);
  return m ? { name: m[1]!, rest: m[2] ?? '' } : { name: '?', rest: '' };
};

/** one sanitized item per line of a master playlist (see the module comment); lines of the same text collapse to `item x N` */
export function summarizeMaster(text: string): string[] {
  const items: string[] = [];
  const push = (s: string) => {
    const last = items[items.length - 1];
    const m = last ? /^(.*) x(\d+)$/.exec(last) : null;
    if (last === s) items[items.length - 1] = `${s} x2`;
    else if (m && m[1] === s) items[items.length - 1] = `${s} x${Number(m[2]) + 1}`;
    else items.push(s);
  };
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) { push(uriItem(line)); continue; }
    const { name, rest } = tagOf(line);
    const parts = [name];
    for (const [k, v] of attrs(rest)) {
      if (k === 'URI') parts.push(uriItem(v.replace(/^"|"$/g, '')));
      else if (MASTER_ATTRS.has(k)) parts.push(`${k}=${safe(v)}`);
    }
    push(parts.join(' '));
  }
  return items;
}

/** the first variant URI: the first non-# line after an #EXT-X-STREAM-INF (null when there is none) */
export function firstVariantUri(text: string): string | null {
  let seen = false;
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) seen = true;
    else if (!line.startsWith('#') && seen) return line;
  }
  return null;
}

/** media playlist summary: version, target duration, type, sequence, flags, segment count, first segment kind + extension */
export function summarizeVariant(text: string): string {
  const val = (name: string, rest: string) => `${name.replace(/^EXT-X-/, '')}=${safe(rest.trim())}`;
  const out: string[] = [];
  let extinf = 0, first: string | null = null, expectUri = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      if (expectUri && first === null) first = uriItem(line);
      expectUri = false;
      continue;
    }
    const { name, rest } = tagOf(line);
    switch (name) {
      case 'EXT-X-VERSION': case 'EXT-X-TARGETDURATION': case 'EXT-X-PLAYLIST-TYPE': case 'EXT-X-MEDIA-SEQUENCE': out.push(val(name, rest)); break;
      case 'EXT-X-MAP': case 'EXT-X-ENDLIST': case 'EXT-X-INDEPENDENT-SEGMENTS': case 'EXT-X-START': out.push(name.replace(/^EXT-X-/, '')); break;
      case 'EXTINF': extinf++; expectUri = true; break;
      default: break;
    }
  }
  return [...out, `EXTINF x${extinf}`, first ? `first ${first}` : 'first -'].join(' | ');
}

/** a MediaError message without URLs, /media paths or long id-like strings */
export function scrubMessage(m: string | null | undefined): string {
  return (m ?? '').replace(/https?:\/\/\S+/gi, '<url>').replace(/\/media\/\S+/g, '<url>').replace(/[A-Za-z0-9_-]{32,}/g, '<id>').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** summary items -> log notes of at most `max` characters (split at item boundaries, at most `maxParts` notes) */
export function chunkNotes(items: string[], max = 480, maxParts = 4): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const it of items) {
    const piece = it.length > max ? it.slice(0, max) : it;
    if (cur && cur.length + piece.length + 3 > max) { parts.push(cur); cur = piece; }
    else cur = cur ? `${cur} | ${piece}` : piece;
  }
  if (cur) parts.push(cur);
  return parts.length > maxParts ? [...parts.slice(0, maxParts - 1), `${parts[maxParts - 1]!} | (truncated)`] : parts;
}

export interface ProbeFetch { status: number; ctype: string; bytes: number; text: string }

/** one GET without credentials; the CDN-like cast path answers CORS * */
export async function fetchText(url: string): Promise<ProbeFetch> {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  const text = await res.text();
  return { status: res.status, ctype: (res.headers.get('content-type') ?? '-').split(';')[0]!.trim().replace(/[^\w./+-]/g, '?').slice(0, 60), bytes: new TextEncoder().encode(text).length, text };
}

export const errName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' && /^[A-Za-z]{1,40}$/.test(n) ? n : 'Error';
};

type Log = (ev: string, note: string) => void;

/** fetch master (+ first variant) and log; never throws */
export async function runProbe(contentUrl: string, log: Log, alive: () => boolean): Promise<void> {
  if (!alive() || typeof fetch !== 'function') return;
  let master: ProbeFetch;
  try { master = await fetchText(contentUrl); } catch (e) { if (alive()) log('probe-master-fail', `error ${errName(e)}`); return; }
  if (!alive()) return;
  const meta = `HTTP ${master.status} ${master.ctype} ${master.bytes} B`;
  if (master.status !== 200) { log('probe-master', `${meta} (not 200)`); return; }
  const notes = chunkNotes(summarizeMaster(master.text));
  log('probe-master', [meta, notes[0]].filter(Boolean).join(' | '));
  notes.slice(1).forEach((n, i) => log('probe-master', `part ${i + 2}: ${n}`));

  const rel = firstVariantUri(master.text);
  if (rel === null) { log('probe-variant', 'no variant in master'); return; }
  let url: string;
  try { url = new URL(rel, contentUrl).href; } catch { log('probe-variant', 'variant URI unresolvable'); return; }
  let v: ProbeFetch;
  try { v = await fetchText(url); } catch (e) { if (alive()) log('probe-variant-fail', `error ${errName(e)}`); return; }
  if (!alive()) return;
  const vmeta = `HTTP ${v.status} ${v.ctype} ${v.bytes} B`;
  log('probe-variant', v.status === 200 ? `${vmeta} | ${summarizeVariant(v.text)}` : `${vmeta} (not 200)`);
}
