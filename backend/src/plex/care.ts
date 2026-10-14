// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 22 (admin care) on Plex: active sessions with play method (`GET /status/sessions`), library hygiene facts
 * (`GET /library/sections` + `GET /library/sections/<id>/all?includeGuids=1`) and the metadata refresh
 * (`PUT /library/metadata/<ratingKey>/refresh`), mapped to the neutral types of ../media/types.ts.
 *
 * Only whitelisted fields are read: file paths (Part.file), player / client IP addresses and transcode URLs never reach a DTO.
 *
 * What Plex cannot say:
 * - transcode reasons: Plex has no reason list (see reason.ts). A burnt-in subtitle reads as 'subtitles', a converted audio track
 *   only as 'audioCodec', a converted video as 'other'.
 * - library listings carry no streams. Stream facts (languages, subtitles, bit depth, HDR) come from the mirror's detail data
 *   (sync.ts) when it has the item; an item the mirror has not detailed yet gets no streams, which the hygiene rules treat as
 *   "not probed" (no language findings, codec findings from the next scan on).
 * - `updatedAt` is not bumped by every metadata edit (sync.ts), so an incremental hygiene scan can miss such an edit until the
 *   next full sweep.
 */
import type { HygieneFacts, HygieneSource, HygieneStream, ServerSession, TranscodeReason } from '../media/types.js';
import { providerIdsOf } from './about.js';
import { PlexError, type PlexClient, type PlexContainer } from './client.js';
import { encodePlexId } from './ids.js';
import { SESSION_RE } from './mediapaths.js';
import { guidsOf } from './mirror.js';

const str = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const lc = (v: unknown, max = 40) => str(v, max)?.toLowerCase();
const RK = /^\d{1,18}$/;
const dropUndef = <T extends Record<string, unknown>>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};
/** ms (Plex) -> 100 ns ticks (neutral DTOs) */
const ticks = (ms: unknown) => {
  const n = num(ms);
  return n === undefined ? undefined : Math.round(n * 10_000);
};
const itemType = (t: unknown): string | undefined => ({ movie: 'Movie', episode: 'Episode', show: 'Series', clip: 'Video', track: 'Audio' } as Record<string, string>)[String(t)];

// ---------------------------------------------------------------- active sessions

const asDecision = (v: unknown): 'copy' | 'transcode' | undefined => {
  const s = lc(v);
  return s === 'copy' || s === 'directstream' ? 'copy' : s === 'transcode' ? 'transcode' : undefined;
};

/** The transcode session id of `TranscodeSession.key` (`/transcode/sessions/<id>`). */
function transcodeId(ts: Record<string, any> | undefined): string | undefined {
  const m = /^\/transcode\/sessions\/([\w-]{1,100})$/.exec(String(ts?.key ?? ''));
  return m?.[1];
}

/**
 * Plex has no transcode reasons in /status/sessions; derived from the decisions: burnt-in subtitles -> 'subtitles',
 * converted video -> 'other', converted audio only -> 'audioCodec' (as reason.ts does for an audio conversion).
 */
export function plexSessionReasons(ts: Record<string, any> | undefined): TranscodeReason[] {
  if (!ts) return [];
  const out: TranscodeReason[] = [];
  if (lc(ts.subtitleDecision) === 'burn') out.push('subtitles');
  if (asDecision(ts.videoDecision) === 'transcode') out.push('other');
  else if (asDecision(ts.audioDecision) === 'transcode') out.push('audioCodec');
  return out;
}

/**
 * One `/status/sessions` entry -> ServerSession, or null when it plays nothing we can name. FriendFlix's own transcodes run with
 * X-Plex-Client-Identifier = play session id and product FriendFlix: they get `deviceId: 'ff-<session>'` and that play session id,
 * so the admin's active streams match them to the portal's own entries. `identityOf` names the FriendFlix identity of such a session.
 */
export function toPlexServerSession(raw: Record<string, any>, identityOf: (session: string) => string | undefined = () => undefined): ServerSession | null {
  const rk = String(raw?.ratingKey ?? '');
  if (!RK.test(rk)) return null;
  const player = (raw.Player ?? {}) as Record<string, any>;
  const ts = (Array.isArray(raw.TranscodeSession) ? raw.TranscodeSession[0] : raw.TranscodeSession) as Record<string, any> | undefined;
  const machine = str(player.machineIdentifier, 200);
  const tid = transcodeId(ts);
  const ffSession = [tid, machine].find((s): s is string => Boolean(s && SESSION_RE.test(s)));
  const ours = Boolean(ffSession) && (str(player.product, 80) === 'FriendFlix' || Boolean(ffSession && identityOf(ffSession)));
  const video = asDecision(ts?.videoDecision), audio = asDecision(ts?.audioDecision);
  const playMethod: ServerSession['playMethod'] = !ts ? 'DirectPlay' : video === 'transcode' || audio === 'transcode' || lc(ts.subtitleDecision) === 'burn' ? 'Transcode' : 'DirectStream';
  const media = Array.isArray(raw.Media) ? ((raw.Media.find((m: any) => truthy(m?.selected)) ?? raw.Media[0]) as Record<string, any> | undefined) : undefined;
  const duration = num(raw.duration), offset = num(raw.viewOffset);
  const hwFlags = [ts?.transcodeHwDecoding, ts?.transcodeHwEncoding].map((v) => lc(v)).filter((v) => v && v !== 'none');
  const kbps = num(raw.Session?.bandwidth) ?? num(media?.bitrate);
  const user = (raw.User ?? {}) as Record<string, any>;
  return dropUndef({
    sessionId: String(str(raw.Session?.id, 100) ?? str(raw.sessionKey, 40) ?? tid ?? rk),
    serverUserId: ours && ffSession ? (identityOf(ffSession) ?? '') : `plex-account-${String(num(user.id) ?? '')}`,
    deviceId: ours && ffSession ? `ff-${ffSession}` : machine,
    client: ours ? undefined : str(player.product, 80),
    deviceName: ours ? undefined : str(player.title, 80),
    item: dropUndef({ id: encodePlexId('item', rk), name: String(str(raw.title, 300) ?? ''), seriesName: str(raw.grandparentTitle, 300), type: itemType(raw.type) }),
    playSessionId: ours ? ffSession : undefined,
    playMethod,
    reasons: playMethod === 'Transcode' ? plexSessionReasons(ts) : [],
    videoCodec: lc(ts?.videoCodec) ?? lc(media?.videoCodec),
    audioCodec: lc(ts?.audioCodec) ?? lc(media?.audioCodec),
    hardware: ts ? hwFlags.length > 0 || truthy(ts.transcodeHwFullPipeline) : undefined,
    bitrate: kbps !== undefined ? Math.round(kbps * 1000) : undefined,
    // playback position, not TranscodeSession.progress (how far ahead the transcoder is)
    progressPct: duration && offset !== undefined ? Math.max(0, Math.min(100, Math.round((offset / duration) * 100))) : undefined,
    paused: lc(player.state) === 'paused',
  });
}

/** Every session of `/status/sessions` (FriendFlix's own included), mapped. */
export async function plexServerSessions(client: Pick<PlexClient, 'container'>, identityOf?: (session: string) => string | undefined): Promise<ServerSession[]> {
  const c = await client.container('/status/sessions');
  const list = Array.isArray(c.Metadata) ? c.Metadata : [];
  return list.flatMap((m) => {
    const s = toPlexServerSession(m, identityOf);
    return s ? [s] : [];
  });
}

// ---------------------------------------------------------------- library hygiene

/** Plex listing type number and section type per hygiene type. */
export const HYGIENE_TYPES = { Movie: { section: 'movie', type: 1 }, Series: { section: 'show', type: 2 }, Episode: { section: 'show', type: 4 } } as const;

const TEXT_SUBS = new Set(['srt', 'subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'vtt', 'smi', 'sami', 'text', 'tx3g', 'ttml']);
const HDR_TRC = new Set(['smpte2084', 'arib-std-b67']);

function hygieneStream(s: Record<string, any>, kind: 'video' | 'audio' | 'subtitle'): HygieneStream {
  const codec = lc(s.codec);
  if (kind === 'video') {
    const trc = lc(s.colorTrc);
    const hdr = truthy(s.DOVIPresent) || (trc ? HDR_TRC.has(trc) : false);
    return dropUndef({ codec, bitDepth: num(s.bitDepth), height: num(s.height), hdr: trc || s.DOVIPresent !== undefined ? hdr : undefined });
  }
  const lang = lc(s.languageCode, 20);
  if (kind === 'audio') return dropUndef({ codec, lang, channels: num(s.channels) });
  return dropUndef({ codec, lang, forced: truthy(s.forced), text: codec ? TEXT_SUBS.has(codec) : false });
}

/** One Plex `Media` (a version) -> HygieneSource; streams of its first part (listings have none: then all lists are empty). */
export function plexHygieneSource(md: Record<string, any>): HygieneSource {
  const parts: Array<Record<string, any>> = Array.isArray(md?.Part) ? md.Part : [];
  const streams: Array<Record<string, any>> = Array.isArray(parts[0]?.Stream) ? parts[0]!.Stream : [];
  const of = (t: number, k: 'video' | 'audio' | 'subtitle') => streams.filter((s) => Number(s?.streamType) === t).map((s) => hygieneStream(s, k));
  const sizes = parts.map((p) => num(p.size)).filter((n): n is number => n !== undefined);
  const kbps = num(md?.bitrate);
  return dropUndef({
    container: lc(md?.container), bitrate: kbps !== undefined ? Math.round(kbps * 1000) : undefined,
    sizeBytes: sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined, runtimeTicks: ticks(md?.duration),
    video: of(1, 'video'), audio: of(2, 'audio'), subtitles: of(3, 'subtitle'),
  });
}

/**
 * A listing entry (`/library/sections/<id>/all?includeGuids=1`) -> HygieneFacts. `detailMedia` = the mirror's Media of the item
 * (with streams); without it the listing's own Media is used (no streams). Paths (Part.file) are never read.
 */
export function toPlexHygieneFacts(m: Record<string, any>, type: HygieneFacts['type'], detailMedia?: Array<Record<string, any>> | null): HygieneFacts {
  const rk = String(m.ratingKey);
  const avail = typeof m.originallyAvailableAt === 'string' ? Number(m.originallyAvailableAt.slice(0, 4)) : NaN;
  const year = num(m.year) ?? (Number.isFinite(avail) && avail > 0 ? avail : undefined);
  const media = type === 'Series' ? [] : (detailMedia ?? (Array.isArray(m.Media) ? m.Media : []));
  const series = RK.test(String(m.grandparentRatingKey ?? '')) ? encodePlexId('item', String(m.grandparentRatingKey)) : undefined;
  return dropUndef({
    id: encodePlexId('item', rk), type, name: String(str(m.title, 300) ?? ''),
    seriesId: type === 'Episode' ? series : undefined, seriesName: type === 'Episode' ? str(m.grandparentTitle, 300) : undefined,
    season: type === 'Episode' ? num(m.parentIndex) : undefined, episode: type === 'Episode' ? num(m.index) : undefined, year,
    overview: typeof m.summary === 'string' && m.summary.trim().length > 0,
    poster: Boolean(str(m.thumb, 500)),
    backdrop: Boolean(str(m.art, 500)),
    providerIds: providerIdsOf(guidsOf(m)),
    runtimeTicks: ticks(m.duration),
    virtual: false, // Plex lists only items with files (no "missing episode" placeholders)
    sources: media.map(plexHygieneSource),
  });
}

/** Plex filter for "changed at or after" (`updatedAt>>=<epoch s>`); '' without a valid date. */
export function updatedSince(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `&${encodeURIComponent('updatedAt>>')}=${Math.max(0, Math.floor(t / 1000))}` : '';
}

/**
 * One page of the library's listing entries of a type across all sections of the fitting kind (section key order, Plex's listing
 * order inside a section). The window [start, start + limit) is laid over the sections by their totalSize (one count request each).
 */
export async function plexHygienePage(client: Pick<PlexClient, 'container' | 'sections'>, type: HygieneFacts['type'], page: { start: number; limit: number; savedSince?: string }): Promise<Array<Record<string, any>>> {
  const t = HYGIENE_TYPES[type];
  const sections = (await client.sections())
    .filter((s) => s?.type === t.section && RK.test(String(s.key ?? '')))
    .sort((a, b) => Number(a.key) - Number(b.key));
  let skip = Math.max(0, Math.floor(page.start));
  let need = Math.max(0, Math.floor(page.limit));
  const out: Array<Record<string, any>> = [];
  for (const s of sections) {
    if (need <= 0) break;
    const base = `/library/sections/${s.key}/all?type=${t.type}&includeGuids=1${updatedSince(page.savedSince)}`;
    const count: PlexContainer = await client.container(`${base}&X-Plex-Container-Start=0&X-Plex-Container-Size=0`);
    const total = num(count.totalSize);
    if (total === undefined) throw new PlexError(502, 'Plex: listing without totalSize');
    if (skip >= total) {
      skip -= total;
      continue;
    }
    const c = await client.container(`${base}&X-Plex-Container-Start=${skip}&X-Plex-Container-Size=${need}`);
    const list = (c.Metadata ?? []).filter((m) => RK.test(String(m?.ratingKey ?? '')));
    out.push(...list.slice(0, need));
    need -= Math.min(list.length, need);
    skip = 0;
  }
  return out;
}
